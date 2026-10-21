"""Audio capture and playback for Juana client.

Architecture:
  - PortAudio callback: ABSOLUTELY MINIMAL. Only copy bytes into queue.
  - Consumer thread: reads from queue, buffers audio for STT.
  - No Python logic runs inside the PortAudio callback thread.
  - Thread-safe: callback only touches primitives and Queue.
  - Object IDs track lifecycle to detect use-after-close.

Device selection:
  - Name-based preference (persisted in device_preferences.json).
  - Filter out virtual/loopback/blacklisted devices.
  - RMS validation window before accepting a device.
  - Fallback only if device is completely silent AND another candidate exists.
"""

import collections
import ctypes
import json
import os
import pyaudio
import numpy as np
import threading
import queue
import time
import uuid
from typing import Optional, Callable


# Device preference persistence file.
# Se guarda junto a settings.json (APOLLO_CONFIG_DIR, p.ej. %APPDATA%/com.apollo.desktop)
# para que sobreviva a reinstalaciones: resources/ se reemplaza en cada update.
# Sin APOLLO_CONFIG_DIR (dev), cae al directorio del paquete (legado, se migra solo).
_PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
_LEGACY_PREFERENCES_FILE = os.path.join(_PACKAGE_DIR, "device_preferences.json")


def _resolve_preferences_file(config_dir: str = "") -> str:
    config_dir = (config_dir or os.getenv("APOLLO_CONFIG_DIR", "")).strip().strip('"')
    if config_dir:
        try:
            os.makedirs(config_dir, exist_ok=True)
        except Exception:
            pass
        return os.path.join(config_dir, "device_preferences.json")
    return _LEGACY_PREFERENCES_FILE


DEVICE_PREFERENCES_FILE = _resolve_preferences_file()

# RMS validation constants (for fallback logic)
DEVICE_VALIDATION_WINDOW = 5.0  # seconds to wait before considering fallback
DEVICE_SILENCE_THRESHOLD = 0.0001  # RMS below this = "completely silent"
DEVICE_MAX_VALIDATION_ATTEMPTS = 3  # max fallback attempts before giving up


def _vlog(msg: str) -> None:
    try:
        print(f"[voice-debug] {msg}", flush=True)
    except OSError:
        pass


def _load_device_preferences() -> dict:
    """Load persisted device preferences from JSON file.

    Lee APOLLO_CONFIG_DIR primero; si no existe ahi pero si en la ubicacion
    legada (paquete), la migra automaticamente.
    """
    try:
        primary = _resolve_preferences_file()
        if os.path.exists(primary):
            with open(primary, "r", encoding="utf-8") as f:
                return json.load(f)
        if primary != _LEGACY_PREFERENCES_FILE and os.path.exists(_LEGACY_PREFERENCES_FILE):
            try:
                with open(_LEGACY_PREFERENCES_FILE, "r", encoding="utf-8") as f:
                    legacy = json.load(f)
                if isinstance(legacy, dict) and legacy:
                    with open(primary, "w", encoding="utf-8") as f:
                        json.dump(legacy, f, indent=2, ensure_ascii=False)
                    return legacy
            except Exception:
                pass
    except Exception:
        pass
    return {}


def _save_device_preferences(prefs: dict) -> None:
    """Persist device preferences to JSON file (resuelto en cada llamada)."""
    try:
        with open(_resolve_preferences_file(), "w", encoding="utf-8") as f:
            json.dump(prefs, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


def persist_device_preference(device_type: str, device_name: str, device_index: int) -> None:
    """Persist a validated device preference.

    Args:
        device_type: "input" or "output"
        device_name: The actual device name from PortAudio
        device_index: The actual device index from PortAudio
    """
    prefs = _load_device_preferences()
    key = f"{device_type}_device_name"
    prefs[key] = device_name
    prefs[f"{device_type}_device_index"] = device_index
    prefs[f"{device_type}_last_validated"] = time.time()
    _save_device_preferences(prefs)


def load_device_preference(device_type: str) -> dict:
    """Load persisted device preference.

    Returns dict with 'name', 'index', 'timestamp' keys or empty dict.
    """
    prefs = _load_device_preferences()
    name = prefs.get(f"{device_type}_device_name", "")
    idx = prefs.get(f"{device_type}_device_index", -1)
    ts = prefs.get(f"{device_type}_last_validated", 0.0)
    if name and idx >= 0:
        return {"name": name, "index": idx, "timestamp": ts}
    return {}


def get_preferred_device_name(device_type: str, default_name: str) -> str:
    """Get the preferred device name, checking persisted preferences first."""
    prefs = load_device_preference(device_type)
    if prefs.get("name"):
        return prefs["name"]
    return default_name


_SIGNAL_HISTORY_KEY = "input_signal_history"
# Techos de cordura para la sonda: por encima hay clipping/basura digital,
# no voz (verificado: DirectSound del JBL en sala silenciosa da pico 32765
# + RMS 0.43 con tono en fs/4; voz realista no clava fondo de escala).
_PROBE_GARBAGE_PEAK = 32000
_PROBE_GARBAGE_RMS = 0.30
# Piso de silencio de la sonda: por debajo no hay energia acustica real
# (idle del ADC ~0.000015), solo ruido de cuantizacion. Se cuantiza a 0
# para que el desempate entre duplicados silenciosos sea determinista
# (orden por escore) y no dependa de micro-diferencias de float.
_PROBE_SILENCE_FLOOR = 0.0002


def _signal_history_key(norm_name: str, host_api: int) -> str:
    return f"{norm_name}|host{host_api}"


def note_input_signal_quality(norm_name: str, host_api: int, speech_rms: float) -> None:
    """Memoria de senal por endpoint (nombre normalizado + hostApi, no indice).

    Guarda el mejor speech_rms observado con voz real. Sin PII: solo energia.
    En el proximo arranque, entre duplicados con el mismo nombre se prefiere
    el endpoint con mejor historial (aprende que WASAPI entrega y MME no).
    """
    try:
        if speech_rms <= 0:
            return
        prefs = _load_device_preferences()
        history = prefs.get(_SIGNAL_HISTORY_KEY)
        if not isinstance(history, dict):
            history = {}
        key = _signal_history_key(norm_name, host_api)
        entry = history.get(key)
        if not isinstance(entry, dict):
            entry = {}
        best = float(entry.get("speech_rms", 0.0) or 0.0)
        turns = int(entry.get("turns", 0) or 0)
        history[key] = {
            "speech_rms": max(best, float(speech_rms)),
            "turns": min(turns + 1, 9999),
        }
        prefs[_SIGNAL_HISTORY_KEY] = history
        _save_device_preferences(prefs)
        print(
            f"[voice-debug] input-signal-history key={key} "
            f"speech_rms={speech_rms:.4f} best={history[key]['speech_rms']:.4f} "
            f"turns={history[key]['turns']}",
            flush=True,
        )
    except Exception:
        pass


def describe_input_endpoint(audio: pyaudio.PyAudio, index: int) -> tuple[str, int]:
    """Devuelve (nombre normalizado, hostApi) de un indice, o ('', -1)."""
    try:
        info = audio.get_device_info_by_index(index)
        return str(info.get("name", "")).strip().lower(), int(info.get("hostApi", -1))
    except Exception:
        return "", -1


# --- Auto-calibracion de entrada (arranque) ---
# Mide el noise floor CRUDO del endpoint elegido (~2 s), guarda stats por
# endpoint (nombre+hostApi) y deriva: techo dinamico de ganancia + ganancia
# inicial + semilla del gate adaptativo. Calibrado en campo (3 capturas
# 48 kHz): floor estable 1.5e-5, habla p50 0.006 / p90 0.03, sin clipping
# en origen. Si el floor es bajisimo, ganancias altas son seguras (el
# limite es clipping, no hiss): max_gain = min(32, 0.003/floor).
_CALIBRATION_KEY = "input_calibration"
CALIBRATION_MAX_AGE_S = 7 * 24 * 3600
STT_AUTO_CALIBRATE = os.getenv("STT_AUTO_CALIBRATE", "1") == "1"
try:
    STT_CALIBRATE_SECONDS = float(os.getenv("STT_CALIBRATE_SECONDS", "2.0"))
except ValueError:
    STT_CALIBRATE_SECONDS = 2.0
try:
    STT_TARGET_PEAK = float(os.getenv("STT_TARGET_PEAK", "0.3"))
except ValueError:
    STT_TARGET_PEAK = 0.3
try:
    STT_TARGET_RMS = float(os.getenv("STT_TARGET_RMS", "0.06"))
except ValueError:
    STT_TARGET_RMS = 0.06
# Prior de rango de habla cuando el endpoint no tiene historial (medido en
# campo sobre el JBL; solo energia, se refina con turnos reales).
_SPEECH_PRIOR_P50 = 0.006
_SPEECH_PRIOR_MAX = 0.3


def _calibration_key(norm_name: str, host_api: int) -> str:
    return f"{norm_name}|host{host_api}"


def load_input_calibration() -> dict:
    try:
        cal = _load_device_preferences().get(_CALIBRATION_KEY)
        return cal if isinstance(cal, dict) else {}
    except Exception:
        return {}


def measure_raw_noise_floor(
    audio: pyaudio.PyAudio,
    index: int,
    rate: int,
    channels: int,
    seconds: float = 2.0,
) -> dict:
    """Mide el piso de ruido CRUDO (pre-gain) de un endpoint.

    Lee ~seconds (minimo 0.3 s o 30 ventanas validas, para no quemar tiempo
    en mocks/tests) y devuelve {noise_floor, peak, windows}. Ante cualquier
    fallo o datos ilegibles aborta rapido con defaults (nunca levanta).
    """
    result = {"noise_floor": 0.00002, "peak": 0.0, "windows": 0, "measured": False}
    stream = None
    try:
        stream = audio.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=rate,
            input=True,
            frames_per_buffer=1024,
            input_device_index=index,
        )
        import numpy as _np
        rms_values = []
        peak = 0
        bad_streak = 0
        deadline = time.monotonic() + max(0.6, seconds)
        started = time.monotonic()
        while time.monotonic() < deadline:
            try:
                data = stream.read(1024, exception_on_overflow=False)
            except Exception:
                break
            if not isinstance(data, (bytes, bytearray)) or len(data) < 4:
                bad_streak += 1
                if bad_streak > 50:
                    break
                continue
            bad_streak = 0
            try:
                samples = _np.frombuffer(data, dtype=_np.int16).astype(_np.float32)
                peak = max(peak, int(abs(samples).max()))
                rms_values.append(float((_np.mean((samples / 32768.0) ** 2)) ** 0.5))
            except Exception:
                continue
            if len(rms_values) >= 30 and time.monotonic() - started > 0.5:
                break
        if rms_values:
            ordered = sorted(rms_values)
            floor = float(np.median(ordered[: max(1, len(ordered) // 4)]))
            result = {
                "noise_floor": max(floor, 1e-7),
                "peak": peak,
                "windows": len(rms_values),
                "measured": True,
            }
    except Exception:
        pass
    finally:
        if stream is not None:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
    return result


def note_input_speech_stats(
    norm_name: str, host_api: int, speech_p50: float, speech_max: float
) -> None:
    """Refina el rango de habla real por endpoint (p50/max de voz Post-gain).

    Sin PII: solo energia agregada del turno. Junto a la calibracion,
    permite estimar el speech range real sin adivinar.
    """
    try:
        if speech_p50 <= 0:
            return
        prefs = _load_device_preferences()
        cal = prefs.get(_CALIBRATION_KEY)
        if not isinstance(cal, dict):
            cal = {}
        key = _calibration_key(norm_name, host_api)
        entry = cal.get(key)
        if not isinstance(entry, dict):
            entry = {}
        prev_p50 = float(entry.get("speech_p50", 0.0) or 0.0)
        prev_max = float(entry.get("speech_max", 0.0) or 0.0)
        turns = int(entry.get("speech_turns", 0) or 0)
        # Media movil para p50 (estable), max historico para el techo.
        entry["speech_p50"] = prev_p50 + (float(speech_p50) - prev_p50) * (1.0 / min(turns + 1, 10))
        entry["speech_max"] = max(prev_max, float(speech_max))
        entry["speech_turns"] = min(turns + 1, 9999)
        cal[key] = entry
        prefs[_CALIBRATION_KEY] = cal
        _save_device_preferences(prefs)
    except Exception:
        pass


def calibrate_input_endpoint(
    audio: pyaudio.PyAudio,
    index: int,
    norm_name: str,
    host_api: int,
    rate: int,
    channels: int,
    force: bool = False,
) -> dict:
    """Calibracion de arranque para un endpoint: floor + ganancias + semilla.

    Reutiliza la entrada si es fresca (<7 dias); si no, mide ~2 s y deriva:
    - max_gain dinamico = min(32, 0.003/floor) [techo por headroom de ruido]
    - init_gain = clamp(target_rms/max(p50_prior, floor*6), 1, max_gain)
    - gate_seed post-gain = max(floor*init_gain, 1e-6)
    Devuelve siempre un dict utilizable (defaults seguros si algo falla).
    """
    safe = {"noise_floor": 0.00002, "max_gain": 12.0, "init_gain": 8.0,
            "gate_seed": 0.00016, "measured": False, "cached": False}
    try:
        key = _calibration_key(norm_name, host_api)
        stored = load_input_calibration().get(key)
        if isinstance(stored, dict) and not force:
            age = time.time() - float(stored.get("measured_at", 0) or 0)
            if age < CALIBRATION_MAX_AGE_S and stored.get("noise_floor"):
                safe.update(stored)
                safe["cached"] = True
                print(
                    f"[voice-debug] input-calibrated-cached key={key} "
                    f"floor={safe['noise_floor']:.6f} max_gain={safe['max_gain']:.1f} "
                    f"init_gain={safe['init_gain']:.1f}",
                    flush=True,
                )
                return safe
        meas = measure_raw_noise_floor(audio, index, rate, channels, STT_CALIBRATE_SECONDS)
        floor = float(meas.get("noise_floor", 0.00002))
        prior_p50 = _SPEECH_PRIOR_P50
        if isinstance(stored, dict):
            prior_p50 = float(stored.get("speech_p50", 0.0) or 0.0) or _SPEECH_PRIOR_P50
        max_gain = min(32.0, 0.003 / max(floor, 1e-6))
        init_gain = STT_TARGET_RMS / max(prior_p50, floor * 6.0)
        init_gain = min(max(init_gain, 1.0), max_gain)
        entry = {
            "noise_floor": floor,
            "max_gain": max_gain,
            "init_gain": init_gain,
            "gate_seed": max(floor * init_gain, 1e-6),
            "measured_at": time.time(),
            "measured": bool(meas.get("measured")),
            "speech_p50": prior_p50,
            "speech_max": float((stored or {}).get("speech_max", 0.0) or 0.0) if isinstance(stored, dict) else 0.0,
            "speech_turns": int((stored or {}).get("speech_turns", 0) or 0) if isinstance(stored, dict) else 0,
        }
        prefs = _load_device_preferences()
        cal = prefs.get(_CALIBRATION_KEY)
        if not isinstance(cal, dict):
            cal = {}
        cal[key] = entry
        prefs[_CALIBRATION_KEY] = cal
        _save_device_preferences(prefs)
        safe.update(entry)
        print(
            f"[voice-debug] input-calibrated key={key} floor={floor:.6f} "
            f"max_gain={max_gain:.1f} init_gain={init_gain:.1f} "
            f"win={meas.get('windows', 0)}",
            flush=True,
        )
    except Exception as e:
        print(f"[voice-debug] input-calibrate-error err={e}", flush=True)
    return safe


def find_device_by_name(
    audio: pyaudio.PyAudio,
    name_substring: str,
    is_input: bool = True,
) -> list[dict]:
    """Find all devices whose name contains the given substring.

    Returns list of matching device dicts, sorted by relevance.
    """
    matches = []
    name_lower = name_substring.strip().lower()
    count = audio.get_device_count()
    ignored = IGNORED_INPUT_KEYWORDS if is_input else IGNORED_OUTPUT_KEYWORDS

    for i in range(count):
        try:
            info = audio.get_device_info_by_index(i)
        except Exception:
            continue
        name = info.get('name', '')
        name_lower_dev = name.lower()
        if name_lower in name_lower_dev or name_lower_dev in name_lower:
            if is_device_ignored(name, ignored):
                continue
            max_ch = info.get('maxInputChannels', 0) if is_input else info.get('maxOutputChannels', 0)
            if max_ch <= 0:
                continue
            matches.append({
                'index': i,
                'name': name,
                'channels': max_ch,
                'hostApi': info.get('hostApi', 0),
                'defaultRate': int(info.get('defaultSampleRate', 0)),
            })
    return matches


def score_probe_for_selection(
    probe: dict,
    history_rms: float = 0.0,
    base_score: float = 0.0,
) -> tuple[tuple, str]:
    """Orden total entre endpoints duplicados (mismo nombre).

    Clave (mayor = mejor): (sano, historial_voz, nivel_util, escore_base).
    - Basura digital (pico >= 32000 o RMS > 0.30: clipping/tono/DC) va al
      fondo con razon explicita. El DC offset alto acompana a la basura
      (caso DirectSound: DC 2600 + fs/4 a fondo de escala).
    - Silencio (RMS < piso) cuantiza a 0: el desempate en silencio es por
      historial y luego determinista, no por micro-diferencias de float.
    - El historial (voz real observada) pesa mas que la sonda instantanea.
    Pura y testeable: no abre dispositivos.
    """
    try:
        peak = int(probe.get("peak", 0) or 0)
    except Exception:
        peak = 0
    try:
        rms = float(probe.get("rms_max", 0.0) or 0.0)
    except Exception:
        rms = 0.0
    try:
        dc = abs(float(probe.get("dc_offset", 0.0) or 0.0))
    except Exception:
        dc = 0.0
    if peak >= _PROBE_GARBAGE_PEAK or rms > _PROBE_GARBAGE_RMS:
        return ((-1, 0.0, 0.0, 0.0), f"garbage:peak={peak},rms={rms:.3f},dc={dc:.0f}")
    try:
        hist = float(history_rms or 0.0)
    except Exception:
        hist = 0.0
    level = rms if rms >= _PROBE_SILENCE_FLOOR else 0.0
    reason = "history" if hist > 0 else ("signal" if level > 0 else "score-order")
    return ((1, hist, level, float(base_score)), reason)


def enumerate_output_devices(audio: Optional[pyaudio.PyAudio] = None) -> None:
    a = audio or pyaudio.PyAudio()
    count = a.get_device_count()
    print("[voice-debug] output-device-list count=" + str(count), flush=True)
    for i in range(count):
        info = a.get_device_info_by_index(i)
        name = info.get('name', '?')
        is_input = bool(info.get('maxInputChannels', 0) > 0)
        is_output = bool(info.get('maxOutputChannels', 0) > 0)
        print(
            "[voice-debug] output-device index=" + str(i) +
            " name=\"" + name + "\"" +
            " isInput=" + str(is_input) +
            " isOutput=" + str(is_output),
            flush=True,
        )
    if audio is None:
        try:
            a.terminate()
        except Exception:
            pass


def enumerate_input_devices(audio: Optional[pyaudio.PyAudio] = None) -> None:
    a = audio or pyaudio.PyAudio()
    count = a.get_device_count()
    print("[voice-debug] input-device-list count=" + str(count), flush=True)
    for i in range(count):
        info = a.get_device_info_by_index(i)
        name = info.get('name', '?')
        is_input = bool(info.get('maxInputChannels', 0) > 0)
        is_output = bool(info.get('maxOutputChannels', 0) > 0)
        print(
            "[voice-debug] input-device index=" + str(i) +
            " name=\"" + name + "\"" +
            " isInput=" + str(is_input) +
            " isOutput=" + str(is_output),
            flush=True,
        )
    if audio is None:
        try:
            a.terminate()
        except Exception:
            pass


def find_default_output_device(audio: Optional[pyaudio.PyAudio] = None) -> int:
    a = audio or pyaudio.PyAudio()
    default_idx = a.get_default_output_device_info()
    if default_idx is not None:
        return int(default_idx['index'])
    return -1


def find_default_input_device(audio: Optional[pyaudio.PyAudio] = None) -> int:
    a = audio or pyaudio.PyAudio()
    default_idx = a.get_default_input_device_info()
    if default_idx is not None:
        return int(default_idx['index'])
    return -1


IGNORED_INPUT_KEYWORDS = [
    "virtual mic",
    "audiorelay",
    "wave",
    "stereo mix",
    "mezcla estéreo",
    "mezcla estereo",
    "línea de entrada",
    "linea de entrada",
    "line in",
    "controlador primario",
    "primary sound",
    "asignador de sonido",
    "sound mapper",
    "steam streaming",
]

IGNORED_OUTPUT_KEYWORDS = [
    "virtual mic",
    "audiorelay",
    "wave",
    "stereo mix",
    "mezcla estéreo",
    "mezcla estereo",
    "controlador primario",
    "primary sound",
    "asignador de sonido",
    "sound mapper",
    "steam streaming",
]

# Bonus para hardware fisico conocido cuando no hay preferencia JBL.
# Evita que un virtual no-listado le gane a la placa onboard.
PHYSICAL_BONUS_KEYWORDS = [
    "realtek",
]


def is_device_ignored(name: str, ignored_keywords: list[str]) -> bool:
    name_lower = name.lower()
    return any(kw in name_lower for kw in ignored_keywords)


# Ganancia en captura STT (opt-out con STT_AUTO_GAIN=0).
# Modo default "agc": AGC lento con memoria (ataque rapido, release lento).
# "fixed" = ganancia fija (satura si el hablante esta cerca); "auto" =
# normalizacion por chunk (bombea ruido). Medido en campo ambos fallan.
STT_AUTO_GAIN = os.getenv("STT_AUTO_GAIN", "1") == "1"
STT_GAIN_MODE = os.getenv("STT_GAIN_MODE", "agc")
try:
    STT_FIXED_GAIN = float(os.getenv("STT_FIXED_GAIN", "8.0"))
except ValueError:
    STT_FIXED_GAIN = 8.0


def apply_fixed_gain(pcm_data: bytes, gain: float = 8.0) -> bytes:
    """Ganancia fija con clip: preserva dinamica relativa entre chunks."""
    if not pcm_data or gain == 1.0:
        return pcm_data
    try:
        samples = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32)
        amplified = np.clip(samples * gain, -32768, 32767).astype(np.int16)
        return amplified.tobytes()
    except Exception:
        return pcm_data


def apply_stt_gain(pcm_data: bytes) -> bytes:
    """Ganancia del path STT segun STT_GAIN_MODE (fixed por defecto)."""
    if not STT_AUTO_GAIN:
        return pcm_data
    if STT_GAIN_MODE == "auto":
        return apply_auto_gain(pcm_data)
    return apply_fixed_gain(pcm_data, STT_FIXED_GAIN)


class StreamingAgc:
    """AGC lento para STT en streaming (con memoria entre chunks).

    Sin normalizacion instantanea por chunk (eso bombeaba ruido y destruia
    dinamica). Persigue pico objetivo configurable (STT_TARGET_PEAK, 0.3)
    con ataque rapido (baja en ~130 ms ante voz fuerte) y release lento
    (sube en ~1-2 s, sin respiracion). Los chunks silenciosos congelan la
    ganancia (no persigue el piso de ruido). Compresion suave sobre 0.7
    (3:1) + clip duro en 0.99: jamas entrega clipping digital aunque el
    ataque llegue tarde. Techo dinamico: min(32, 0.003/noise_floor) — con
    floors bajisimos medidos (1.5e-5) el boost puede superar x12 con
    seguridad porque el hiss amplificado sigue 40 dB bajo la voz.
    """

    def __init__(
        self,
        target_peak: float = 0.3,
        max_gain: float = 12.0,
        init_gain: float = 8.0,
        attack: float = 0.3,
        release: float = 0.02,
        silence_peak: float = 0.001,
        noise_floor: Optional[float] = None,
        highpass_hz: float = 120.0,
        sample_rate_hz: float = 16000.0,
    ):
        self.target_peak = target_peak
        self.attack = attack
        self.release = release
        self.silence_peak = silence_peak
        if noise_floor is not None and noise_floor > 0:
            # Techo por headroom de ruido: el hiss amplificado no debe pasar
            # 0.003 post-gain. Nunca absurdo: capado en 32.
            self.max_gain = min(32.0, 0.003 / max(noise_floor, 1e-6))
        else:
            self.max_gain = max_gain
        self.gain = min(max(init_gain, 1.0), self.max_gain)
        # Pasa-altos de 2 etapas (12 dB/oct): elimina hum de red (76-85 Hz
        # medido) y rumble de proximidad ANTES de medir pico para el AGC.
        # Sin esto, el AGC perseguia el hum y Vosk recibia graves sucios.
        import math as _math
        self._hp_alpha = _math.exp(-2.0 * _math.pi * highpass_hz / sample_rate_hz)
        self._hp1x = 0.0
        self._hp1y = 0.0
        self._hp2x = 0.0
        self._hp2y = 0.0
        # Stats para el health score del turno (ver stats()).
        self.gain_sum = 0.0
        self.gain_count = 0
        self.gain_min = self.gain
        self.gain_max = self.gain
        self.peak_max_post = 0.0
        self.clip_chunks = 0
        self.total_chunks = 0

    def highpass(self, samples: "np.ndarray") -> "np.ndarray":
        """Pasa-altos con memoria entre chunks (llamado antes del AGC)."""
        out = np.empty_like(samples)
        a = self._hp_alpha
        x1, y1, x2, y2 = self._hp1x, self._hp1y, self._hp2x, self._hp2y
        for i, x in enumerate(samples):
            y1 = a * (y1 + x - x1)
            x1 = x
            y2 = a * (y2 + y1 - x2)
            x2 = y1
            out[i] = y2
        self._hp1x, self._hp1y, self._hp2x, self._hp2y = x1, y1, x2, y2
        return out

    @staticmethod
    def soft_knee(samples: "np.ndarray", knee: float = 0.7, ratio: float = 3.0) -> "np.ndarray":
        """Compresion suave sobre el codo: 3:1 por encima de 0.7 (puro numpy)."""
        mag = np.abs(samples) / 32768.0
        over = mag > knee
        if not bool(np.any(over)):
            return samples
        compressed = knee + (mag - knee) / ratio
        scale = np.where(over, compressed / np.maximum(mag, 1e-9), 1.0)
        return (samples * scale).astype(np.float32)

    def process(self, pcm_data: bytes) -> bytes:
        if not pcm_data:
            return pcm_data
        try:
            samples = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32)
        except Exception:
            return pcm_data
        samples = self.highpass(samples)
        peak = float(np.abs(samples).max()) / 32768.0 if len(samples) else 0.0
        if peak >= self.silence_peak:
            wanted = self.target_peak / max(peak, 1e-6)
            wanted = min(max(wanted, 1.0), self.max_gain)
            rate = self.attack if wanted < self.gain else self.release
            self.gain += (wanted - self.gain) * rate
        try:
            amplified = samples * self.gain
            amplified = self.soft_knee(amplified)
            clipped = np.clip(amplified, -32768 * 0.99, 32768 * 0.99).astype(np.int16)
            post_peak = float(np.abs(clipped).max()) / 32768.0
            self.total_chunks += 1
            self.gain_sum += self.gain
            self.gain_count += 1
            if self.gain < self.gain_min:
                self.gain_min = self.gain
            if self.gain > self.gain_max:
                self.gain_max = self.gain
            if post_peak > self.peak_max_post:
                self.peak_max_post = post_peak
            if post_peak >= 0.98:
                self.clip_chunks += 1
            return clipped.tobytes()
        except Exception:
            return pcm_data

    def stats(self) -> dict:
        """Stats agregadas para el health score (sin audio, solo numeros)."""
        return {
            "gain_avg": self.gain_sum / self.gain_count if self.gain_count else self.gain,
            "gain_min": self.gain_min,
            "gain_max": self.gain_max,
            "peak_max_post": self.peak_max_post,
            "clip_ratio": self.clip_chunks / self.total_chunks if self.total_chunks else 0.0,
        }


def _try_open_input(
    audio: pyaudio.PyAudio,
    idx: int,
    max_channels: int,
    rates: list[int],
) -> Optional[tuple[int, int]]:
    """Try opening an input stream at the given rates (explicit list, no magic).

    Returns (working_rate, working_channels) or None. Logs every attempt
    with its concrete error so a discarded device leaves a real cause.
    """
    channels_to_try = [1, 2] if max_channels >= 2 else [1]
    for rate in rates:
        for ch in channels_to_try:
            try:
                test_stream = audio.open(
                    format=pyaudio.paInt16,
                    channels=ch,
                    rate=rate,
                    input=True,
                    frames_per_buffer=512,
                    input_device_index=idx,
                )
                test_stream.close()
                print(
                    f"[voice-debug] input-open-ok index={idx} rate={rate} ch={ch}",
                    flush=True,
                )
                return rate, ch
            except Exception as e:
                err_detail = ""
                if isinstance(e, OSError):
                    err_detail = f" errno={getattr(e, 'errno', 'N/A')}"
                print(
                    f"[voice-debug] input-open-fail index={idx} rate={rate} ch={ch} "
                    f"err={type(e).__name__}({str(e)[:120]}){err_detail}",
                    flush=True,
                )
                continue
    return None


def probe_candidate_signal(
    audio: pyaudio.PyAudio,
    idx: int,
    rate: int,
    channels: int,
    duration_ms: float = 500.0,
) -> dict:
    """Abre un candidato, lee ~duration_ms y mide senal real.

    No basta con que PortAudio permita abrir: un endpoint puede abrir y
    entregar silencio... o basura digital (caso real: JBL por DirectSound
    con offset DC + tono en fs/4 a fondo de escala en sala silenciosa).
    Devuelve rms_max/rms_avg/peak/dc_offset/windows. Fallo -> ceros.
    """
    result = {"rms_max": 0.0, "rms_avg": 0.0, "peak": 0, "dc_offset": 0.0, "windows": 0}
    stream = None
    try:
        stream = audio.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=rate,
            input=True,
            frames_per_buffer=1024,
            input_device_index=idx,
        )
        deadline = time.monotonic() + duration_ms / 1000.0
        rms_values = []
        peak = 0
        dc_sum = 0.0
        dc_count = 0
        while time.monotonic() < deadline:
            try:
                data = stream.read(1024, exception_on_overflow=False)
            except Exception:
                break
            if not isinstance(data, (bytes, bytearray)) or len(data) < 4:
                continue
            try:
                import numpy as _np
                samples = _np.frombuffer(data, dtype=_np.int16).astype(_np.float32)
                peak = max(peak, int(abs(samples).max()))
                dc_sum += float(samples.mean())
                dc_count += 1
                rms_values.append(float((_np.mean((samples / 32768.0) ** 2)) ** 0.5))
            except Exception:
                continue
        if rms_values:
            result = {
                "rms_max": max(rms_values),
                "rms_avg": sum(rms_values) / len(rms_values),
                "peak": peak,
                "dc_offset": dc_sum / dc_count if dc_count else 0.0,
                "windows": len(rms_values),
            }
    except Exception:
        pass
    finally:
        if stream is not None:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
    return result


def _try_open_output(
    audio: pyaudio.PyAudio,
    idx: int,
    max_channels: int,
    sample_rate: int,
    default_rate: int,
) -> Optional[tuple[int, int]]:
    """Try opening an output stream. Returns (working_rate, working_channels) or None."""
    rates_to_try = [sample_rate]
    if default_rate and default_rate not in rates_to_try:
        rates_to_try.append(default_rate)
    for r in (48000, 44100, 16000):
        if r not in rates_to_try:
            rates_to_try.append(r)
    channels_to_try = [1, 2] if max_channels >= 2 else [1]
    for r in rates_to_try:
        for ch in channels_to_try:
            try:
                test_stream = audio.open(
                    format=pyaudio.paInt16,
                    channels=ch,
                    rate=r,
                    output=True,
                    frames_per_buffer=512,
                    output_device_index=idx,
                )
                test_stream.close()
                return r, ch
            except Exception as e:
                err_detail = ""
                if isinstance(e, OSError):
                    err_detail = f" errno={getattr(e, 'errno', 'N/A')}"
                print(
                    f"[tts-debug] output-open-fail index={idx} rate={r} ch={ch} "
                    f"err={type(e).__name__}({str(e)[:120]}){err_detail}",
                    flush=True,
                )
                continue
    return None


def resample_mono_pcm(data: bytes, from_rate: int, to_rate: int) -> bytes:
    """Resamplea PCM16 mono entre frecuencias (interpolacion lineal).

    Se usa para abrir el dispositivo a su frecuencia nativa y entregar
    siempre 16 kHz mono a Vosk. Si las tasas coinciden devuelve copia.
    """
    if from_rate == to_rate or len(data) < 2:
        return bytes(data)
    try:
        samples = np.frombuffer(data, dtype=np.int16).astype(np.float32)
        num_samples = len(samples)
        target_num_samples = max(1, int(num_samples * to_rate / from_rate))
        resampled = np.interp(
            np.linspace(0, num_samples, target_num_samples, endpoint=False),
            np.arange(num_samples),
            samples,
        ).astype(np.int16)
        return resampled.tobytes()
    except Exception:
        return bytes(data)


def validate_capture_signal(
    samples: list,
    duration_ms: float,
    rms_threshold: float = 0.02,
) -> dict:
    """Veredicto sobre una ventana de audio capturado.

    samples: lista de tuplas (rms, peak). Distingue:
      - "dead":   todo ceros (dispositivo sin senal util, p.ej. loopback mudo)
      - "silent": hay muestras no nulas pero por debajo del threshold
      - "ok":     hay energia real
      - "unknown": sin muestras
    Nunca declara funcional una entrada permanentemente en cero.
    """
    total = len(samples)
    if total <= 0:
        return {
            "rms_max": 0.0,
            "peak_max": 0.0,
            "nonzero_ratio": 0.0,
            "duration_ms": duration_ms,
            "verdict": "unknown",
        }
    nonzero = sum(1 for rms, _peak in samples if rms > 0.0)
    rms_max = max((rms for rms, _peak in samples), default=0.0)
    peak_max = max((peak for _rms, peak in samples), default=0.0)
    if nonzero == 0:
        verdict = "dead"
    elif rms_max < rms_threshold:
        verdict = "silent"
    else:
        verdict = "ok"
    return {
        "rms_max": rms_max,
        "peak_max": peak_max,
        "nonzero_ratio": nonzero / total,
        "duration_ms": duration_ms,
        "verdict": verdict,
    }


def _score_device_name(name: str, pref_norm: str) -> int:
    """Shared name scoring: preferred > JBL > physical bonus > generic."""
    name_lower = name.lower()
    if pref_norm and pref_norm == name_lower.strip():
        score = 1000
    elif pref_norm and pref_norm in name_lower:
        score = 900
    elif "jbl quantum 300" in name_lower:
        score = 850
    elif "jbl" in name_lower:
        score = 800
    else:
        score = 100
    for kw in PHYSICAL_BONUS_KEYWORDS:
        if kw in name_lower:
            score += 150
            break
    return score


def _second_pass_candidates(
    audio: pyaudio.PyAudio,
    is_input: bool,
    pref_norm: str,
) -> list[dict]:
    """Last-resort enumeration WITHOUT blacklist (virtuals included).

    Only used when no physical device opens. Keeps the pipeline alive with
    a loud fallback log instead of hard-failing. Never persisted.
    """
    out = []
    count = audio.get_device_count()
    for i in range(count):
        try:
            info = audio.get_device_info_by_index(i)
        except Exception:
            continue
        max_ch = info.get('maxInputChannels', 0) if is_input else info.get('maxOutputChannels', 0)
        if max_ch <= 0:
            continue
        name = info.get('name', '')
        out.append({
            'index': i,
            'name': name,
            'channels': max_ch,
            'hostApi': info.get('hostApi', 0),
            'defaultRate': int(info.get('defaultSampleRate', 0)),
            'score': _score_device_name(name, pref_norm),
        })
    out.sort(key=lambda c: c['score'], reverse=True)
    return out


# Cache en memoria de la seleccion de entrada validada (por NOMBRE, nunca por
# indice absoluto: los indices cambian al reiniciar Windows o reconectar HW).
# Evita re-enumerar y re-abrir todos los candidatos en cada restart del wake
# detector mientras el dispositivo elegido siga presente y abriendo.
_input_selection_cache: dict = {}
_input_selection_cache_lock = threading.Lock()


def cache_input_selection(name: str, index: int, rate: int, channels: int) -> None:
    with _input_selection_cache_lock:
        _input_selection_cache.clear()
        _input_selection_cache.update({
            "name": name, "index": index, "rate": rate, "channels": channels,
        })


def clear_input_selection_cache(reason: str = "") -> None:
    with _input_selection_cache_lock:
        _input_selection_cache.clear()
    print(f"[voice-debug] input-selection-cache-cleared reason={reason}", flush=True)


def _verify_cached_input_selection(
    audio: pyaudio.PyAudio,
    rates: list[int],
) -> Optional[tuple[int, str, int, int, list[dict]]]:
    """Reutiliza la seleccion cacheada si el dispositivo (por nombre) sigue
    presente y abre con un unico intento de verificacion. Devuelve la misma
    5-tupla que find_best_input_device, o None si hay que re-escanear."""
    with _input_selection_cache_lock:
        cached = dict(_input_selection_cache)
    if not cached:
        return None
    wanted_name = str(cached.get("name", "")).strip().lower()
    if not wanted_name:
        return None
    current_index = -1
    max_channels = 0
    actual_name = ""
    try:
        for i in range(audio.get_device_count()):
            try:
                info = audio.get_device_info_by_index(i)
            except Exception:
                continue
            if str(info.get("name", "")).strip().lower() == wanted_name:
                current_index = i
                max_channels = info.get("maxInputChannels", 0)
                actual_name = info.get("name", "")
                break
    except Exception as e:
        print(f"[voice-debug] selected-input-device-cached-verify-error err={e}", flush=True)
        return None
    if current_index < 0 or max_channels <= 0:
        print(
            f"[voice-debug] selected-input-device-cached-gone name=\"{cached.get('name')}\"",
            flush=True,
        )
        clear_input_selection_cache("device-gone")
        return None
    verify_rates = list(rates)
    cached_rate = cached.get("rate")
    if cached_rate and cached_rate not in verify_rates:
        verify_rates.insert(0, cached_rate)
    opened = _try_open_input(audio, current_index, max_channels, verify_rates)
    if opened is None:
        print(
            f"[voice-debug] selected-input-device-cached-open-fail name=\"{actual_name}\"",
            flush=True,
        )
        clear_input_selection_cache("open-failed")
        return None
    rate, ch = opened
    print(
        f"[voice-debug] selected-input-device-cached name=\"{actual_name}\" "
        f"index={current_index} rate={rate} ch={ch}",
        flush=True,
    )
    return current_index, actual_name, ch, rate, []


def find_best_input_device(
    audio: pyaudio.PyAudio,
    preferred_name: str = "Micrófono (JBL Quantum 300)",
    sample_rate: int = 16000,
    validate_rms: bool = True,
    sample_rates: Optional[list[int]] = None,
    use_cache: bool = True,
    try_native_rates: bool = False,
) -> tuple[int, str, int, int, list[dict]]:
    """Enumerate and select the best physical input device.

    1. Uses find_device_by_name for name-based filtering.
    2. Ignores blacklisted devices.
    3. Explicitly prefers preferred_name (e.g. 'Micrófono (JBL Quantum 300)').
    4. Tests stream opening at sample_rate; with try_native_rates=True also
       at the device default and standard rates (the caller resamples to
       16 kHz mono for Vosk). Default False = legacy 16 kHz-only behavior.
    5. Does not rely on absolute index or Windows default.
    6. Caches the validated selection by NAME; reuses it while the device
       still exists and still opens (single quick verification open).
    7. Persists chosen PHYSICAL device name to device_preferences.json (never virtual fallback).
    8. Last-resort virtual fallback (loudly logged) if nothing physical opens.
    9. Returns (chosen_index, chosen_name, chosen_channels, working_rate, alternative_candidates).
    """
    pref_norm = preferred_name.strip().lower() if preferred_name else ""
    base_rates = list(sample_rates) if sample_rates else [sample_rate]
    if sample_rate not in base_rates:
        base_rates.insert(0, sample_rate)

    if use_cache:
        cached_hit = _verify_cached_input_selection(audio, base_rates)
        if cached_hit is not None:
            return cached_hit

    name_matches = find_device_by_name(audio, pref_norm, is_input=True) if pref_norm else []

    candidates = []
    count = audio.get_device_count()
    ignored = IGNORED_INPUT_KEYWORDS

    for i in range(count):
        try:
            info = audio.get_device_info_by_index(i)
        except Exception:
            continue
        max_in = info.get('maxInputChannels', 0)
        if max_in <= 0:
            continue
        name = info.get('name', '')
        if is_device_ignored(name, ignored):
            continue

        name_lower = name.lower()
        if pref_norm and pref_norm == name_lower.strip():
            score = 1000
        elif pref_norm and pref_norm in name_lower:
            score = 900
        elif name_matches and any(m['index'] == i for m in name_matches):
            score = 850
        elif "jbl quantum 300" in name_lower:
            score = 850
        elif "jbl" in name_lower:
            score = 800
        else:
            score = 100

        for kw in PHYSICAL_BONUS_KEYWORDS:
            if kw in name_lower:
                score += 150
                break

        print(f"[voice-debug] input-device-candidate index={i} name=\"{name}\" score={score}", flush=True)

        if max_in == 1:
            score += 20
        elif max_in == 2:
            score += 10

        host_api = info.get('hostApi', 0)
        if host_api in (0, 1, 2):
            score += 50

        candidates.append({
            'index': i,
            'name': name,
            'channels': max_in,
            'hostApi': host_api,
            'defaultRate': int(info.get('defaultSampleRate', 0)),
            'score': score,
        })

    candidates.sort(key=lambda c: c['score'], reverse=True)

    valid_candidates = []
    for cand in candidates:
        cand_rates = [sample_rate]
        if try_native_rates:
            for extra_rate in (cand['defaultRate'], 48000, 44100):
                if extra_rate and extra_rate not in cand_rates:
                    cand_rates.append(extra_rate)
        opened = _try_open_input(
            audio, cand['index'], cand['channels'], cand_rates,
        )
        if opened is not None:
            rate, ch = opened
            cand_copy = dict(cand)
            cand_copy['workingChannels'] = ch
            cand_copy['workingRate'] = rate
            valid_candidates.append(cand_copy)
            print(
                f"[voice-debug] input-candidate-verdict index={cand['index']} "
                f"name=\"{cand['name']}\" score={cand['score']} opened=yes rate={rate} ch={ch}",
                flush=True,
            )
        else:
            print(
                f"[voice-debug] input-candidate-verdict index={cand['index']} "
                f"name=\"{cand['name']}\" score={cand['score']} opened=no reason=open-failed",
                flush=True,
            )

    if not valid_candidates:
        print("[voice-debug] no-physical-input-device opens; trying virtual last-resort", flush=True)
        for cand in _second_pass_candidates(audio, True, pref_norm):
            cand_rates = [sample_rate]
            if try_native_rates:
                for extra_rate in (cand['defaultRate'], 48000, 44100):
                    if extra_rate and extra_rate not in cand_rates:
                        cand_rates.append(extra_rate)
            opened = _try_open_input(
                audio, cand['index'], cand['channels'], cand_rates,
            )
            if opened is not None:
                rate, ch = opened
                cand_copy = dict(cand)
                cand_copy['workingChannels'] = ch
                cand_copy['workingRate'] = rate
                cand_copy['fallbackVirtual'] = True
                valid_candidates.append(cand_copy)
                break

    if not valid_candidates:
        print("[voice-debug] no-valid-input-device found (nothing opens at all)", flush=True)
        return -1, "", 1, sample_rate, []

    # Desempate por senal real entre duplicados con el mismo nombre.
    # Abrir no basta: un endpoint puede abrir y entregar silencio... o basura
    # digital (JBL/DirectSound: DC + fs/4 a fondo de escala en sala callada).
    # Orden entre duplicados sanos: historial de voz real > sonda actual >
    # escore. Miembros con basura se excluyen (salvo que TODOS la tengan).
    # Acotado: solo grupos duplicados, solo en cache-miss.
    try:
        _hist = _load_device_preferences().get(_SIGNAL_HISTORY_KEY) or {}
        signal_history = _hist if isinstance(_hist, dict) else {}
    except Exception:
        signal_history = {}
    dup_groups: dict[str, list[dict]] = {}
    for cand in valid_candidates:
        dup_groups.setdefault(str(cand["name"]).strip().lower(), []).append(cand)
    probed = 0
    for norm_name, group in dup_groups.items():
        if len(group) < 2:
            continue
        probed += 1
        for cand in group:
            sig = probe_candidate_signal(
                audio, cand["index"], cand["workingRate"], cand["workingChannels"]
            )
            cand["probe_rms_max"] = sig["rms_max"]
            cand["probe_peak"] = sig["peak"]
            cand["probe_dc"] = sig.get("dc_offset", 0.0)
            hist_rms = float(
                (signal_history.get(_signal_history_key(norm_name, cand["hostApi"])) or {}).get("speech_rms", 0.0) or 0.0
            )
            cand["history_rms"] = hist_rms
            sort_key, reason = score_probe_for_selection(
                sig, hist_rms, cand.get("score", 0)
            )
            cand["probe_sort_key"] = sort_key
            cand["probe_garbage"] = sort_key[0] < 0
            print(
                f"[voice-debug] input-signal-probe index={cand['index']} "
                f"host={cand['hostApi']} rate={cand['workingRate']} "
                f"rms_max={sig['rms_max']:.6f} peak={sig['peak']} "
                f"dc={cand['probe_dc']:.0f} win={sig['windows']} "
                f"garbage={cand['probe_garbage']} history={hist_rms:.4f} "
                f"reason={reason}",
                flush=True,
            )
        healthy = [c for c in group if not c.get("probe_garbage")]
        if healthy and len(healthy) < len(group):
            dropped = [c["index"] for c in group if c.get("probe_garbage")]
            print(
                f"[voice-debug] input-signal-probe-excluded indexes={dropped} "
                "(basura digital: clipping/DC; no voz)",
                flush=True,
            )
            group = healthy
        elif not healthy:
            print(
                "[voice-debug] input-signal-probe WARNING: todos los duplicados "
                "dan basura; se conserva orden por escore",
                flush=True,
            )
        group.sort(key=lambda c: c.get("probe_sort_key", (1, 0.0, 0.0, 0.0)), reverse=True)
        member_idx = {c["index"] for c in group}
        others = [c for c in valid_candidates if c["index"] not in member_idx]
        excluded_idx = {c["index"] for c in dup_groups[norm_name]} - member_idx
        rest = [c for c in others if c["index"] not in excluded_idx]
        trailing = [c for c in valid_candidates if c["index"] in excluded_idx]
        first_pos = min(i for i, c in enumerate(valid_candidates)
                        if c["index"] in member_idx)
        valid_candidates = rest[:first_pos] + group + rest[first_pos:] + trailing
    if probed:
        print(
            f"[voice-debug] input-signal-probe groups={probed} "
            "(desempate por senal real entre duplicados)",
            flush=True,
        )

    chosen = valid_candidates[0]
    alternatives = valid_candidates[1:]

    print(f"[voice-debug] selected-input-device index={chosen['index']}", flush=True)
    print(f"[voice-debug] selected-input-device-name=\"{chosen['name']}\"", flush=True)
    if chosen.get('fallbackVirtual'):
        print(
            f"[voice-debug] selected-input-device-fallback=VIRTUAL name=\"{chosen['name']}\" "
            "(silent likely; connect real hardware)",
            flush=True,
        )
    else:
        persist_device_preference("input", chosen['name'], chosen['index'])
        cache_input_selection(
            chosen['name'], chosen['index'],
            chosen['workingRate'], chosen['workingChannels'],
        )

    return chosen['index'], chosen['name'], chosen['workingChannels'], chosen['workingRate'], alternatives


def find_best_output_device(
    audio: pyaudio.PyAudio,
    preferred_name: str = "JBL Quantum 300",
    sample_rate: int = 24000,
    channels: int = 1,
) -> tuple[int, str, int, int, list[dict]]:
    """Enumerate and select the best physical output device.

    1. Uses find_device_by_name for name-based filtering.
    2. Logs: [tts-debug] output-device-candidate index=... name="..."
    3. Ignores blacklisted and input-only devices.
    4. Prefers JBL Quantum 300 or preferred_name.
    5. Fallback to first valid physical output.
    6. Tests opening stream before returning.
    7. Persists chosen device name to device_preferences.json.
    8. Returns (chosen_index, chosen_name, working_rate, working_channels, alternative_candidates).
    """
    pref_norm = preferred_name.strip().lower() if preferred_name else ""
    name_matches = find_device_by_name(audio, pref_norm, is_input=False) if pref_norm else []

    candidates = []
    count = audio.get_device_count()

    for i in range(count):
        try:
            info = audio.get_device_info_by_index(i)
        except Exception:
            continue
        max_out = info.get('maxOutputChannels', 0)
        if max_out <= 0:
            continue
        name = info.get('name', '')
        if is_device_ignored(name, IGNORED_OUTPUT_KEYWORDS):
            continue

        name_lower = name.lower()
        if pref_norm and pref_norm == name_lower.strip():
            score = 1000
        elif pref_norm and pref_norm in name_lower:
            score = 900
        elif name_matches and any(m['index'] == i for m in name_matches):
            score = 850
        elif "jbl quantum 300" in name_lower:
            score = 850
        elif "jbl" in name_lower:
            score = 800
        else:
            score = 100

        for kw in PHYSICAL_BONUS_KEYWORDS:
            if kw in name_lower:
                score += 150
                break

        print(f"[tts-debug] output-device-candidate index={i} name=\"{name}\" score={score}", flush=True)

        host_api = info.get('hostApi', 0)
        if host_api in (0, 1, 2):
            score += 50

        candidates.append({
            'index': i,
            'name': name,
            'channels': max_out,
            'hostApi': host_api,
            'defaultRate': int(info.get('defaultSampleRate', 0)),
            'score': score,
        })

    candidates.sort(key=lambda c: c['score'], reverse=True)

    valid_candidates = []
    for cand in candidates:
        opened = _try_open_output(
            audio, cand['index'], cand['channels'], sample_rate, cand['defaultRate']
        )
        if opened is not None:
            r, ch = opened
            cand_copy = dict(cand)
            cand_copy['workingRate'] = r
            cand_copy['workingChannels'] = ch
            valid_candidates.append(cand_copy)

    if not valid_candidates:
        print("[tts-debug] no-physical-output-device opens; trying virtual last-resort", flush=True)
        for cand in _second_pass_candidates(audio, False, pref_norm):
            opened = _try_open_output(
                audio, cand['index'], cand['channels'], sample_rate, cand['defaultRate']
            )
            if opened is not None:
                r, ch = opened
                cand_copy = dict(cand)
                cand_copy['workingRate'] = r
                cand_copy['workingChannels'] = ch
                cand_copy['fallbackVirtual'] = True
                valid_candidates.append(cand_copy)
                break

    if not valid_candidates:
        return -1, "", sample_rate, channels, []

    chosen = valid_candidates[0]
    alternatives = valid_candidates[1:]

    print(f"[voice-debug] selected-output-device index={chosen['index']}", flush=True)
    print(f"[voice-debug] selected-output-device-name=\"{chosen['name']}\"", flush=True)
    if chosen.get('fallbackVirtual'):
        print(
            f"[tts-debug] selected-output-device-fallback=VIRTUAL name=\"{chosen['name']}\" "
            "(silent likely; connect real hardware)",
            flush=True,
        )
    else:
        persist_device_preference("output", chosen['name'], chosen['index'])

    return chosen['index'], chosen['name'], chosen['workingRate'], chosen['workingChannels'], alternatives


def find_valid_output_device(
    audio: Optional[pyaudio.PyAudio] = None,
    preferred_index: int = -1,
    preferred_name: str = "JBL Quantum 300",
) -> int:
    a = audio or pyaudio.PyAudio()
    owns_audio = audio is None
    try:
        idx, _, _, _, _ = find_best_output_device(a, preferred_name=preferred_name)
        return idx
    finally:
        if owns_audio:
            try:
                a.terminate()
            except Exception:
                pass


def find_valid_input_device(
    audio: Optional[pyaudio.PyAudio] = None,
    preferred_index: int = -1,
    preferred_name: str = "Micrófono (JBL Quantum 300)",
) -> int:
    a = audio or pyaudio.PyAudio()
    owns_audio = audio is None
    try:
        idx, _, _, _, _ = find_best_input_device(a, preferred_name=preferred_name)
        return idx
    finally:
        if owns_audio:
            try:
                a.terminate()
            except Exception:
                pass


def compute_rms(data: bytes, sample_rate: int = 16000, chunk_ms: int = 100) -> float:
    """Compute RMS level for a chunk of audio bytes."""
    try:
        if len(data) == 0:
            return 0.0
        audio = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        return float(np.sqrt(np.mean(audio ** 2)))
    except Exception:
        return 0.0


class SpeechEndpoint:
    """Deteccion de fin de turno por energia/silencio (VAD liviano).

    Logica pura y determinista, sin reloj de pared: se le alimenta RMS por chunk
    y acumula milisegundos. Pensada para unit tests con secuencias sinteticas.

    - Gate ADAPTATIVO: min(threshold_config, noise_floor * floor_margin),
      acotado a [gate_min, gate_max]. En sala silenciosa el gate BAJA solo
      (floor*margin) y pesca voz debil; en ambiente ruidoso queda en el
      configurado y el corte relativo al pico hace el trabajo. El floor se
      estima en linea (baja rapido, sube lento) y puede sembrarse desde la
      calibracion de arranque. Defecto equivale al 0.012 anterior.
    - El habla arranca cuando rms >= gate durante min_speech_ms SOSTENIDOS
      (tolerancia 120 ms a micro-cortes; fragmentos dispersos no acumulan).
    - El turno termina cuando, habiendo arrancado habla, el silencio continuo
      alcanza silence_ms, o cuando el turno supera max_turn_ms.
    - "Silencio" es relativo al pico del turno: rms por debajo de
      max(gate, speech_peak * relative_drop).
    - update() devuelve True UNA sola vez (end_reason: "silence"|"max_turn").
    """

    def __init__(
        self,
        silence_ms: float = 600.0,
        min_speech_ms: float = 250.0,
        max_turn_ms: float = 12000.0,
        rms_threshold: float = 0.012,
        relative_drop: float = 0.3,
        noise_floor: Optional[float] = None,
        floor_margin: float = 8.0,
        gate_min: float = 0.004,
        gate_max: float = 0.05,
    ):
        self.silence_ms = silence_ms
        self.min_speech_ms = min_speech_ms
        self.max_turn_ms = max_turn_ms
        self.rms_threshold = rms_threshold
        self.relative_drop = relative_drop
        self.floor_margin = floor_margin
        self.gate_min = gate_min
        self.gate_max = gate_max
        self._floor_seed = noise_floor if noise_floor and noise_floor > 0 else rms_threshold / 8.0
        self.reset()

    def reset(self) -> None:
        self.speech_ms = 0.0
        self.quiet_ms = 0.0
        self.elapsed_ms = 0.0
        self.speech_started = False
        self.speech_peak = 0.0
        self.pre_quiet_ms = 0.0
        self.ended = False
        self.end_reason = ""
        self.noise_floor = max(self._floor_seed, 1e-7)

    @property
    def gate(self) -> float:
        """Umbral adaptativo actual (para logs/salud)."""
        return min(max(min(self.rms_threshold, self.noise_floor * self.floor_margin),
                       self.gate_min), self.gate_max)

    @property
    def silence_bar(self) -> float:
        """Barra actual de silencio (para logs)."""
        return max(self.gate, self.speech_peak * self.relative_drop)

    def _track_floor(self, rms: float) -> None:
        # Baja instantanea al minimo observado; subida lenta (no deja que el
        # habla arrastre el piso).
        if rms < self.noise_floor:
            self.noise_floor = max(rms, 1e-7)
        else:
            self.noise_floor += (rms - self.noise_floor) * 0.002

    def update(self, rms: float, chunk_ms: float) -> bool:
        if self.ended:
            return True
        self.elapsed_ms += chunk_ms
        if self.elapsed_ms >= self.max_turn_ms:
            self.ended = True
            self.end_reason = "max_turn"
            return True
        self._track_floor(rms)
        gate = self.gate
        if not self.speech_started:
            # Puerta de entrada adaptativa y SOSTENIDA (tolerancia 120 ms a
            # micro-cortes): fragmentos dispersos no acumulan.
            if rms >= gate:
                self.speech_ms += chunk_ms
                self.pre_quiet_ms = 0.0
                if rms > self.speech_peak:
                    self.speech_peak = rms
                if self.speech_ms >= self.min_speech_ms:
                    self.speech_started = True
            else:
                self.pre_quiet_ms += chunk_ms
                if self.pre_quiet_ms > 120.0:
                    self.speech_ms = 0.0
                    self.speech_peak = 0.0
            return False
        # Habla en curso: el silencio es relativo al pico del turno.
        bar = max(gate, self.speech_peak * self.relative_drop)
        if rms >= bar:
            self.speech_ms += chunk_ms
            self.quiet_ms = 0.0
            if rms > self.speech_peak:
                self.speech_peak = rms
            return False
        self.quiet_ms += chunk_ms
        if self.quiet_ms >= self.silence_ms:
            self.ended = True
            self.end_reason = "silence"
            return True
        return False


def peak_of_pcm(data: bytes) -> float:
    """Pico 0..1 de un chunk PCM16 (para health; nunca levanta)."""
    try:
        if not data:
            return 0.0
        return float(np.abs(np.frombuffer(data, dtype=np.int16)).max()) / 32768.0
    except Exception:
        return 0.0


class BargeDetector:
    """Gate de barge-in con referencia de eco (puro, testeable, sin I/O).

    Dos condiciones (ambas con sustain 300 ms):
    1. Trailing gate: max(0.02, max_1s * 1.8) — el habla debe superar el
       nivel reciente (cualquier volumen de TTS queda abajo sin priors).
    2. Referencia de eco: rms >= played_ref * 0.5, donde played_ref es la
       energia maxima emitida por los parlantes ~100-300 ms atras. Un salto
       de volumen del TTS sube el mic PERO tambien played_ref (ratio ~0.18
       medido), asi que no dispara; la voz real supera ~0.5x lo emitido.
    Sin played_ref (<=0) solo rige la condicion 1. Piso absoluto 0.03.
    """

    def __init__(self, history_seconds: float = 1.0, trigger_ms: float = 300.0,
                 echo_ratio: float = 0.5):
        import collections as _collections
        self._history: _collections.deque = _collections.deque(maxlen=256)
        self._history_seconds = history_seconds
        self._trigger_ms = trigger_ms
        self._echo_ratio = echo_ratio
        self.hot_ms = 0.0
        self.gate = 0.02
        self._latch_ttl_ms = 0.0

    def reset(self) -> None:
        self._history.clear()
        self.hot_ms = 0.0
        self.gate = 0.02
        self._latch_ttl_ms = 0.0

    def update(self, rms: float, chunk_ms: float, played_ref: float = 0.0) -> bool:
        """Alimenta un chunk; devuelve True al sostener 300 ms sobre el gate."""
        try:
            rms = max(0.0, float(rms))
        except Exception:
            return False
        self._history.append(rms)
        window = max(1, int(self._history_seconds * 1000.0 / max(1.0, chunk_ms)))
        recent = list(self._history)[-window:]
        # El pasado excluye ~150 ms recientes: la voz sostenida no debe
        # levantar su propio gate (si no, jamas dispararia).
        skip = max(1, int(150.0 / max(1.0, chunk_ms)))
        past = recent[:-skip] if len(recent) > skip else ([recent[0]] if recent else [0.0])
        candidate = max(0.02, max(past) * 1.8)
        if self.hot_ms <= 0.0:
            self.gate = candidate
            self._latch_ttl_ms = 800.0
        else:
            # Gate latchado durante el onset; expira a los 800 ms para
            # re-adaptar (un onset falso por salto de TTS se veta por eco).
            self._latch_ttl_ms -= chunk_ms
            if self._latch_ttl_ms <= 0.0:
                self.gate = candidate
                self.hot_ms = 0.0
                self._latch_ttl_ms = 800.0
        voiced = rms >= self.gate and rms >= 0.03
        if voiced and played_ref > 0 and rms < played_ref * self._echo_ratio:
            voiced = False
        if voiced:
            self.hot_ms += chunk_ms
        else:
            self.hot_ms = 0.0
        return self.hot_ms >= self._trigger_ms


def compute_turn_health(
    *,
    rms_list: list,
    peak_list: Optional[list] = None,
    gain_avg: float = 1.0,
    gate: float = 0.012,
    noise_floor: float = 0.0,
    speech_started: bool = False,
    speech_ms: float = 0.0,
    endpoint_reason: str = "",
    native_rate: int = 16000,
    stt_rate: int = 16000,
    transcript_chars: int = 0,
    warmup_chunks: int = 10,
) -> dict:
    """Health score de un turno de voz (puro: sin I/O, testeable).

    - signal_rms: media de chunks con voz (>= gate); si no hay, el maximo.
    - noise_rms: piso observado (min, o el floor del endpoint si se da).
    - snr_estimate dB: 20*log10(signal/noise), acotado a [0, 60].
    - clipping_ratio: fraccion de chunks con pico post-gain >= 0.98
      (lo que Vosk recibio; con AGC y ataque rapido equivale a clip en origen
      si la ganancia ya estaba ~1).
    - quality: good/degraded/bad. bad = sin habla sostenida (<200 ms) o
      SNR < 6 dB o vacio total -> el worker lo convierte en mic-signal-too-low
      y suprime el texto (no se despacha basura).
    """
    try:
        arr = [float(r) for r in (rms_list or [])]
    except Exception:
        arr = []
    voiced = [r for r in arr if r >= gate]
    signal_rms = sum(voiced) / len(voiced) if voiced else (max(arr) if arr else 0.0)
    noise_rms = min(arr) if arr else 0.0
    if noise_floor and noise_floor > 0:
        noise_rms = min(noise_rms, float(noise_floor)) if noise_rms else float(noise_floor)
    if signal_rms > 0 and noise_rms > 0:
        import math as _math
        snr_db = max(0.0, min(60.0, 20.0 * _math.log10(signal_rms / max(noise_rms, 1e-9))))
    else:
        snr_db = 0.0
    try:
        peaks = [float(p) for p in (peak_list or [])]
    except Exception:
        peaks = []
    peak = max(peaks) if peaks else 0.0
    # El clipping del transitorio de ataque (primeros chunks, la ganancia aun
    # no bajo) no cuenta: solo clipping sostenido indica saturacion real.
    settled = peaks[warmup_chunks:] if warmup_chunks and len(peaks) > warmup_chunks else peaks
    clipping_ratio = (sum(1 for p in settled if p >= 0.98) / len(settled)) if settled else 0.0
    if not speech_started or speech_ms < 200.0 or snr_db < 6.0 or (not voiced and transcript_chars == 0):
        quality = "bad"
    elif snr_db < 15.0 or clipping_ratio > 0.01 or endpoint_reason == "max_turn":
        quality = "degraded"
    else:
        quality = "good"
    return {
        "signal_rms": round(signal_rms, 6),
        "noise_rms": round(noise_rms, 6),
        "snr_db": round(snr_db, 1),
        "peak": round(peak, 4),
        "clipping_ratio": round(clipping_ratio, 4),
        "gain_applied": round(float(gain_avg), 2),
        "endpoint": endpoint_reason or "none",
        "sample_rate": int(native_rate),
        "stt_rate": int(stt_rate),
        "quality": quality,
    }


class AudioCapture:
    """Captures audio from microphone using a thread-safe queue.

    The PortAudio callback is ABSOLUTELY MINIMAL:
      - checks self._running (atomic bool read)
      - copies in_data to bytes copy
      - puts bytes into Queue
      - returns tuple

    No deque append, no complex logic, no logging, no Vosk, no external calls.

    Object IDs track lifecycle:
      - capture_id: unique per AudioCapture instance
      - stream_id: unique per PortAudio stream
    """

    def __init__(
        self,
        sample_rate: int = 16000,
        channels: int = 1,
        chunk_size: int = 512,
        format: int = pyaudio.paInt16,
        pyaudio_instance: Optional[pyaudio.PyAudio] = None,
        preroll_seconds: float = 1.5,
        input_device_name: str = "Micrófono (JBL Quantum 300)",
        input_device_index: int = -1,
        use_callback: bool = True,
    ):
        self.capture_id = uuid.uuid4().hex[:8]
        self.sample_rate = sample_rate
        self.channels = channels
        self.chunk_size = chunk_size
        self.format = format
        self._owns_pyaudio = pyaudio_instance is None
        self._audio = pyaudio_instance or pyaudio.PyAudio()
        self._stream: Optional[pyaudio.Stream] = None
        self._stream_id: Optional[str] = None
        self._running = False
        self._running_lock = threading.Lock()
        self._use_callback = use_callback

        self._chunk_queue: queue.Queue[bytes] = queue.Queue(maxsize=200)
        self._callback_done = threading.Event()
        self._callback_done.set()

        preroll_chunks = int(preroll_seconds * sample_rate / chunk_size)
        self._preroll: collections.deque[bytes] = collections.deque(maxlen=preroll_chunks)
        self._preroll_lock = threading.Lock()

        self._input_device_name = input_device_name
        self._input_device_index = input_device_index
        self._valid_input_index = -1
        self._stream_channels = channels
        self._stream_rate = sample_rate
        self._stt_agc = StreamingAgc()
        self._endpoint_noise_seed: Optional[float] = None
        self._input_calibration: dict = {}

        print(
            "[voice-debug] stt-capture-object id=" + self.capture_id,
            flush=True,
        )

    @property
    def is_blocking(self) -> bool:
        """True cuando el stream opera en modo blocking (sin stream_callback)."""
        return not self._use_callback

    @property
    def stream_rate_hz(self) -> int:
        """Tasa real del stream (puede diferir de sample_rate: nativo)."""
        return self._stream_rate

    @property
    def agc_stats(self) -> dict:
        """Stats del AGC del turno (para health; nunca levanta)."""
        try:
            return self._stt_agc.stats()
        except Exception:
            return {}

    @property
    def endpoint_noise_seed(self) -> Optional[float]:
        """Semilla post-gain del gate adaptativo (de la calibracion)."""
        return self._endpoint_noise_seed

    def _resolve_input_device(self) -> tuple[int, str, int, int]:
        if self._input_device_index >= 0:
            try:
                info = self._audio.get_device_info_by_index(self._input_device_index)
                name = info.get('name', '')
                max_in = info.get('maxInputChannels', 0)
                default_rate = int(info.get('defaultSampleRate', 0) or 0)
                rates = [self.sample_rate]
                for extra in (default_rate, 48000, 44100):
                    if extra and extra not in rates:
                        rates.append(extra)
                opened = _try_open_input(
                    self._audio, self._input_device_index, max_in or 1, rates
                )
                if opened is not None:
                    rate, ch = opened
                    self._valid_input_index = self._input_device_index
                    return self._input_device_index, name, ch, rate
                print(
                    f"[voice-debug] input-forced-index-open-fail index={self._input_device_index} "
                    f"name=\"{name}\" (falla a todas las tasas; se usa seleccion)",
                    flush=True,
                )
            except Exception:
                pass
        dev_idx, dev_name, ch, rate, _ = find_best_input_device(
            self._audio,
            preferred_name=self._input_device_name,
            sample_rate=self.sample_rate,
            try_native_rates=True,
        )
        if dev_idx < 0:
            raise RuntimeError('No valid audio input device found')
        self._valid_input_index = dev_idx
        return dev_idx, dev_name, ch, rate

    def start(self) -> None:
        if self._running:
            return
        with self._running_lock:
            self._running = True
        self._callback_done.clear()
        self._stream_id = uuid.uuid4().hex[:8]

        device_index, device_name, channels, device_rate = self._resolve_input_device()
        self._valid_input_index = device_index
        self._stream_channels = channels
        self._stream_rate = device_rate

        # Auto-calibracion de arranque (una vez por endpoint/semana; el resto
        # de los turnos reutiliza cache en memoria + prefs). Mide floor ~2 s
        # solo si no hay entrada fresca; si no, es instantanea.
        self._input_calibration: dict = {}
        if STT_AUTO_CALIBRATE and not self._use_callback:
            try:
                norm_name, host_api = describe_input_endpoint(self._audio, device_index)
                if norm_name:
                    self._input_calibration = calibrate_input_endpoint(
                        self._audio, device_index, norm_name, host_api,
                        device_rate, channels,
                    )
            except Exception as e:
                print(f"[voice-debug] input-calibrate-skip err={e}", flush=True)
        cal = self._input_calibration or {}
        self._stt_agc = StreamingAgc(
            target_peak=STT_TARGET_PEAK,
            max_gain=float(cal.get("max_gain", 12.0)),
            init_gain=float(cal.get("init_gain", 8.0)),
            noise_floor=float(cal.get("noise_floor", 0.0)) or None,
        )
        self._endpoint_noise_seed = float(cal.get("gate_seed", 0.0)) or None

        self._stream = self._audio.open(
            format=self.format,
            channels=channels,
            rate=device_rate,
            input=True,
            frames_per_buffer=self.chunk_size,
            stream_callback=self._portaudio_callback if self._use_callback else None,
            input_device_index=device_index,
        )
        print(
            "[voice-debug] stt-stream-object id=" + self._stream_id,
            flush=True,
        )
        self._stream.start_stream()
        print(
            "[voice-debug] stt-stream-start id=" + self._stream_id,
            flush=True,
        )
        print(
            f"[voice-debug] stt-open id={self.capture_id} stream-id={self._stream_id} pyaudio-id={id(self._audio):x} thread={threading.get_ident()} mode={'callback' if self._use_callback else 'blocking'}",
            flush=True,
        )

    def _portaudio_callback(
        self,
        in_data: bytes,
        frame_count: int,
        time_info: dict,
        status: int,
    ) -> tuple:
        """ABSOLUTELY MINIMAL PortAudio callback.

        Only does:
        1. Check self._running (atomic lock-protected)
        2. Copy in_data to bytes copy (in_data is read-only native memory)
        3. Put bytes copy into Queue
        4. Return tuple
        """
        if not self._running:
            self._callback_done.set()
            _vlog(f"stt-callback-exit id={self.capture_id} stream-id={self._stream_id} thread={threading.get_ident()}")
            return (in_data, pyaudio.paContinue)
        if self._stream_channels == 2:
            pcm_bytes = np.frombuffer(in_data, dtype=np.int16)[0::2].tobytes()
        else:
            pcm_bytes = bytes(in_data)
        try:
            self._chunk_queue.put_nowait(pcm_bytes)
        except queue.Full:
            pass
        self._append_preroll(pcm_bytes)
        return (in_data, pyaudio.paContinue)

    def get_chunk(self, timeout: float = 0.1) -> Optional[bytes]:
        if not self._use_callback:
            # Modo blocking: leer directamente del stream y normalizar a
            # 16 kHz mono (lo que espera Vosk) aunque el dispositivo abra
            # a otra frecuencia o en estereo.
            try:
                data = self._stream.read(self.chunk_size, exception_on_overflow=False)
                if self._stream_channels == 2:
                    pcm_bytes = np.frombuffer(data, dtype=np.int16)[0::2].tobytes()
                else:
                    pcm_bytes = bytes(data)
                if self._stream_rate != self.sample_rate:
                    pcm_bytes = resample_mono_pcm(pcm_bytes, self._stream_rate, self.sample_rate)
                # Ganancia STT (AGC lento por defecto: preserva dinamica y no
                # satura; lo que Vosk escucha y lo que mide el endpoint es
                # post-gain). STT_AUTO_GAIN=0 = byte-exacto (emergencia).
                if STT_AUTO_GAIN:
                    if STT_GAIN_MODE == "agc":
                        pcm_bytes = self._stt_agc.process(pcm_bytes)
                    else:
                        pcm_bytes = apply_stt_gain(pcm_bytes)
                self._append_preroll(pcm_bytes)
                return pcm_bytes
            except Exception:
                return None
        try:
            return self._chunk_queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def get_preroll(self) -> bytes:
        with self._preroll_lock:
            return b''.join(self._preroll)

    def clear_preroll(self) -> None:
        with self._preroll_lock:
            self._preroll.clear()

    def _append_preroll(self, data: bytes) -> None:
        with self._preroll_lock:
            self._preroll.append(data)

    def stop(self) -> None:
        with self._running_lock:
            self._running = False
        if self._stream:
            try:
                self._stream.stop_stream()
            except Exception:
                pass
            # Gracia anti-race: stop_stream desbloquea un read() en curso en
            # la mayoria de los host APIs; cerrar DE INMEDIATO puede tirar
            # 0xC0000005 en PortAudio si el read seguia dentro. 50 ms.
            try:
                time.sleep(0.05)
            except Exception:
                pass
            try:
                self._stream.close()
            except Exception:
                pass
            self._stream = None
            print(
                "[voice-debug] stt-stream-close id=" + (self._stream_id or '?'),
                flush=True,
            )
        if self._use_callback:
            self._callback_done.wait(timeout=2.0)
            _vlog(f"stt-callback-quiesced id={self.capture_id} stream-id={self._stream_id} thread={threading.get_ident()}")
        while not self._chunk_queue.empty():
            try:
                self._chunk_queue.get_nowait()
            except queue.Empty:
                break
        print(
            "[voice-debug] stt-capture-stop id=" + self.capture_id,
            flush=True,
        )

    def __del__(self):
        self.stop()
        if self._owns_pyaudio:
            try:
                self._audio.terminate()
            except Exception:
                pass


class AudioPlayback:
    """Plays back PCM audio at 24kHz mono."""

    def __init__(
        self,
        sample_rate: int = 24000,
        channels: int = 1,
        chunk_size: int = 1024,
        format: int = pyaudio.paInt16,
        on_end: Optional[Callable[[], None]] = None,
        pyaudio_instance: Optional[pyaudio.PyAudio] = None,
        output_device_name: str = "JBL Quantum 300",
        output_device_index: int = -1,
    ):
        self.playback_id = uuid.uuid4().hex[:8]
        self.sample_rate = sample_rate
        self.channels = channels
        self.chunk_size = chunk_size
        self.format = format
        self._owns_pyaudio = pyaudio_instance is None
        self._audio = pyaudio_instance or pyaudio.PyAudio()
        self._stream: Optional[pyaudio.Stream] = None
        self._stream_id: Optional[str] = None
        self._buffer: queue.Queue[bytes] = queue.Queue()
        self._playback_started = False
        self._running = False
        self._running_lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._on_end_callback: Optional[Callable[[], None]] = on_end
        self._output_device_name = output_device_name
        self._output_device_index = output_device_index
        self._valid_output_index = -1
        self._stream_rate = sample_rate
        self._stream_channels = channels
        self._frames_written = 0
        self._bytes_written = 0
        self._playback_start_ts = 0.0
        self._dropped_frames = 0
        self._backlog_max_frames = 0
        # Cota de backlog: ~100 chunks de 1024 frames @24kHz ~= 4.3 s.
        self._max_buffered_frames = 100

        print(
            "[tts-debug] playback-object id=" + self.playback_id,
            flush=True,
        )

    def start(self, on_end: Optional[Callable[[], None]] = None) -> None:
        if self._running:
            return
        if on_end is not None:
            self._on_end_callback = on_end
        with self._running_lock:
            self._running = True

        dev_idx, dev_name, stream_rate, stream_channels, alternatives = find_best_output_device(
            self._audio,
            preferred_name=self._output_device_name,
            sample_rate=self.sample_rate,
            channels=self.channels,
        )

        all_candidates = []
        if dev_idx >= 0:
            all_candidates.append({
                'index': dev_idx,
                'name': dev_name,
                'workingRate': stream_rate,
                'workingChannels': stream_channels,
            })
        all_candidates.extend(alternatives)

        stream_opened = False
        for cand in all_candidates:
            idx = cand['index']
            name = cand['name']
            rate = cand['workingRate']
            ch = cand['workingChannels']
            try:
                print(f"[tts-debug] selected-output-device index={idx}", flush=True)
                print(f"[tts-debug] selected-output-device-name=\"{name}\"", flush=True)
                self._stream = self._audio.open(
                    format=self.format,
                    channels=ch,
                    rate=rate,
                    output=True,
                    frames_per_buffer=self.chunk_size,
                    stream_callback=self._playback_callback,
                    output_device_index=idx,
                )
                self._valid_output_index = idx
                self._stream_rate = rate
                self._stream_channels = ch
                self._stream_id = uuid.uuid4().hex[:8]
                print(f"[tts-debug] playback-stream-object id={self._stream_id}", flush=True)
                self._stream.start_stream()
                self._thread = threading.Thread(target=self._playback_loop, daemon=True)
                self._thread.start()
                print("[tts-debug] playback-init=ok", flush=True)
                stream_opened = True
                break
            except Exception as e:
                print(f"[tts-debug] output-device failed index={idx} name=\"{name}\" error=\"{e}\"", flush=True)
                self._stream = None
                continue

        if not stream_opened:
            with self._running_lock:
                self._running = False
            print("[tts-debug] playback-init=failed: no working physical output device", flush=True)
            raise RuntimeError("No valid audio output device found")

    def _playback_callback(
        self,
        in_data: bytes,
        frame_count: int,
        time_info: dict,
        status: int,
    ) -> tuple:
        try:
            data = self._buffer.get_nowait()
            expected_len = frame_count * 2 * self._stream_channels
            if len(data) < expected_len:
                data += b'\x00' * (expected_len - len(data))
        except queue.Empty:
            data = b'\x00' * (frame_count * 2 * self._stream_channels)
        return (data, pyaudio.paContinue)

    def _playback_loop(self) -> None:
        while self._running:
            time.sleep(0.1)
            if self._stream and not self._stream.is_active():
                break
        if self._on_end_callback:
            self._on_end_callback()

    def write(self, data: bytes) -> None:
        if not self._running:
            return
        if not self._playback_started:
            self._playback_started = True
            self._frames_written = 0
            self._bytes_written = 0
            self._dropped_frames = 0
            self._backlog_max_frames = 0
            self._playback_start_ts = time.monotonic()
            print("[tts-debug] playback-start", flush=True)

        # Convert mono to stereo if hardware stream expects 2 channels
        if self._stream_channels == 2 and self.channels == 1 and len(data) >= 2:
            samples = np.frombuffer(data, dtype=np.int16)
            data = np.repeat(samples, 2).tobytes()

        # Resample if stream sample rate differs from source sample rate
        if self.sample_rate != self._stream_rate and len(data) >= 2:
            num_samples = len(data) // (2 * self._stream_channels)
            orig_samples = np.frombuffer(data, dtype=np.int16)
            target_num_samples = int(num_samples * self._stream_rate / self.sample_rate)
            if self._stream_channels == 1:
                resampled = np.interp(
                    np.linspace(0, num_samples, target_num_samples, endpoint=False),
                    np.arange(num_samples),
                    orig_samples,
                ).astype(np.int16)
            else:
                left = orig_samples[0::2]
                right = orig_samples[1::2]
                resampled_l = np.interp(
                    np.linspace(0, num_samples, target_num_samples, endpoint=False),
                    np.arange(num_samples),
                    left,
                ).astype(np.int16)
                resampled_r = np.interp(
                    np.linspace(0, num_samples, target_num_samples, endpoint=False),
                    np.arange(num_samples),
                    right,
                ).astype(np.int16)
                resampled = np.empty((target_num_samples * 2,), dtype=np.int16)
                resampled[0::2] = resampled_l
                resampled[1::2] = resampled_r
            data = resampled.tobytes()

        frame_bytes = self.chunk_size * 2 * self._stream_channels
        for i in range(0, len(data), frame_bytes):
            chunk_piece = data[i:i + frame_bytes]
            # Cota anti-backlog: la cola era unbounded (crecia sin limite si
            # el servidor enviaba mas rapido de lo que suena). Al superar
            # ~4 s de audio pendiente se descarta lo mas viejo (en vivo
            # importa el presente, no el pasado) y se cuenta. Nunca bloquea.
            if self._buffer.qsize() >= self._max_buffered_frames:
                try:
                    self._buffer.get_nowait()
                    self._dropped_frames += 1
                    if self._dropped_frames == 1 or self._dropped_frames % 50 == 0:
                        print(
                            f"[tts-debug] playback-backlog-drop dropped={self._dropped_frames} "
                            f"qsize={self._buffer.qsize()}",
                            flush=True,
                        )
                except queue.Empty:
                    pass
            self._buffer.put(chunk_piece)
            self._frames_written += 1
            self._bytes_written += len(chunk_piece)
            _qsize = self._buffer.qsize()
            if _qsize > self._backlog_max_frames:
                self._backlog_max_frames = _qsize

    def purge(self) -> int:
        """Vacía la cola pendiente SIN cerrar el stream (barge-in / abort).

        Thread-safe (solo ops de queue). Devuelve frames descartados.
        El proximo write rearranca metricas y loguea playback-start.
        """
        dropped = 0
        while not self._buffer.empty():
            try:
                self._buffer.get_nowait()
                dropped += 1
            except queue.Empty:
                break
        if dropped:
            print(f"[tts-debug] playback-purged dropped_frames={dropped}", flush=True)
        self._playback_started = False
        self._frames_written = 0
        self._bytes_written = 0
        self._dropped_frames = 0
        self._playback_start_ts = None
        return dropped

    def stop(self) -> None:
        with self._running_lock:
            self._running = False
        if self._playback_started:
            duration_ms = (
                int((time.monotonic() - self._playback_start_ts) * 1000)
                if self._playback_start_ts
                else 0
            )
            _frame_ms = (self.chunk_size / max(1, self._stream_rate)) * 1000.0
            print("[tts-debug] playback-end", flush=True)
            print(
                "[tts-debug] " + format_playback_summary(
                    self._frames_written, self._bytes_written, duration_ms,
                    int(self._backlog_max_frames * _frame_ms),
                ),
                flush=True,
            )
            self._playback_started = False
        while not self._buffer.empty():
            try:
                self._buffer.get_nowait()
            except queue.Empty:
                break
        if self._stream:
            self._stream.stop_stream()
            self._stream.close()
            self._stream = None
            print(
                "[tts-debug] playback-stream-close id=" + (self._stream_id or '?'),
                flush=True,
            )
        if self._thread:
            self._thread.join(timeout=1.0)
            self._thread = None

    def __del__(self):
        try:
            self.stop()
        except AttributeError:
            pass
        if self._owns_pyaudio:
            try:
                self._audio.terminate()
            except AttributeError:
                pass


def format_playback_summary(frames: int, audio_bytes: int, duration_ms: int, backlog_max_ms: int = 0) -> str:
    """Linea unica de resumen de playback (testeable, sin I/O)."""
    return (
        f"playback-summary frames={frames} bytes={audio_bytes} "
        f"duration_ms={duration_ms} backlog_max_ms={backlog_max_ms}"
    )


def pcm_to_numpy(pcm_data: bytes, dtype=np.int16) -> np.ndarray:
    return np.frombuffer(pcm_data, dtype=dtype)


def numpy_to_pcm(arr: np.ndarray) -> bytes:
    return arr.astype(np.int16).tobytes()


def apply_auto_gain(pcm_data: bytes, target_peak: float = 0.5, max_gain: float = 15.0) -> bytes:
    if len(pcm_data) < 2:
        return pcm_data
    samples = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32) / 32768.0
    peak = float(np.max(np.abs(samples)))
    if peak < 0.002 or peak >= 0.35:
        return pcm_data
    gain = min(target_peak / max(peak, 1e-6), max_gain)
    amplified = np.clip(samples * gain, -1.0, 1.0)
    return (amplified * 32768.0).astype(np.int16).tobytes()


def diagnostic_callback_test(
    sample_rate: int = 16000,
    chunk_size: int = 512,
    channels: int = 1,
    duration_seconds: float = 5.0,
    device_index: int = -1,
) -> None:
    """Test PortAudio callback WITHOUT Vosk, WITHOUT CloudCore, WITHOUT TTS.

    Opens an audio stream, runs callbacks for `duration_seconds`, counts callbacks.
    If this crashes with 0xC0000005, the problem is in PortAudio/open/callback.
    """
    print("[voice-debug] stt-callback-test mode=on", flush=True)
    print("[voice-debug] stt-callback-test duration=" + str(duration_seconds), flush=True)

    pa = pyaudio.PyAudio()
    stream = None
    callback_count = [0]
    error_occurred = [False]

    def minimal_callback(in_data, frame_count, time_info, status):
        callback_count[0] += 1
        return (in_data, pyaudio.paContinue)

    try:
        dev_idx = device_index if device_index >= 0 else find_valid_input_device(pa)
        if dev_idx < 0:
            print("[voice-debug] stt-callback-test: no valid input device", flush=True)
            return

        info = pa.get_device_info_by_index(dev_idx)
        print(
            "[voice-debug] stt-callback-test device=" + str(dev_idx) +
            " name=\"" + str(info.get('name', '')) + "\"",
            flush=True,
        )

        stream = pa.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=sample_rate,
            input=True,
            frames_per_buffer=chunk_size,
            stream_callback=minimal_callback,
            input_device_index=dev_idx,
        )
        stream.start_stream()
        print("[voice-debug] stt-callback-test stream started", flush=True)

        start = time.time()
        while time.time() - start < duration_seconds and stream.is_active():
            time.sleep(0.1)
            if callback_count[0] % 100 == 0:
                print(
                    "[voice-debug] stt-callback-test count=" + str(callback_count[0]),
                    flush=True,
                )

        print(
            "[voice-debug] stt-callback-test done count=" + str(callback_count[0]),
            flush=True,
        )
        stream.stop_stream()
        stream.close()

    except Exception as e:
        error_occurred[0] = True
        print("[voice-debug] stt-callback-test ERROR: " + str(e), flush=True)
    finally:
        if stream:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
        try:
            pa.terminate()
        except Exception:
            pass

    if not error_occurred[0]:
        print("[voice-debug] stt-callback-test PASSED count=" + str(callback_count[0]), flush=True)
    else:
        print("[voice-debug] stt-callback-test FAILED", flush=True)
