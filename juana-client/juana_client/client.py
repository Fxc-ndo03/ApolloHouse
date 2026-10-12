"""Main Juana client for connecting to Apollo.

Architecture (cloud-first, single route):
  Python sidecar handles: wake word, STT, TTS playback.
  Rust CloudCoreManager handles: WebSocket to Worker, text routing.
  Python outputs text to stdout, Rust reads and forwards to CloudCoreManager.
  Rust forwards Worker responses (text + TTS audio) to Python via stdin.
"""

import asyncio
import json
import os
import sys
import threading
import time
import uuid
from typing import Optional, Callable
from dataclasses import dataclass
from enum import Enum
from queue import Queue, Empty

import pyaudio

from .audio import (
    AudioCapture,
    AudioPlayback,
    SpeechEndpoint,
    compute_rms,
    compute_turn_health,
    describe_input_endpoint,
    diagnostic_callback_test,
    note_input_signal_quality,
    note_input_speech_stats,
    peak_of_pcm,
    persist_device_preference,
    load_device_preference,
    get_preferred_device_name,
)
from .wake import create_wake_detector, VoskWakeWordDetector, ManualWakeWordDetector


def _vlog(msg: str) -> None:
    try:
        print(f"[voice-debug] {msg}", flush=True)
    except OSError:
        pass


# Verbosidad completa solo con APOLLO_SIDECAR_DEBUG=1. Por defecto: lifecycle
# + metricas + warnings. Sin spam por chunk/frame.
_SIDECAR_DEBUG = os.getenv("APOLLO_SIDECAR_DEBUG", "0") == "1"

# Dump del audio exacto que escucha Vosk (post-gain, 16 kHz mono) por turno.
# Solo diagnostico: APOLLO_STT_DEBUG_WAV=1. Acotado al turno (max_turn).
_STT_DEBUG_WAV = os.getenv("APOLLO_STT_DEBUG_WAV", "0") == "1"


def _dlog(msg: str) -> None:
    if not _SIDECAR_DEBUG:
        return
    try:
        print(f"[voice-debug] {msg}", flush=True)
    except OSError:
        pass


def build_voice_transcript_payload(
    text: str, turn_id: str, generation: int = 0, ts: int = 0,
    speech_start_ms: int = -1, speech_end_ms: int = -1,
) -> dict:
    """Payload JSON del transcript con su turn_id (trazabilidad end-to-end).

    FASE 3: publica {turn_id, generation, timestamp, payload}; el consume
    usa exactamente este turn_id y nunca lo infiere del estado.
    FASE 4: incluye speech_start/end_ms para el voice-latency-summary.
    """
    payload = {"type": "voice_transcript", "text": text, "turn_id": turn_id}
    if generation:
        payload["generation"] = generation
    payload["ts"] = ts or int(time.time() * 1000)
    if speech_start_ms >= 0:
        payload["speech_start_ms"] = speech_start_ms
    if speech_end_ms >= 0:
        payload["speech_end_ms"] = speech_end_ms
    return payload

# Log de identidad: verifica que este modulo se inicializa UNA sola vez
print(f"[sidecar] client-module-init __name__={__name__} __file__={__file__} pid={os.getpid()}", flush=True)


class ConnectionState(Enum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    AUTHENTICATED = "authenticated"
    ERROR = "error"


class VoiceState(Enum):
    IDLE = "idle"
    LISTENING = "listening"


@dataclass
class JuanaConfig:
    device_id: str = "juana-client"
    device_shared_secret: str = ""
    sample_rate_capture: int = 16000
    sample_rate_playback: int = 24000
    chunk_size_capture: int = 512
    chunk_size_playback: int = 1024
    wake_words: list[str] = None
    wake_model_dir: str = None
    use_vosk_wake: bool = True
    listen_timeout: float = 12.0
    input_device_name: str = "Micrófono (JBL Quantum 300)"
    output_device_name: str = "JBL Quantum 300"
    worker_url: str = ""
    use_local_core: bool = False
    # STT incremental de baja latencia (endpointing por energia).
    stt_chunk_ms: float = 40.0
    stt_silence_ms: float = 600.0
    stt_min_speech_ms: float = 250.0
    stt_max_turn_ms: float = 12000.0
    stt_rms_threshold: float = 0.012


class JuanaClient:
    def __init__(self, config: Optional[JuanaConfig] = None):
        self.config = config or JuanaConfig()
        if self.config.wake_words is None:
            self.config.wake_words = ["apollo", "hey apollo"]
        self.config.input_device_name = get_preferred_device_name("input", self.config.input_device_name)
        self.config.output_device_name = get_preferred_device_name("output", self.config.output_device_name)
        self._conn_state = ConnectionState.DISCONNECTED
        self._voice_state = VoiceState.IDLE
        self._running = False
        self._pyaudio = pyaudio.PyAudio()
        self._audio_capture: Optional[AudioCapture] = None
        self._audio_playback: Optional[AudioPlayback] = None
        self._audio_playback_disabled: bool = False
        self._wake_detector: Optional[VoskWakeWordDetector | ManualWakeWordDetector] = None
        self._audio_buffer = bytearray()
        self._mic_muted = False
        self._tts_muted = False
        self._tts_utterance_open = False
        # Barge-in: monitor de energia en el mic durante playback TTS.
        # Gate auto-calibrado: max(0.02, trailing_max_1s * 1.8). El bleed
        # medido (tono 0.21 -> mic 0.036, ratio ~1/6) queda bajo el gate a
        # cualquier volumen porque el gate persigue el maximo reciente; la
        # voz firme lo supera. Sustain 300 ms. Kill-switch: APOLLO_BARGE_IN=0.
        self._barge_enabled = os.getenv("APOLLO_BARGE_IN", "1") == "1"
        self._barge_allowed = False
        self._barge_thread = None
        self._barge_stop = threading.Event()
        self._barge_stop.set()
        self._barge_t0 = 0.0
        self._ignore_tts_audio_until = 0.0
        self._ignore_tts_dropped = 0
        # Energia emitida reciente (ts, rms) para referencia de eco del barge.
        import collections as _collections
        self._played_recent: _collections.deque = _collections.deque(maxlen=300)
        self._event_loop: Optional[asyncio.AbstractEventLoop] = None
        self._stdin_thread: Optional[threading.Thread] = None
        self._tts_playing = False
        self._stt_model = None
        self._stt_recognizer = None
        self._listen_timer: Optional[threading.Timer] = None
        self._stt_worker_thread: Optional[threading.Thread] = None
        # Worker STT persistente: UNICO thread dueno de los objetos nativos
        # vosk (Model + KaldiRecognizer) durante toda su vida. Afinidad por
        # construccion: crear/usar/destruir ocurren siempre en este thread,
        # nunca se comparte un Model entre threads (eso crasheaba con
        # 0xC0000005 aunque el acceso estuviera serializado con locks).
        self._stt_owner_thread: Optional[threading.Thread] = None
        self._stt_turn_event = threading.Event()
        self._stt_turn_event.clear()
        self._stt_owner_stop = False
        # Turn-done: se ACLARA al despachar un turno y se MARCA cuando el
        # owner termina el cuerpo del turno (incluye finalize). Esperar ESTO
        # (no la muerte del thread: el owner es persistente y un join siempre
        # expiraria) antes de cerrar el stream. Sin esto, el close corre
        # durante un read en curso -> 0xC0000005 en PortAudio.
        self._stt_turn_done = threading.Event()
        self._stt_turn_done.set()
        self._stt_model_owner_tid: Optional[int] = None
        self._stt_recognizer_owner_tid: Optional[int] = None
        self._wake_lock = threading.Lock()
        self._stt_lock = threading.Lock()
        self._finish_lock = threading.Lock()
        # Lock de lifecycle Vosk STT: serializa destruccion del recognizer
        # anterior + creacion del siguiente. Garantiza que nunca haya mas de
        # un KaldiRecognizer STT vivo ni create/destroy concurrentes.
        self._stt_vosk_lifecycle_lock = threading.Lock()
        self._stt_generation = 0
        # Metricas del turno en curso (un solo turno activo a la vez).
        self._turn_id = ""
        self._turn_wake_ts = 0.0
        self._turn_final_ts = 0.0

        # Single source of truth: result queue from STT worker
        self._stt_result_queue: Queue[Optional[str]] = Queue(maxsize=1)
        self._stt_result_received = threading.Event()
        self._stt_result_received.clear()
        self._listen_timer_gen = 0
        # Salud del dispositivo de entrada (sticky entre turnos; solo energia).
        self._audio_device_state = "good"
        self._audio_bad_turns = 0

    @property
    def state(self) -> ConnectionState:
        return self._conn_state

    @property
    def is_running(self) -> bool:
        return self._running

    def _set_conn_state(self, state: ConnectionState) -> None:
        self._conn_state = state
        self._emit_json({"type": "connection_state", "state": state.value})

    def _set_voice_state(self, state: VoiceState) -> None:
        self._voice_state = state
        self._emit_json({"type": "ui_state", "state": state.value})

    def _emit_json(self, msg: dict) -> None:
        try:
            line = json.dumps(msg, ensure_ascii=False)
            print(line, flush=True)
        except OSError:
            pass

    def start(self) -> None:
        if self._running:
            return
        try:
            self._running = True
            self._event_loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._event_loop)
            self._set_conn_state(ConnectionState.CONNECTING)

            self._audio_capture = AudioCapture(
                sample_rate=self.config.sample_rate_capture,
                chunk_size=max(
                    160,
                    int(self.config.sample_rate_capture * self.config.stt_chunk_ms / 1000),
                ),
                pyaudio_instance=self._pyaudio,
                input_device_name=self.config.input_device_name,
                # STT siempre en blocking: el callback PortAudio crashea
                # (0xC0000005) en este pipeline. Ver test_stt_cycles.py 20/20.
                use_callback=False,
            )

            try:
                self._audio_playback = AudioPlayback(
                    sample_rate=self.config.sample_rate_playback,
                    chunk_size=self.config.chunk_size_playback,
                    on_end=self._on_playback_end,
                    pyaudio_instance=self._pyaudio,
                    output_device_name=self.config.output_device_name,
                )
                self._audio_playback.start()
                self._audio_playback_disabled = False
            except Exception as e:
                print(f"[sidecar] audio playback disabled: {e}", flush=True)
                self._audio_playback = None
                self._audio_playback_disabled = True

            self._wake_detector = create_wake_detector(
                wake_words=self.config.wake_words,
                model_dir=self.config.wake_model_dir,
                prefer_vosk=self.config.use_vosk_wake,
                on_detected=self._on_wake_detected,
                pyaudio_instance=self._pyaudio,
                input_device_name=self.config.input_device_name,
            )
            self._wake_detector.start()

            self._set_conn_state(ConnectionState.AUTHENTICATED)
            self._start_stdin_listener()
        except Exception as e:
            print(f"[sidecar] start error: {e}", flush=True)
            self._set_voice_state(VoiceState.IDLE)
            self._running = False

    def stop(self) -> None:
        try:
            self._running = False
            self._cancel_listen_timer()
            # Romper el loop del turno primero para que el owner salga rapido.
            self._set_voice_state(VoiceState.IDLE)
            self._stop_barge_monitor()
            self._teardown_stt_owner()
            self._stop_stt_worker()
            if self._wake_detector:
                self._wake_detector.stop()
                self._wake_detector = None
            if self._audio_capture:
                self._audio_capture.stop()
                self._audio_capture = None
            if self._audio_playback and not self._audio_playback_disabled:
                self._audio_playback.stop()
                self._audio_playback = None
        except Exception as e:
            print(f"[sidecar] stop cleanup error: {e}", flush=True)
        finally:
            try:
                self._pyaudio.terminate()
            except Exception:
                pass
            self._set_voice_state(VoiceState.IDLE)
            self._set_conn_state(ConnectionState.DISCONNECTED)

    def _reset_voice_subsystem(self) -> None:
        try:
            self._cancel_listen_timer()
            self._teardown_stt_owner()
            self._stop_stt_worker()
            with self._wake_lock:
                if self._wake_detector:
                    try:
                        self._wake_detector.stop()
                    except Exception:
                        pass
                    self._wake_detector = None
                if self._audio_capture:
                    try:
                        self._audio_capture.stop()
                    except Exception:
                        pass
                self._audio_buffer.clear()
                self._wake_detector = create_wake_detector(
                    wake_words=self.config.wake_words,
                    model_dir=self.config.wake_model_dir,
                    prefer_vosk=self.config.use_vosk_wake,
                    on_detected=self._on_wake_detected,
                    pyaudio_instance=self._pyaudio,
                    input_device_name=self.config.input_device_name,
                )
                self._wake_detector.start()
                self._voice_state = VoiceState.IDLE
                self._emit_json({"type": "ui_state", "state": "idle"})
        except Exception as e:
            print(f"[sidecar] reset error: {e}", flush=True)
            self._emit_json({"type": "ui_state", "state": "idle"})

    def _cancel_listen_timer(self) -> None:
        if self._listen_timer is not None:
            self._listen_timer.cancel()
            self._listen_timer = None

    def _on_listen_timeout(self, generation: int = -1) -> None:
        # Timer atado a generacion: un timer viejo disparando en la ventana
        # de un turno posterior se ignora (antes abortaba el turno ajeno a
        # mitad de un chunk).
        if generation >= 0 and generation != self._stt_generation:
            print(
                f"[voice-debug] stt-timer-stale timer_gen={generation} "
                f"current_gen={self._stt_generation} (ignorado)",
                flush=True,
            )
            return
        # Un solo camino de finalizacion: join worker -> cerrar stream -> consumir.
        print("[voice-debug] stt-end timeout", flush=True)
        self._finalize_listening()

    def _ensure_stt_owner(self) -> bool:
        """Crea el worker STT persistente si no existe. El thread controlador
        NUNCA toca objetos vosk: solo despacha turnos via evento."""
        owner = self._stt_owner_thread
        if owner is not None and owner.is_alive():
            return True
        try:
            self._stt_owner_stop = False
            self._stt_turn_event.clear()
            owner = threading.Thread(target=self._stt_owner_loop, daemon=True)
            self._stt_owner_thread = owner
            owner.start()
            print(f"[voice-debug] stt-owner-start thread={owner.ident}", flush=True)
            return True
        except Exception as e:
            print(f"[sidecar] STT owner start error: {e}", flush=True)
            self._stt_owner_thread = None
            return False

    def _stt_owner_loop(self) -> None:
        """Vida del worker STT persistente: UNICO dueno de Model+Recognizer.

        Cada turno ejecuta el cuerpo existente (_stt_worker_loop). Al salir
        (solo en shutdown/reset) destruye el Model en ESTE thread.
        """
        tid = threading.get_ident()
        print(f"[voice-debug] stt-owner-enter thread={tid}", flush=True)
        while True:
            self._stt_turn_event.wait()
            if self._stt_owner_stop:
                break
            self._stt_turn_event.clear()
            if self._stt_owner_stop:
                break
            try:
                self._stt_worker_loop()
            except Exception as e:
                print(f"[sidecar] STT owner turn error: {e}", flush=True)
            finally:
                # Fin de generacion SIEMPRE (incluye excepciones): el stream
                # ya no tiene reads en curso cuando otro thread lo cierra.
                self._stt_turn_done.set()
        self._destroy_stt_recognizer()
        self._destroy_stt_model()
        print(f"[voice-debug] stt-owner-exit thread={tid}", flush=True)

    def _teardown_stt_owner(self) -> None:
        """Baja el worker persistente. Si lo llama el propio owner (reset por
        MemoryError), destruye inline (afinidad intacta: es su thread) y marca
        salida sin join; si no, senala y espera (con timeout, nunca cuelga)."""
        owner = self._stt_owner_thread
        if owner is None:
            return
        me = threading.get_ident()
        if me == owner.ident:
            self._destroy_stt_recognizer()
            self._destroy_stt_model()
            self._stt_owner_thread = None
            self._stt_owner_stop = True
            return
        self._stt_owner_stop = True
        try:
            self._stt_turn_event.set()
        except Exception:
            pass
        try:
            if owner.is_alive():
                owner.join(timeout=5.0)
        except Exception:
            pass
        self._stt_owner_thread = None

    def _on_wake_detected(self, wake_word: str) -> None:
        if self._voice_state != VoiceState.IDLE:
            print(
                f"[voice-debug] wake-ignored reason=not-idle state={self._voice_state.value}",
                flush=True,
            )
            return

        with self._wake_lock:
            if self._voice_state != VoiceState.IDLE:
                print(
                    f"[voice-debug] wake-ignored reason=not-idle state={self._voice_state.value}",
                    flush=True,
                )
                return
            if self._mic_muted or self._tts_playing:
                return
            # Guardia anti-solape: IDLE se marca al inicio del finalize pero
            # el turno puede seguir cerrando (result/health/destroy). Un wake
            # en esa ventana pisaria la queue y el stream del finalize en
            # curso -> se ignora y el usuario repite el wake word.
            try:
                _owner = self._stt_owner_thread
                _turn_open = (
                    _owner is not None
                    and _owner.is_alive()
                    and not self._stt_turn_done.is_set()
                )
            except Exception:
                _turn_open = False
            if _turn_open:
                print(
                    "[voice-debug] wake-ignored reason=turn-active "
                    f"generation={self._stt_generation}",
                    flush=True,
                )
                return

            print(f"[voice-debug] wake-detected word={wake_word}", flush=True)

            print("[voice-debug] wake-detector=stopping reason=wake-detected", flush=True)
            if self._wake_detector:
                try:
                    self._wake_detector.stop()
                except Exception:
                    pass
            print("[voice-debug] wake-detector=stopped reason=wake-detected", flush=True)

            self._turn_id = uuid.uuid4().hex[:8]
            self._turn_wake_ts = time.monotonic()
            self._turn_final_ts = 0.0
            self._stt_generation += 1
            print(f"[voice-debug] voice-turn-start turn={self._turn_id} word={wake_word}", flush=True)
            self._voice_state = VoiceState.LISTENING
            print("[voice-debug] state=listening", flush=True)
            self._emit_json({"type": "ui_state", "state": "listening"})

        # El worker alimenta el preroll al recognizer una sola vez y en orden;
        # aqui ya no se acumula nada en _audio_buffer (STT incremental).
        self._audio_buffer.clear()
        # Un turno arranca: el monitor de barge no debe competir por el mic.
        self._stop_barge_monitor()

        # Afinidad estricta: el thread controlador NUNCA crea ni toca el
        # vosk.Model (eso crasheaba 0xC0000005 al reutilizarlo cross-thread).
        # El Model nace dentro del worker persistente en su primer turno.
        print("[voice-debug] stt-init begin", flush=True)
        if not self._ensure_stt_owner():
            print("[voice-debug] stt-init-error reason=no-owner", flush=True)
            self._voice_state = VoiceState.IDLE
            self._emit_json({"type": "ui_state", "state": "idle"})
            self._restart_wake_detector()
            return
        print("[voice-debug] stt-init done", flush=True)

        # Reset result queue and event
        self._stt_result_received.clear()
        self._stt_result_queue = Queue(maxsize=1)

        print("[voice-debug] stt-stream-opening", flush=True)
        try:
            self._audio_capture.start()
        except Exception as e:
            print(f"[voice-debug] stt-stream-error ({e})", flush=True)
            self._note_device_state("unavailable", reason="stream-open-failed")
            self._voice_state = VoiceState.IDLE
            self._emit_json({"type": "ui_state", "state": "idle"})
            self._restart_wake_detector()
            return
        print("[voice-debug] stt-stream-opened", flush=True)
        if self._audio_capture:
            print(
                "[voice-debug] stt-capture-object=" + self._audio_capture.capture_id,
                flush=True,
            )
        if self._audio_capture._stream_id:
            print(
                "[voice-debug] stt-stream-object=" + self._audio_capture._stream_id,
                flush=True,
            )
        if self._audio_capture._stream:
            print(
                "[voice-debug] stt-worker-object=" + self._audio_capture._stream_id,
                flush=True,
            )

        # Despacho al worker persistente (mismo thread toda la vida del
        # proceso): el turno corre en _stt_worker_loop dentro del owner.
        # _stt_worker_thread apunta al owner durante el turno para preservar
        # la semantica de join del camino de timeout.
        self._stt_worker_thread = self._stt_owner_thread
        self._stt_turn_done.clear()
        try:
            self._stt_turn_event.set()
        except Exception as e:
            print(f"[voice-debug] stt-dispatch-error ({e})", flush=True)
            self._stt_turn_done.set()
            self._voice_state = VoiceState.IDLE
            self._emit_json({"type": "ui_state", "state": "idle"})
            self._restart_wake_detector()
            return
        print(
            f"[voice-debug] stt-owner-turn-dispatch generation={self._stt_generation} "
            f"thread={self._stt_owner_thread.ident if self._stt_owner_thread else '?'}",
            flush=True,
        )
        print("[voice-debug] stt-worker-start", flush=True)
        print("[voice-debug] stt-callback-ready", flush=True)
        print("[voice-debug] stt-running", flush=True)

        # Timer atado a ESTA generacion: si dispara tarde (un turno posterior
        # ya corre), se ignora en vez de abortar el turno ajeno.
        self._cancel_listen_timer()
        _gen = self._stt_generation
        self._listen_timer_gen = _gen
        self._listen_timer = threading.Timer(
            self.config.listen_timeout, self._on_listen_timeout, args=(_gen,)
        )
        self._listen_timer.daemon = True
        self._listen_timer.start()

    def _stt_worker_loop(self) -> None:
        """Cuerpo de UN turno STT; corre SIEMPRE en el worker persistente.

        Lee chunks (blocking), alimenta AcceptWaveform por chunk, emite
        partials throttled y termina por endpointing de silencio (o max_turn).
        Model + Recognizer nacen, se usan y mueren en este thread (afinidad
        nativa; el controlador jamas los toca). Publica el transcript y
        finaliza por el camino unico (_finalize_listening, reentrante seguro).
        """
        tid = threading.get_ident()
        turn_id = self._turn_id
        generation = self._stt_generation
        _vlog(f"stt-worker-enter thread={tid}")
        _vlog(f"stt-worker-generation generation={generation} thread={tid}")
        # El ensure verifica afinidad obligatoria (Model owner == Recognizer
        # creator) y se niega a crear nada fuera del owner.
        self._ensure_stt_recognizer()
        if self._stt_recognizer is not None:
            _vlog(f"stt-recognizer-owner-thread thread={tid} id={id(self._stt_recognizer):x}")
            recognizer = self._stt_recognizer
            capture = self._audio_capture
            if recognizer is None or capture is None:
                print("[voice-debug] stt-no-recognizer", flush=True)
                self._publish_stt_result(turn_id, generation, None)
                self._finalize_listening()
                return
            cfg = self.config
            # chunk_ms real: frames leidos por vez sobre la tasa del stream
            # (puede diferir de 16 kHz si el dispositivo abrio nativo).
            chunk_ms = 1000.0 * capture.chunk_size / max(1, capture.stream_rate_hz)
            # Gate adaptativo sembrado desde la calibracion de arranque
            # (semilla post-gain; sin calibracion equivale al defecto).
            try:
                _noise_seed = capture.endpoint_noise_seed
            except Exception:
                _noise_seed = None
            endpoint = SpeechEndpoint(
                silence_ms=cfg.stt_silence_ms,
                min_speech_ms=cfg.stt_min_speech_ms,
                max_turn_ms=cfg.stt_max_turn_ms,
                rms_threshold=cfg.stt_rms_threshold,
                noise_floor=_noise_seed,
            )
            if capture.is_blocking:
                wake_to_start_ms = int((time.monotonic() - self._turn_wake_ts) * 1000)
                print(
                    f"[voice-debug] stt-blocking-read-start turn={turn_id} "
                    f"wake_to_stt_start_ms={wake_to_start_ms}",
                    flush=True,
                )
            # Preroll: se alimenta UNA vez y en orden, sin endpointing
            # (ahi dentro vive el audio del wake word). Todo el cuerpo del
            # turno corre bajo este try: cualquier excepcion publica None y
            # finaliza por el camino unico (cierra stream, consume, restart).
            try:
                try:
                    preroll = capture.get_preroll()
                except Exception:
                    preroll = b""
                try:
                    capture.clear_preroll()
                except Exception:
                    pass
                if preroll:
                    print(f"[voice-debug] stt-preroll-feed turn={turn_id} bytes={len(preroll)}", flush=True)
                    step = max(1024, capture.chunk_size * 2)
                    for offset in range(0, len(preroll), step):
                        recognizer.AcceptWaveform(preroll[offset:offset + step])
                turn_start = time.monotonic()
                max_turn_s = cfg.stt_max_turn_ms / 1000.0 + 2.0
                first_chunk = True
                accept_probed = False
                first_partial_logged = False
                last_partial_text = ""
                last_partial_emit = 0.0
                last_endpoint_sample = 0.0
                chunks_processed = 0
                # Metricas de senal del turno (sobre chunks post-gain, lo que
                # Vosk escucha): min/max/avg + voz (rms >= gate adaptativo) +
                # piso de ruido (min) + picos (para health). Sin PII: solo
                # energia, nunca audio. Listas acotadas al turno (max_turn).
                sig_min = 1.0
                sig_max = 0.0
                sig_sum = 0.0
                speech_sum = 0.0
                speech_count = 0
                rms_list: list = []
                peak_list: list = []
                # FASE 2: timings de habla (ms desde turn_start, monotonico).
                speech_start_ms = -1
                speech_end_ms = -1
                # FASE 1: rachas de reads fallidos (None = excepcion de read).
                # Un stream muerto (unplug) falla SIEMPRE: con 25 seguidos se
                # declara stream-dead y se va a recovery en vez de girar 14 s
                # hasta el wall. Glitches aislados se toleran (resetea).
                chunk_misses = 0
                stream_dead = False
                wav_frames: Optional[list] = [] if _STT_DEBUG_WAV else None
                while self._voice_state == VoiceState.LISTENING:
                    chunk = capture.get_chunk(timeout=0.1)
                    if chunk is None:
                        chunk_misses += 1
                        if chunk_misses >= 25:
                            print(
                                f"[voice-debug] stt-stream-dead turn={turn_id} "
                                f"misses={chunk_misses} device={capture._valid_input_index}",
                                flush=True,
                            )
                            stream_dead = True
                            break
                        if time.monotonic() - turn_start > max_turn_s:
                            print(
                                f"[voice-debug] endpoint-trigger reason=max_turn_wall "
                                f"elapsed_ms={int((time.monotonic() - turn_start) * 1000)}",
                                flush=True,
                            )
                            break
                        try:
                            time.sleep(0.02)
                        except Exception:
                            pass
                        continue
                    chunk_misses = 0
                    if first_chunk:
                        first_chunk = False
                        print("[voice-debug] stt-blocking-read-ready", flush=True)
                    if not accept_probed:
                        accept_probed = True
                        _vlog(f"vosk-accept-start thread={tid} recognizer-id={id(recognizer):x} data-bytes={len(chunk)}")
                        accepted = recognizer.AcceptWaveform(chunk)
                        _vlog(f"vosk-accept-end result={accepted} thread={tid}")
                    else:
                        recognizer.AcceptWaveform(chunk)
                    rms = compute_rms(chunk)
                    now = time.monotonic()
                    chunks_processed += 1
                    sig_min = rms if rms < sig_min else sig_min
                    sig_max = rms if rms > sig_max else sig_max
                    sig_sum += rms
                    if len(rms_list) < 2000:
                        rms_list.append(rms)
                        peak_list.append(peak_of_pcm(chunk))
                    if rms >= endpoint.gate:
                        speech_sum += rms
                        speech_count += 1
                    if wav_frames is not None:
                        wav_frames.append(chunk)
                    _dlog(
                        f"endpoint-update rms={rms:.4f} "
                        f"speech_ms={int(endpoint.speech_ms)} "
                        f"silence_ms={int(endpoint.quiet_ms)} "
                        f"bar={endpoint.silence_bar:.4f}"
                    )
                    if now - last_endpoint_sample >= 1.0:
                        last_endpoint_sample = now
                        print(
                            f"[voice-debug] endpoint-update rms={rms:.4f} "
                            f"speech_ms={int(endpoint.speech_ms)} "
                            f"silence_ms={int(endpoint.quiet_ms)}",
                            flush=True,
                        )
                    if now - last_partial_emit >= 0.15:
                        try:
                            partial = json.loads(recognizer.PartialResult()).get("partial", "").strip()
                        except Exception:
                            partial = ""
                        if partial and partial != last_partial_text:
                            last_partial_text = partial
                            last_partial_emit = now
                            elapsed_ms = int((now - turn_start) * 1000)
                            if not first_partial_logged:
                                first_partial_logged = True
                                print(f'[voice-debug] stt-first-partial turn={turn_id} ms={elapsed_ms} text="{partial}"', flush=True)
                            else:
                                _dlog(f'stt-partial turn={turn_id} text="{partial}"')
                            self._emit_json({"type": "stt_partial", "text": partial, "turn_id": turn_id})
                    ended = endpoint.update(rms, chunk_ms)
                    if endpoint.speech_started:
                        _elapsed_ms = int((now - turn_start) * 1000)
                        if speech_start_ms < 0:
                            speech_start_ms = _elapsed_ms
                        if rms >= endpoint.silence_bar:
                            speech_end_ms = _elapsed_ms
                    if ended:
                        print(
                            f"[voice-debug] endpoint-trigger reason={endpoint.end_reason} "
                            f"elapsed_ms={int(endpoint.elapsed_ms)}",
                            flush=True,
                        )
                        print(f"[voice-debug] stt-endpoint turn={turn_id} reason={endpoint.end_reason}", flush=True)
                        break
                    if time.monotonic() - turn_start > max_turn_s:
                        print(
                            f"[voice-debug] endpoint-trigger reason=max_turn_wall "
                            f"elapsed_ms={int((time.monotonic() - turn_start) * 1000)}",
                            flush=True,
                        )
                        print(f"[voice-debug] stt-endpoint turn={turn_id} reason=max_turn_wall", flush=True)
                        break
                _vlog(f"stt-worker-exit thread={tid}")
                with self._stt_vosk_lifecycle_lock:
                    try:
                        final_text = json.loads(recognizer.FinalResult()).get("text", "").strip()
                    except Exception as e:
                        print(f"[sidecar] STT final error: {e}", flush=True)
                        final_text = ""
                stt_duration_ms = int((time.monotonic() - turn_start) * 1000)
                audio_ms = int(chunks_processed * chunk_ms)
                self._turn_final_ts = time.monotonic()
                sig_avg = sig_sum / chunks_processed if chunks_processed else 0.0
                speech_rms = speech_sum / speech_count if speech_count else 0.0
                # FASE 4: timings exactos lado sidecar (speech_end es el
                # origen perceptual; dispatch_ms se suma al publicar).
                wake_to_stt_ms = int((turn_start - self._turn_wake_ts) * 1000) if self._turn_wake_ts else -1
                speech_to_end_ms = (stt_duration_ms - speech_end_ms) if speech_end_ms >= 0 else -1
                print(
                    f"[voice-debug] voice-turn-timing turn={turn_id} generation={generation} "
                    f"wake_to_stt_start_ms={wake_to_stt_ms} speech_start_ms={speech_start_ms} "
                    f"speech_end_ms={speech_end_ms} speech_to_turn_end_ms={speech_to_end_ms} "
                    f"stt_duration_ms={stt_duration_ms} audio_ms={audio_ms}",
                    flush=True,
                )
                print(
                    f"[voice-debug] stt-signal-summary turn={turn_id} "
                    f"rms_min={sig_min:.6f} rms_max={sig_max:.6f} rms_avg={sig_avg:.6f} "
                    f"speech_rms={speech_rms:.6f} speech_chunks={speech_count}/{chunks_processed} "
                    f"speech_start_ms={speech_start_ms} speech_end_ms={speech_end_ms} "
                    f"noise_floor={sig_min:.6f} device={capture._valid_input_index} "
                    f"native_rate={capture.stream_rate_hz} stt_rate={capture.sample_rate}",
                    flush=True,
                )
                # Health score del turno (producto): signal/noise/snr/pico/
                # clip/ganancia/endpoint/tasas/calidad. Si la calidad es mala
                # (sin habla sostenida o SNR inutil), NO se despacha basura:
                # se publica None y se loguea mic-signal-too-low con numeros.
                try:
                    _agc_stats = capture.agc_stats
                except Exception:
                    _agc_stats = {}
                _ep_reason = endpoint.end_reason
                if not _ep_reason and time.monotonic() - turn_start > max_turn_s - 2.0:
                    _ep_reason = "max_turn_wall"
                health = compute_turn_health(
                    rms_list=rms_list,
                    peak_list=peak_list,
                    gain_avg=float(_agc_stats.get("gain_avg", 1.0)),
                    gate=endpoint.gate,
                    noise_floor=endpoint.noise_floor,
                    speech_started=endpoint.speech_started,
                    speech_ms=endpoint.speech_ms,
                    endpoint_reason=_ep_reason,
                    native_rate=capture.stream_rate_hz,
                    stt_rate=capture.sample_rate,
                    transcript_chars=len(final_text),
                )
                print(
                    f"[voice-debug] stt-health turn={turn_id} "
                    f"signal_rms={health['signal_rms']:.6f} noise_rms={health['noise_rms']:.6f} "
                    f"snr_db={health['snr_db']:.1f} peak={health['peak']:.4f} "
                    f"clipping_ratio={health['clipping_ratio']:.4f} gain_applied={health['gain_applied']:.2f} "
                    f"endpoint={health['endpoint']} sample_rate={health['sample_rate']} "
                    f"quality={health['quality']}",
                    flush=True,
                )
                if health["quality"] == "bad":
                    if final_text:
                        print(
                            f"[voice-debug] stt-garbage-suppressed turn={turn_id} "
                            f"chars={len(final_text)} (senial inutil; no se despacha)",
                            flush=True,
                        )
                        final_text = ""
                    print(
                        f"[voice-debug] mic-signal-too-low turn={turn_id} "
                        f"signal_rms={health['signal_rms']:.6f} noise_rms={health['noise_rms']:.6f} "
                        f"snr_db={health['snr_db']:.1f} speech_started={endpoint.speech_started} "
                        f"speech_ms={int(endpoint.speech_ms)} device={capture._valid_input_index} "
                        f"(voz bajo minimo util; revise boom del mic/distancia/niveles)",
                        flush=True,
                    )
                    self._audio_bad_turns += 1
                    if self._audio_bad_turns >= 2:
                        self._note_device_state("bad", reason="bad-turns>=2")
                    try:
                        self._emit_json({
                            "type": "voice_input_health",
                            "turn_id": turn_id,
                            "quality": "bad",
                            "signal_rms": health["signal_rms"],
                            "snr_db": health["snr_db"],
                        })
                    except Exception:
                        pass
                elif health["quality"] == "degraded":
                    self._audio_bad_turns = 0
                    self._note_device_state("degraded", reason="turn-degraded")
                else:
                    self._audio_bad_turns = 0
                    self._note_device_state("good", reason="turn-good")
                if speech_count >= 5 and speech_rms > 0:
                    # Voz real observada: el endpoint aprende (historial por
                    # nombre+hostApi; la proxima seleccion lo prefiere) y se
                    # refina el rango de habla para la calibracion.
                    try:
                        norm_name, host_api = describe_input_endpoint(
                            capture._audio, capture._valid_input_index
                        )
                        if norm_name:
                            note_input_signal_quality(norm_name, host_api, speech_rms)
                            voiced_sorted = sorted(r for r in rms_list if r >= endpoint.gate)
                            if voiced_sorted:
                                p50 = voiced_sorted[len(voiced_sorted) // 2]
                                note_input_speech_stats(norm_name, host_api, p50, max(voiced_sorted))
                    except Exception:
                        pass
                if wav_frames:
                    try:
                        import tempfile
                        import wave as _wave
                        wav_path = os.path.join(
                            tempfile.gettempdir(), f"apollo-stt-turn-{turn_id}.wav"
                        )
                        with _wave.open(wav_path, "wb") as wf:
                            wf.setnchannels(1)
                            wf.setsampwidth(2)
                            wf.setframerate(capture.sample_rate)
                            wf.writeframes(b"".join(wav_frames))
                        print(f"[voice-debug] stt-turn-wav turn={turn_id} path={wav_path}", flush=True)
                    except Exception as e:
                        print(f"[voice-debug] stt-turn-wav-error turn={turn_id} err={e}", flush=True)
                if final_text:
                    print(f"[voice-debug] stt-final turn={turn_id} text_len={len(final_text)} stt_duration_ms={stt_duration_ms} chunks={chunks_processed} audio_ms={audio_ms}", flush=True)
                    self._publish_stt_result(turn_id, generation, final_text, speech_start_ms, speech_end_ms)
                else:
                    print(f"[voice-debug] stt-final turn={turn_id} empty stt_duration_ms={stt_duration_ms} chunks={chunks_processed} audio_ms={audio_ms}", flush=True)
                    self._publish_stt_result(turn_id, generation, None)
            except MemoryError:
                print("[sidecar] MemoryError during STT, resetting", flush=True)
                self._publish_stt_result(turn_id, generation, None)
                self._reset_voice_subsystem()
                return
            except Exception as e:
                print(f"[sidecar] STT worker error: {e}", flush=True)
                self._publish_stt_result(turn_id, generation, None)
            # Fin de generacion: el Recognizer muere en el owner ANTES de
            # finalizar (el Model persiste en el owner hasta el shutdown).
            if threading.get_ident() == (self._stt_owner_thread.ident if self._stt_owner_thread else None):
                self._destroy_stt_recognizer()
            if stream_dead:
                # El turno ya publico su resultado (posiblemente parcial); ahora
                # se recupera el dispositivo para el proximo turno/wake.
                self._recover_stt_capture(reason="stream-dead")
            self._finalize_listening()

    def _note_device_state(self, state: str, reason: str = "") -> None:
        """Estado sticky del input: good/degraded/bad/unavailable (FASE 1/7).

        Loguea SOLO transiciones. Si el input es malo no se manda basura
        (el quality gate ya suprime); en `bad` persistente se limpia el cache
        para forzar rescan en el proximo turno.
        """
        try:
            prev = self._audio_device_state
            self._audio_device_state = state
            if state != prev:
                device = -1
                try:
                    if self._audio_capture is not None:
                        device = self._audio_capture._valid_input_index
                except Exception:
                    pass
                print(
                    f"[voice-debug] audio-device-state state={state} prev={prev} "
                    f"device={device} reason={reason}",
                    flush=True,
                )
                if state == "bad":
                    try:
                        from .audio import clear_input_selection_cache
                        clear_input_selection_cache("device-bad")
                    except Exception:
                        pass
        except Exception:
            pass

    def _recover_stt_capture(self, reason: str) -> bool:
        """Recovery de captura: stop seguro -> rescan -> reselect -> reopen.

        Se llama desde el worker (sin reads en curso: el loop ya salio) o
        desde el thread de control en IDLE. Nunca duplica workers ni turnos:
        solo toca el AudioCapture. Devuelve True si reabrio.
        """
        capture = self._audio_capture
        if capture is None:
            return False
        try:
            old_index = capture._valid_input_index
        except Exception:
            old_index = -1
        print(
            f"[voice-debug] audio-recovery-start reason={reason} old_device={old_index}",
            flush=True,
        )
        try:
            capture.stop()
        except Exception as e:
            print(f"[voice-debug] audio-recovery-stop-err err={e}", flush=True)
        try:
            from .audio import clear_input_selection_cache
            clear_input_selection_cache(f"recovery-{reason}")
        except Exception:
            pass
        try:
            capture.start()
            print(
                f"[voice-debug] audio-recovery-ok device={capture._valid_input_index} "
                f"rate={capture.stream_rate_hz}",
                flush=True,
            )
            self._note_device_state("good", reason="recovery-ok")
            return True
        except Exception as e:
            print(f"[voice-debug] audio-recovery-failed err={e}", flush=True)
            self._note_device_state("unavailable", reason="recovery-failed")
            return False

    def _publish_stt_result(self, turn_id: str, generation: int, text: Optional[str],
                            speech_start_ms: int = -1, speech_end_ms: int = -1) -> None:
        """Publica el resultado del turno con su identidad (FASE 3).

        Envelope {turn_id, generation, ts, text}: el consume usa EXACTAMENTE
        este turn_id y nunca infiere el turno desde el estado mutable.
        text None/vacio = turno sin transcript (misma semantica que antes).
        """
        envelope = None
        if text and text.strip():
            envelope = {
                "turn_id": turn_id,
                "generation": generation,
                "ts": int(time.time() * 1000),
                "text": text.strip(),
                "speech_start_ms": speech_start_ms,
                "speech_end_ms": speech_end_ms,
            }
        try:
            self._stt_result_queue.put(envelope)
            self._stt_result_received.set()
        except Exception:
            pass

    def _consume_stt_result(self) -> None:
        """Main thread consumes the STT result from the worker.
        This is the SINGLE SOURCE OF TRUTH for transcripts.
        Called from _finalize_listening AFTER the turn is done (turn-done
        event: el owner ya salio del loop, sin reads en curso) and the
        stream was closed. No toca el stream ni el worker.
        Usa el turn_id del envelope publicado (FASE 3); compat hacia atras
        con items legacy (str/None) por si algun publicador viejo quedara.
        """
        item = None
        try:
            item = self._stt_result_queue.get(timeout=0.5)
        except Exception:
            pass

        if isinstance(item, dict):
            turn_id = str(item.get("turn_id") or "")
            transcript = str(item.get("text") or "")
            generation = int(item.get("generation") or 0)
            item_ts = int(item.get("ts") or 0)
            try:
                speech_start_ms = int(item.get("speech_start_ms", -1))
            except Exception:
                speech_start_ms = -1
            try:
                speech_end_ms = int(item.get("speech_end_ms", -1))
            except Exception:
                speech_end_ms = -1
        elif isinstance(item, str):
            turn_id = self._turn_id
            transcript = item
            generation = 0
            item_ts = 0
            speech_start_ms = -1
            speech_end_ms = -1
        else:
            turn_id = ""
            transcript = ""
            generation = 0
            item_ts = 0
            speech_start_ms = -1
            speech_end_ms = -1

        if transcript and transcript.strip():
            dispatch_ms = (
                int((time.monotonic() - self._turn_final_ts) * 1000)
                if self._turn_final_ts
                else -1
            )
            print(f'[voice-debug] stt-result="{transcript}"', flush=True)
            print(f"[voice-debug] voice-transcript=\"{transcript}\"", flush=True)
            print(f"[voice-debug] stt-dispatch turn={turn_id} stt_to_dispatch_ms={dispatch_ms}", flush=True)
            self._emit_json(build_voice_transcript_payload(
                transcript, turn_id, generation, item_ts, speech_start_ms, speech_end_ms))
        elif not transcript:
            print("[voice-debug] state=idle (empty transcript)", flush=True)
            self._emit_json({"type": "ui_state", "state": "idle"})

        print("[voice-debug] state=idle", flush=True)
        self._emit_json({"type": "ui_state", "state": "idle"})
        self._restart_wake_detector()

    def _stop_stt_worker(self) -> None:
        # Espera el FIN DEL TURNO, no la muerte del thread: el owner es
        # persistente (un join expiraria siempre 2s y luego cerraria el
        # stream con un read en curso -> 0xC0000005). Desde el propio owner
        # no se espera (el turno en curso es este).
        try:
            owner = self._stt_owner_thread
            if owner is not None and threading.get_ident() == owner.ident:
                return
        except Exception:
            pass
        try:
            self._stt_turn_done.wait(timeout=2.0)
        except Exception:
            pass
        if not self._stt_turn_done.is_set():
            # El owner sigue en un read (stream trabado): se cierra igual
            # (stop_stream primero, con gracia) y se loguea fuerte. El close
            # durante read en curso puede tirar 0xC0000005 en PortAudio.
            print("[voice-debug] stt-close-raced reason=turn-not-done (stream posiblemente trabado)", flush=True)
        worker = self._stt_worker_thread
        if worker is not None:
            try:
                if worker.is_alive() and threading.current_thread() is not worker:
                    worker.join(timeout=0.5)
            except Exception:
                pass
        self._stt_worker_thread = None

    def _finalize_listening(self) -> None:
        # Camino unico de fin de turno, seguro ante doble llamada
        # (timer vs worker-endpoint): solo el primero que cruza el gate actua.
        with self._finish_lock:
            if self._voice_state != VoiceState.LISTENING:
                return
            self._voice_state = VoiceState.IDLE
        self._cancel_listen_timer()

        # Orden estricto para modo blocking: primero sale el worker del loop
        # de stream.read(), se lo espera, y RECIEN ahi se cierra el stream
        # desde un lugar seguro. Nunca cerrar con un read() en curso.
        print("[voice-debug] stt-stop-requested", flush=True)
        self._stop_stt_worker()
        print("[voice-debug] stt-capture-stopping", flush=True)
        if self._audio_capture:
            try:
                self._audio_capture.stop()
            except Exception as e:
                print(f"[sidecar] audio capture stop error: {e}", flush=True)
        print("[voice-debug] stt-stream-close", flush=True)
        print("[voice-debug] stt-capture-stopped", flush=True)

        # Consume the STT result — single source of truth
        self._consume_stt_result()

    def _restart_wake_detector(self) -> None:
        with self._wake_lock:
            if not self._running:
                return
            if self._mic_muted or self._tts_playing:
                return
            if self._wake_detector:
                try:
                    self._wake_detector.stop()
                except Exception:
                    pass
                self._wake_detector = None
            try:
                self._wake_detector = create_wake_detector(
                    wake_words=self.config.wake_words,
                    model_dir=self.config.wake_model_dir,
                    prefer_vosk=self.config.use_vosk_wake,
                    on_detected=self._on_wake_detected,
                    pyaudio_instance=self._pyaudio,
                    input_device_name=self.config.input_device_name,
                )
                self._wake_detector.start()
            except Exception as e:
                print(f"[voice-debug] wake-restart-failed err={e}", flush=True)
                self._wake_detector = None
                self._schedule_wake_retry()
                return
            self._wake_retry_count = 0
            print("[voice-debug] wake-detector=restarted", flush=True)

    def _schedule_wake_retry(self) -> None:
        """Reintento acotado de wake (unplug/replug): 3 intentos (3s/10s/30s).

        Solo reintenta en IDLE sin detector (si algo mas recupero, no molesta).
        Despues agota con wake-unavailable (rescan manual via stdin lo revive).
        """
        try:
            count = getattr(self, "_wake_retry_count", 0)
            if count >= 3:
                print("[voice-debug] wake-unavailable reason=retries-exhausted", flush=True)
                return
            self._wake_retry_count = count + 1
            delay = (3.0, 10.0, 30.0)[min(count, 2)]
            print(
                f"[voice-debug] wake-retry-scheduled attempt={self._wake_retry_count} in_s={delay}",
                flush=True,
            )
            timer = threading.Timer(delay, self._wake_retry_fire)
            timer.daemon = True
            timer.start()
        except Exception:
            pass

    def _wake_retry_fire(self) -> None:
        try:
            if self._voice_state != VoiceState.IDLE:
                return
            if self._wake_detector is not None:
                self._wake_retry_count = 0
                return
            print("[voice-debug] wake-retry-fire", flush=True)
            self._restart_wake_detector()
        except Exception:
            pass

    def _destroy_stt_model(self) -> None:
        """Destruye el Model en el thread dueno (unico que puede tocarlo)."""
        tid = threading.get_ident()
        model = self._stt_model
        self._stt_model = None
        self._stt_model_owner_tid = None
        if model is None:
            return
        try:
            print(f"[voice-debug] stt-model-destroy-start thread={tid} id={id(model):x}", flush=True)
            del model
            print(f"[voice-debug] stt-model-destroy-end thread={tid}", flush=True)
        except Exception as e:
            print(f"[sidecar] STT model destroy error: {e}", flush=True)

    def _destroy_stt_recognizer(self) -> None:
        """Destruye el Recognizer en el thread dueno."""
        tid = threading.get_ident()
        rec = self._stt_recognizer
        self._stt_recognizer = None
        self._stt_recognizer_owner_tid = None
        if rec is None:
            return
        try:
            print(f"[voice-debug] stt-recognizer-destroy-start id={id(rec):x} thread={tid}", flush=True)
            del rec
            print(f"[voice-debug] stt-recognizer-destroy-end thread={tid}", flush=True)
        except Exception as e:
            print(f"[sidecar] STT recognizer destroy error: {e}", flush=True)

    def _ensure_stt_model(self) -> None:
        """Crea el Model Vosk SOLO en el worker persistente (afinidad nativa).

        Si lo invoca cualquier otro thread se RECHAZA (log + sin tocar nada):
        compartir el Model entre threads crashea con 0xC0000005 aunque el
        acceso este serializado. No hay path "reused" cross-thread.
        """
        tid = threading.get_ident()
        owner = self._stt_owner_thread
        if owner is None or tid != owner.ident:
            print(
                f"[voice-debug] stt-model-affinity-refused thread={tid} "
                f"(solo el owner puede crear el Model)",
                flush=True,
            )
            return
        if self._stt_model is not None:
            return
        from vosk import Model, SetLogLevel
        SetLogLevel(-1)
        model_dir = self.config.wake_model_dir or ""
        if not model_dir:
            model_dir = os.path.join(os.path.dirname(__file__), "models")
        model_path = None
        for name in ["vosk-model-small-es-0.42", "vosk-model-es-0.42"]:
            candidate = os.path.join(model_dir, name)
            if os.path.exists(candidate):
                model_path = candidate
                break
        if model_path is None:
            print("[sidecar] no Vosk model for STT", flush=True)
            return
        if os.name == "nt" and model_path.startswith("\\\\?\\"):
            model_path = model_path[4:]
        print(f"[voice-debug] stt-model-create-start thread={tid}", flush=True)
        self._stt_model = Model(model_path)
        self._stt_model_owner_tid = tid
        print(f"[voice-debug] stt-model-create-end stt-model-id={id(self._stt_model):x} thread={tid}", flush=True)
        print(f"[voice-debug] stt-model-owner-thread={tid}", flush=True)

    def _ensure_stt_recognizer(self) -> None:
        """Crea un recognizer NUEVO propiedad del worker persistente.

        SOLO el owner puede ejecutarlo. Verifica obligatoriamente que el
        thread dueno del Model == thread creador del Recognizer; si el Model
        viniera de otro thread (estado legado), se destruye y recrea aqui
        (self-heal) en vez de reutilizarlo cross-thread.
        """
        tid = threading.get_ident()
        owner = self._stt_owner_thread
        if owner is None or tid != owner.ident:
            print(
                f"[voice-debug] stt-recognizer-affinity-refused thread={tid} "
                "(solo el owner puede crear recognizers)",
                flush=True,
            )
            return
        from vosk import KaldiRecognizer
        with self._stt_vosk_lifecycle_lock:
            self._ensure_stt_model()
            if self._stt_model is None:
                print(f"[voice-debug] stt-recognizer-create-end no-model thread={tid}", flush=True)
                return
            if self._stt_model_owner_tid != tid:
                print(
                    f"[voice-debug] stt-affinity-mismatch model_thread={self._stt_model_owner_tid} "
                    f"recognizer_thread={tid} (heal: recrear Model en owner)",
                    flush=True,
                )
                self._destroy_stt_model()
                self._ensure_stt_model()
                if self._stt_model is None or self._stt_model_owner_tid != tid:
                    print(f"[voice-debug] stt-affinity-heal-failed thread={tid}", flush=True)
                    return
            print(
                f"[voice-debug] stt-affinity-check model_thread={self._stt_model_owner_tid} "
                f"recognizer_thread={tid} match=True",
                flush=True,
            )
            self._destroy_stt_recognizer()
            print(f"[voice-debug] stt-recognizer-create-start thread={tid} stt-model-id={id(self._stt_model):x}", flush=True)
            self._stt_recognizer = KaldiRecognizer(self._stt_model, 16000)
            self._stt_recognizer_owner_tid = tid
            print(f"[voice-debug] stt-recognizer-create-end thread={tid}", flush=True)
            print(f"[voice-debug] stt-worker-recognizer-new id={id(self._stt_recognizer):x} thread={tid}", flush=True)

    def handle_stdin_message(self, msg: dict) -> None:
        msg_type = msg.get("type", "")
        if msg_type == "action":
            action = msg.get("action", "")
            if action == "start_listening":
                self._on_wake_detected("manual")
            elif action == "stop_listening":
                self._finalize_listening()
            elif action == "set_mic_muted":
                muted = bool(msg.get("muted", False))
                self.set_mic_muted(muted)
                # Mute manual del usuario: sin barge-in (solo el TTS del
                # servidor lo permite).
                self._barge_allowed = not muted
            elif action == "set_tts_muted":
                self.set_tts_muted(bool(msg.get("muted", False)))
        elif msg_type == "tts_audio":
            data_b64 = msg.get("data", "")
            if data_b64 and self._audio_playback and not self._audio_playback_disabled:
                import base64
                try:
                    if time.monotonic() < self._ignore_tts_audio_until:
                        # Audio en vuelo post-barge: se descarta, no se reencola.
                        self._ignore_tts_dropped += 1
                        if self._ignore_tts_dropped == 1:
                            print("[voice-debug] tts-audio-ignored reason=barge-in-flight", flush=True)
                    else:
                        pcm_bytes = base64.b64decode(data_b64)
                        rms = 0.0
                        try:
                            import numpy as _np
                            _samples = _np.frombuffer(pcm_bytes, dtype=_np.int16).astype(_np.float32) / 32768.0
                            rms = float(_np.sqrt(_np.mean(_samples ** 2)))
                        except Exception:
                            pass
                        try:
                            self._played_recent.append((time.monotonic(), rms))
                        except Exception:
                            pass
                        _dlog(f"python-tts-frame bytes={len(pcm_bytes)} rms={rms:.6f}")
                        self._audio_playback.write(pcm_bytes)
                        _dlog(f"playback-bytes={len(pcm_bytes)}")
                        _dlog(f"echo-check rms={rms:.6f}")
                except Exception as e:
                    print(f"[sidecar] TTS audio decode error: {e}", flush=True)
        elif msg_type == "tts_start":
            print("[voice-debug] tts-start", flush=True)
            # tts_start llega POR SEGMENTO: solo se purga si el utterance
            # anterior ya cerro (tts_end/aborted). Si sigue abierto, es el
            # segmento siguiente del mismo turno y la cola debe drenar.
            try:
                if not getattr(self, "_tts_utterance_open", False):
                    if self._audio_playback is not None:
                        self._audio_playback.purge()
            except Exception:
                pass
            self._tts_utterance_open = True
            self._tts_playing = True
            self._barge_allowed = True
            if not self._tts_muted:
                self.set_mic_muted(True)
            self._start_barge_monitor()
        elif msg_type == "tts_end":
            print("[voice-debug] tts-end", flush=True)
            self._tts_utterance_open = False
            self._stop_barge_monitor()
            self._tts_playing = False
            self.set_mic_muted(False)
        elif msg_type == "tts_aborted":
            print("[voice-debug] tts-aborted", flush=True)
            self._tts_utterance_open = False
            self._stop_barge_monitor()
            try:
                if self._audio_playback is not None:
                    self._audio_playback.purge()
            except Exception:
                pass
            self._tts_playing = False
            self.set_mic_muted(False)
        elif msg_type == "text_response":
            text = msg.get("text", "")
            print(f"[voice-debug] response-end len={len(text)}", flush=True)
        elif msg_type == "diagnostic_stt":
            duration = float(msg.get("duration", 5.0))
            device_index = int(msg.get("device_index", -1))
            print(
                "[voice-debug] diagnostic_stt duration=" + str(duration) +
                " device=" + str(device_index),
                flush=True,
            )
            diagnostic_callback_test(
                duration_seconds=duration,
                device_index=device_index,
            )
            print("[voice-debug] diagnostic_stt done", flush=True)
        elif msg_type == "input_device_select":
            device_name = msg.get("device_name") or msg.get("name")
            if device_name:
                self.config.input_device_name = device_name
                if self._audio_capture:
                    self._audio_capture._input_device_name = device_name
                persist_device_preference("input", device_name, self._audio_capture._valid_input_index)
            if self._audio_capture:
                idx = self._audio_capture._valid_input_index
                print(
                    "[voice-debug] input-device-selected index=" + str(idx),
                    flush=True,
                )
        elif msg_type == "input_device_rescan":
            from .audio import clear_input_selection_cache
            reason = msg.get("reason", "manual")
            print(f"[voice-debug] input-device-rescan requested reason={reason}", flush=True)
            clear_input_selection_cache(reason)
            self._restart_wake_detector()
            print("[voice-debug] input-device-rescan done", flush=True)
        elif msg_type == "output_device_select":
            device_name = msg.get("device_name") or msg.get("name")
            if device_name:
                self.config.output_device_name = device_name
                if self._audio_playback:
                    self._audio_playback._output_device_name = device_name
                persist_device_preference("output", device_name, self._audio_playback._valid_output_index)
            if self._audio_playback:
                idx = self._audio_playback._valid_output_index
                print(
                    "[voice-debug] output-device-selected index=" + str(idx),
                    flush=True,
                )
        elif msg_type == "output_device_rescan":
            reason = msg.get("reason", "manual")
            print(f"[voice-debug] output-device-rescan requested reason={reason}", flush=True)
            self._restart_playback(reason)
            print("[voice-debug] output-device-rescan done", flush=True)

    def _start_barge_monitor(self) -> None:
        """Arranca el monitor de barge-in (solo IDLE + playback + permitido).

        Un solo monitor a la vez; abre su propio stream de input (el STT esta
        detenido en este punto). Si no abre, no hay barge (graceful).
        """
        try:
            if not self._barge_enabled or not self._barge_allowed:
                return
            if self._voice_state != VoiceState.IDLE:
                return
            if not self._stt_turn_done.is_set():
                return
            old = self._barge_thread
            if old is not None and old.is_alive():
                return
            from .audio import find_best_input_device
            audio = self._pyaudio
            idx, name, ch, rate, _alt = find_best_input_device(
                audio,
                preferred_name=self.config.input_device_name,
                sample_rate=16000,
                use_cache=True,
                try_native_rates=True,
            )
            if idx < 0:
                print("[voice-debug] barge-monitor-unavailable reason=no-device", flush=True)
                return
            stream = audio.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=rate,
                input=True,
                frames_per_buffer=512,
                input_device_index=idx,
            )
            stream.start_stream()
        except Exception as e:
            print(f"[voice-debug] barge-monitor-unavailable err={e}", flush=True)
            return
        self._barge_stop.clear()
        self._barge_t0 = time.monotonic()
        thread = threading.Thread(
            target=self._barge_monitor_loop,
            args=(stream, idx, rate),
            daemon=True,
        )
        self._barge_thread = thread
        thread.start()
        print(
            f"[voice-debug] barge-monitor-start device={idx} rate={rate}",
            flush=True,
        )

    def _stop_barge_monitor(self) -> None:
        try:
            self._barge_stop.set()
        except Exception:
            pass
        thread = self._barge_thread
        self._barge_thread = None
        if thread is not None and thread.is_alive():
            try:
                thread.join(timeout=1.0)
            except Exception:
                pass

    def _barge_monitor_loop(self, stream, device_index: int, rate: int) -> None:
        """Lee el mic durante playback; voz sostenida sobre el bleed = barge."""
        from .audio import BargeDetector
        detector = BargeDetector()
        chunk_ms = 1000.0 * 512 / max(1, rate)
        try:
            while not self._barge_stop.is_set():
                if self._voice_state != VoiceState.IDLE or not self._tts_playing:
                    break
                try:
                    data = stream.read(512, exception_on_overflow=False)
                except Exception:
                    break
                if not isinstance(data, (bytes, bytearray)) or len(data) < 4:
                    continue
                rms = compute_rms(data)
                # Referencia de eco: energia maxima emitida hace 100-300 ms
                # (retardo salida + mic). Sin datos, 0 (solo rige el gate).
                played_ref = 0.0
                try:
                    now = time.monotonic()
                    for ts, energy in reversed(self._played_recent):
                        if ts < now - 0.3:
                            break
                        if ts <= now - 0.1 and energy > played_ref:
                            played_ref = energy
                except Exception:
                    played_ref = 0.0
                if detector.update(rms, chunk_ms, played_ref):
                    self._on_barge_detected(rms, detector.gate)
                    break
        except Exception as e:
            print(f"[voice-debug] barge-monitor-error err={e}", flush=True)
        finally:
            try:
                stream.stop_stream()
            except Exception:
                pass
            try:
                stream.close()
            except Exception:
                pass

    def _on_barge_detected(self, rms: float, gate: float) -> None:
        """Usuario hablo durante TTS: parar audio, abortar, empezar STT."""
        try:
            t0 = time.monotonic()
            detect_ms = int((t0 - self._barge_t0) * 1000) if self._barge_t0 else -1
            print(
                f"[voice-debug] barge_in_detected rms={rms:.4f} gate={gate:.4f} "
                f"tts_elapsed_ms={detect_ms}",
                flush=True,
            )
            self._stop_barge_monitor()
            purged = 0
            try:
                if self._audio_playback is not None:
                    purged = self._audio_playback.purge() or 0
            except Exception:
                pass
            audio_stop_ms = int((time.monotonic() - t0) * 1000)
            print(
                f"[voice-debug] barge_in_to_audio_stop_ms={audio_stop_ms} purged={purged}",
                flush=True,
            )
            # El servidor sigue enviando lo ya sintetizado (~1-2 s en vuelo):
            # se ignora para no reencolar audio abortado.
            self._ignore_tts_audio_until = time.monotonic() + 2.0
            self._ignore_tts_dropped = 0
            self._emit_json({
                "type": "barge_in",
                "tts_elapsed_ms": detect_ms,
                "rms": round(rms, 4),
            })
            self._tts_playing = False
            self._tts_utterance_open = False
            self.set_mic_muted(False)
            self._on_wake_detected("barge")
        except Exception as e:
            print(f"[sidecar] barge error: {e}", flush=True)

    def _on_playback_end(self) -> None:
        self._tts_playing = False

    def _restart_playback(self, reason: str = "") -> bool:
        """Reinicia el playback: stop seguro -> reselect -> reopen.

        Solo desde threads de control/stdin (nunca desde el callback de
        PortAudio). Devuelve True si reabrio.
        """
        pb = self._audio_playback
        if pb is None:
            return False
        print(f"[voice-debug] playback-restart-start reason={reason}", flush=True)
        try:
            pb.stop()
        except Exception as e:
            print(f"[voice-debug] playback-restart-stop-err err={e}", flush=True)
        try:
            # find_best_output_device re-escanea en cada start (sin cache).
            pb.start(on_end=self._on_playback_end)
            print("[voice-debug] playback-restart-ok", flush=True)
            return True
        except Exception as e:
            print(f"[voice-debug] playback-restart-failed err={e}", flush=True)
            return False

    def set_mic_muted(self, muted: bool) -> None:
        self._mic_muted = muted
        if muted:
            if self._voice_state == VoiceState.LISTENING:
                self._finalize_listening()
            with self._wake_lock:
                if self._wake_detector:
                    try:
                        self._wake_detector.stop()
                    except Exception:
                        pass
        else:
            if not self._tts_playing:
                self._restart_wake_detector()

    def set_tts_muted(self, muted: bool) -> None:
        self._tts_muted = muted

    def _start_stdin_listener(self) -> None:
        if self._stdin_thread is not None and self._stdin_thread.is_alive():
            return
        self._stdin_thread = threading.Thread(target=self._stdin_loop, daemon=True)
        self._stdin_thread.start()

    def _stdin_loop(self) -> None:
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except (json.JSONDecodeError, AttributeError):
                    continue
                self.handle_stdin_message(payload)
        except Exception:
            pass

    def run(self) -> None:
        self.start()
        try:
            while self._running:
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
        except Exception as e:
            print(f"[sidecar] run error: {e}", flush=True)
        finally:
            self.stop()


def main():
    import os
    from dotenv import load_dotenv
    load_dotenv()

    def _env_float(name: str, default: float) -> float:
        try:
            return float(os.getenv(name, str(default)))
        except (TypeError, ValueError):
            return default

    config = JuanaConfig(
        device_shared_secret=os.getenv("DEVICE_SHARED_SECRET", ""),
        wake_words=os.getenv("WAKE_WORDS", "apollo,hey apollo").split(","),
        use_vosk_wake=os.getenv("USE_VOSK_WAKE", "true").lower() not in ("false", "0", "no"),
        wake_model_dir=os.getenv("WAKE_MODEL_DIR"),
        input_device_name=os.getenv("INPUT_DEVICE_NAME", "Micrófono (JBL Quantum 300)"),
        output_device_name=os.getenv("OUTPUT_DEVICE_NAME", "JBL Quantum 300"),
        stt_chunk_ms=_env_float("STT_CHUNK_MS", 40.0),
        stt_silence_ms=_env_float("STT_SILENCE_MS", 600.0),
        stt_min_speech_ms=_env_float("STT_MIN_SPEECH_MS", 250.0),
        stt_max_turn_ms=_env_float("STT_MAX_TURN_MS", 12000.0),
        # Umbral en dominio post-gain: piso de sala medido ~2e-6, voz debil
        # real ~0.01-0.05. La puerta de 250 ms sostenidos evita disparos por
        # ruidos impulsivos; el endpoint relativo maneja pisos ruidosos.
        stt_rms_threshold=_env_float("STT_RMS_THRESHOLD", 0.012),
    )
    client = JuanaClient(config)
    client.run()


if __name__ == "__main__":
    main()
