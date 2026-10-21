"""Wake word detection for Apollo using Vosk (offline, no account needed)."""

import difflib
import json
import math
import os
import re
import struct
import threading
import time
import uuid
from typing import Callable, Optional

import pyaudio
import numpy as np
from vosk import KaldiRecognizer, Model, SetLogLevel

from .audio import (
    find_best_input_device,
    find_device_by_name,
    persist_device_preference,
    load_device_preference,
    get_preferred_device_name,
    validate_capture_signal,
    clear_input_selection_cache,
)

SetLogLevel(-1)  # Suppress Vosk logs

# Verbosidad completa solo con APOLLO_SIDECAR_DEBUG=1 (igual que client.py).
_WAKE_DEBUG = os.getenv("APOLLO_SIDECAR_DEBUG", "0") == "1"


def _dlog(msg: str) -> None:
    if not _WAKE_DEBUG:
        return
    try:
        print(f"[voice-debug] {msg}", flush=True)
    except OSError:
        pass


# Cache de Model Vosk por ruta: se carga UNA vez por proceso y se reutiliza
# en cada restart del wake detector. Evita/native-teardown repetido (sospecha
# del crash del 3er ciclo) y baja latencia/RAM. Solo el Model se comparte;
# cada detector crea su propio KaldiRecognizer (igual que antes).
_wake_model_cache: dict = {}
_wake_model_cache_lock = threading.Lock()


def get_shared_wake_model(model_path: str) -> Model:
    with _wake_model_cache_lock:
        cached = _wake_model_cache.get(model_path)
        if cached is not None:
            _vlog(f"wake-model-reused path={os.path.basename(model_path)}")
            return cached
        _vlog(f"wake-model-load path={os.path.basename(model_path)}")
        loaded = Model(model_path)
        _wake_model_cache[model_path] = loaded
        return loaded


def _log(msg: str) -> None:
    try:
        print(f"[WAKE] {msg}", flush=True)
    except OSError:
        pass


def _vlog(msg: str) -> None:
    try:
        print(f"[voice-debug] {msg}", flush=True)
    except OSError:
        pass


def _compute_rms_peak(pcm_data: bytes) -> tuple[float, float]:
    if len(pcm_data) < 2:
        return 0.0, 0.0
    sample_count = len(pcm_data) // 2
    samples = struct.unpack(f'<{sample_count}h', pcm_data[:sample_count * 2])
    max_abs = 0
    sum_sq = 0.0
    for s in samples:
        a = abs(s)
        if a > max_abs:
            max_abs = a
        sum_sq += float(s * s)
    rms = math.sqrt(sum_sq / sample_count) / 32768.0
    peak = max_abs / 32768.0
    return rms, peak


def _list_audio_devices(audio: pyaudio.PyAudio) -> list[dict]:
    devices = []
    for i in range(audio.get_device_count()):
        info = audio.get_device_info_by_index(i)
        if info.get('maxInputChannels', 0) > 0:
            devices.append({
                'index': i,
                'name': info.get('name', 'unknown'),
                'channels': info.get('maxInputChannels', 0),
                'rate': int(info.get('defaultSampleRate', 0)),
            })
    return devices


class VoskWakeWordDetector:
    """Wake word detector using Vosk speech recognition.

    Lifecycle states (internal):
      RUNNING   — stream is open, callbacks are active
      STOPPING  — stop() was called, waiting for callback to finish
      STOPPED   — fully stopped, no stream, no callbacks

    stop() is idempotent: calling it multiple times is safe.
    """

    _STATE_RUNNING = "RUNNING"
    _STATE_STOPPING = "STOPPING"
    _STATE_STOPPED = "STOPPED"

    def __init__(
        self,
        model_path: str,
        wake_words: list[str],
        sample_rate: int = 16000,
        sensitivity: float = 0.5,
        on_detected: Optional[Callable[[str], None]] = None,
        pyaudio_instance: Optional[pyaudio.PyAudio] = None,
        input_device_name: str = "Micrófono (JBL Quantum 300)",
        input_device_index: int = -1,
    ):
        if os.name == 'nt' and model_path.startswith('\\\\?\\'):
            model_path = model_path[4:]

        if not os.path.exists(model_path):
            raise FileNotFoundError(f"Vosk model not found at: {model_path}")

        self.model = get_shared_wake_model(model_path)
        self.recognizer = KaldiRecognizer(self.model, sample_rate)
        _vlog(f"wake-model-ref id={id(self.model):x} recognizer-id={id(self.recognizer):x} thread={threading.get_ident()}")
        self.wake_words = [w.lower() for w in wake_words]
        self.sensitivity = sensitivity
        self.on_detected = on_detected

        self.sample_rate = sample_rate
        self.chunk_size = 4000
        self._owns_pyaudio = pyaudio_instance is None
        self._audio = pyaudio_instance or pyaudio.PyAudio()
        self._stream: Optional[pyaudio.Stream] = None
        self._callback_done = threading.Event()
        self._callback_done.set()
        self._callback_ack = threading.Event()
        self._callback_ack.set()

        # Lifecycle state machine
        self._state = self._STATE_STOPPED
        self._state_lock = threading.Lock()

        # Cooldown between detections
        self._last_detection_time = 0.0
        self._cooldown = 3.0

        # Diagnostics counters
        self._total_bytes = 0
        self._callback_count = 0
        self._level_log_interval = 2.0
        self._last_level_log_time = 0.0

        # Device selection & RMS validation
        self.input_device_name = get_preferred_device_name("input", input_device_name)
        self.input_device_index = input_device_index
        self._input_channels = 1
        self._alternatives = []
        self._validation_start_time = 0.0
        self._max_observed_rms = 0.0
        self._device_validated = False
        self._validation_window = 5.0
        self._silence_threshold = 0.0001
        self._fallback_attempts = 0
        self._max_fallback_attempts = 3
        self._switch_lock = threading.Lock()
        self._silence_threshold = 0.0001
        self._fallback_attempts = 0
        self._max_fallback_attempts = 3
        # Historial RMS para veredicto de señal + un unico auto-rescan por vida
        # del detector si la entrada resulta permanentemente en cero.
        self._rms_history: list = []
        self._auto_rescan_done = False

        # Identity logs
        self._wake_id = uuid.uuid4().hex[:8]
        self._recognizer_id = uuid.uuid4().hex[:8]
        _vlog(f"wake-open id={self._wake_id} recognizer-id={self._recognizer_id} thread={threading.get_ident()}")

        _log(f"Wake word detector inicializado: Vosk (modelo={os.path.basename(model_path)}, words={self.wake_words})")

    def start(self) -> None:
        with self._state_lock:
            if self._state != self._STATE_STOPPED:
                _vlog(f"wake-detector=start-noop reason=already-running state={self._state}")
                return
            self._state = self._STATE_RUNNING
            # The callback is quiescent until PortAudio enters it. Clearing
            # this here made stop() wait for a callback that might not exist.
            self._callback_done.set()
            self._callback_ack.set()

        self._total_bytes = 0
        self._callback_count = 0
        self._last_level_log_time = time.time()
        self._max_observed_rms = 0.0
        self._device_validated = False
        self._validation_start_time = 0.0
        self._fallback_attempts = 0
        self._rms_history = []

        _vlog(f"wake-start id={self._wake_id} thread={threading.get_ident()} state=RUNNING")

        try:
            pref_name = get_preferred_device_name("input", self.input_device_name)
            name_matches = find_device_by_name(self._audio, pref_name, is_input=True) if pref_name else []

            if self.input_device_index >= 0:
                dev_idx = self.input_device_index
                try:
                    dev_name = self._audio.get_device_info_by_index(dev_idx).get('name', '')
                except Exception:
                    dev_name = ''
                ch = 1
                alternatives = []
                _vlog(f"selected-input-device index={dev_idx}")
                _vlog(f"selected-input-device-name=\"{dev_name}\"")
            else:
                dev_idx, dev_name, ch, _working_rate, alternatives = find_best_input_device(
                    self._audio,
                    preferred_name=pref_name,
                    sample_rate=self.sample_rate,
                )

            if dev_idx < 0:
                _vlog("stream-opened=failed: no valid physical input device")
                with self._state_lock:
                    self._state = self._STATE_STOPPED
                self._callback_done.set()
                return

            persist_device_preference("input", dev_name, dev_idx)

            self._input_device_index = dev_idx
            self._input_device_name = dev_name
            self._input_channels = ch
            self._alternatives = alternatives

            self._stream = self._audio.open(
                format=pyaudio.paInt16,
                channels=ch,
                rate=self.sample_rate,
                input=True,
                frames_per_buffer=self.chunk_size,
                stream_callback=self._audio_callback,
                input_device_index=dev_idx,
            )
            self._stream.start_stream()
            self._validation_start_time = time.time()
            _vlog("stream-opened=true")
            _vlog(f"sample-rate={self.sample_rate}")
            _vlog(f"channels={ch}")
            _vlog(f"chunk-size={self.chunk_size}")
            _vlog(f"configured-wake-words={json.dumps(self.wake_words)}")
            _vlog("state=idle")
            _vlog(f"wake-stream-open id={self._wake_id} stream-id={id(self._stream):x} thread={threading.get_ident()}")
        except Exception as e:
            _vlog(f"stream-opened=error ({e})")
            with self._state_lock:
                self._state = self._STATE_STOPPED
            self._callback_done.set()

    def _switch_input_device(self, cand: dict) -> None:
        """Switch to next candidate if previous device was completely silent.
        
        Uses _switch_lock to prevent concurrent switches.
        Only switches if device is completely silent AND another candidate exists
        AND fallback attempts haven't exceeded the maximum.
        """
        with self._switch_lock:
            with self._state_lock:
                if self._state != self._STATE_RUNNING:
                    return
                if self._fallback_attempts >= self._max_fallback_attempts:
                    _vlog("input-device-fallback-limit-reached max={}".format(self._max_fallback_attempts))
                    return

        try:
            if self._stream:
                try:
                    self._stream.stop_stream()
                    self._stream.close()
                except Exception:
                    pass
                self._stream = None

            idx = cand['index']
            name = cand['name']
            ch = cand.get('workingChannels', 1)
            _vlog(f"selected-input-device index={idx}")
            _vlog(f"selected-input-device-name=\"{name}\"")
            self._input_device_index = idx
            self._input_device_name = name
            self._input_channels = ch

            self._stream = self._audio.open(
                format=pyaudio.paInt16,
                channels=ch,
                rate=self.sample_rate,
                input=True,
                frames_per_buffer=self.chunk_size,
                stream_callback=self._audio_callback,
                input_device_index=idx,
            )
            self._stream.start_stream()
            self._validation_start_time = time.time()
            self._max_observed_rms = 0.0
            self._device_validated = False
            self._fallback_attempts += 1
            _vlog(f"stream-switched=true fallback-attempt={self._fallback_attempts}")
        except Exception as e:
            _vlog(f"stream-switch=error ({e})")

    def _rescan_dead_device(self) -> None:
        """Un unico re-escaneo cuando la entrada resulta permanentemente en cero.

        Limpia el cache (fuerza enumeracion + aperturas frescas) y reinicia el
        propio stream. Corre en thread dedicado: nunca desde el callback.
        """
        with self._switch_lock:
            if self._auto_rescan_done:
                return
            self._auto_rescan_done = True
        clear_input_selection_cache("signal-dead")
        try:
            self.stop()
        except Exception:
            pass
        time.sleep(0.5)
        try:
            self.start()
        except Exception as e:
            _vlog(f"dead-rescan error ({e})")

    def _audio_callback(
        self,
        in_data: bytes,
        frame_count: int,
        time_info: dict,
        status: int,
    ) -> tuple:
        # Check if we're still running (not stopping/stopped)
        with self._state_lock:
            if self._state != self._STATE_RUNNING:
                self._callback_done.set()
                self._callback_ack.set()
                _vlog(f"wake-callback-exit id={self._wake_id} thread={threading.get_ident()} state={self._state}")
                return (in_data, pyaudio.paContinue)

            self._callback_done.clear()
            self._callback_ack.clear()

        try:
            return self._process_audio_callback(in_data, frame_count, time_info, status)
        finally:
            # stop() waits for this barrier before closing the native stream.
            self._callback_ack.set()
            self._callback_done.set()

    def _process_audio_callback(
        self,
        in_data: bytes,
        frame_count: int,
        time_info: dict,
        status: int,
    ) -> tuple:

        self._total_bytes += len(in_data)
        self._callback_count += 1

        # Convert stereo to mono for Vosk recognition and RMS if stream is stereo
        if self._input_channels == 2 and len(in_data) >= 4:
            pcm_mono = np.frombuffer(in_data, dtype=np.int16)[0::2].tobytes()
        else:
            pcm_mono = in_data

        rms, peak = _compute_rms_peak(pcm_mono)
        if rms > self._max_observed_rms:
            self._max_observed_rms = rms
        self._rms_history.append((rms, peak))
        if len(self._rms_history) > 40:
            self._rms_history = self._rms_history[-40:]

        now = time.time()
        if not self._device_validated:
            elapsed = now - self._validation_start_time
            if now - self._last_level_log_time >= 1.0:
                _dlog(f"selected-input-rms={rms:.4f}")
                _dlog(f"selected-input-peak={peak:.4f}")
                self._last_level_log_time = now

            if self._max_observed_rms >= self._silence_threshold:
                self._device_validated = True
                _vlog(f"selected-input-validated=ok rms={self._max_observed_rms:.4f}")
            elif elapsed >= self._validation_window:
                verdict_info = validate_capture_signal(
                    list(self._rms_history), elapsed * 1000.0,
                )
                verdict = verdict_info["verdict"]
                rms_max = verdict_info["rms_max"]
                if verdict == "dead" and not self._auto_rescan_done:
                    _vlog(
                        f"input-signal-status=dead-silent rms_max={rms_max:.4f} "
                        f"action=rescan-once"
                    )
                    threading.Thread(target=self._rescan_dead_device, daemon=True).start()
                    self._device_validated = True
                elif self._alternatives and self._fallback_attempts < self._max_fallback_attempts:
                    next_cand = self._alternatives.pop(0)
                    _vlog(
                        f"input-device-silent: RMS remained 0.0000 for {self._validation_window}s, "
                        f"trying next candidate index={next_cand['index']} name=\"{next_cand['name']}\" fallback={self._fallback_attempts + 1}/{self._max_fallback_attempts}"
                    )
                    threading.Thread(target=self._switch_input_device, args=(next_cand,), daemon=True).start()
                    self._device_validated = True
                else:
                    self._device_validated = True
                    _vlog(
                        f"input-signal-status=degraded-silent verdict={verdict} "
                        f"rms_max={rms_max:.4f} hint=input_device_rescan"
                    )
                    _vlog("selected-input-validated=no-more-candidates (RMS=0.0000)")
        elif now - self._last_level_log_time >= self._level_log_interval:
            _dlog(f"input-level rms={rms:.4f} peak={peak:.4f} bytes={self._total_bytes} callbacks={self._callback_count}")
            self._last_level_log_time = now

        try:
            if self.recognizer.AcceptWaveform(pcm_mono):
                result = json.loads(self.recognizer.Result())
                text = result.get("text", "").lower().strip()
                if text:
                    _vlog(f"vosk-result=\"{text}\"")
                    self._check_wake_word(text)
                else:
                    _dlog("vosk-result=(empty)")
            else:
                partial = json.loads(self.recognizer.PartialResult())
                partial_text = partial.get("partial", "").lower().strip()
                if partial_text:
                    self._check_wake_word(partial_text)
                    if self._callback_count % 200 == 0:
                        _vlog(f"vosk-partial=\"{partial_text}\"")
        except MemoryError:
            raise
        except Exception as e:
            _vlog(f"vosk-error ({e})")

        return (in_data, pyaudio.paContinue)

    def _fuzzy_match(self, token: str, target: str) -> bool:
        if token == target:
            return True
        if abs(len(token) - len(target)) > 1:
            return False
        return difflib.SequenceMatcher(None, token, target).ratio() >= 0.82

    def _dispatch_detected(self, wake_word: str) -> None:
        """Run client work outside PortAudio's native callback thread.

        The client stops this detector when a wake word is recognized. Calling
        it inline made stop_stream/close re-enter PortAudio from its callback
        and wait for an acknowledgement that only that callback could send.
        """
        callback = self.on_detected
        if callback is None:
            return

        def invoke() -> None:
            try:
                callback(wake_word)
            except Exception as e:
                _vlog(f"wake-detection-handler-error type={type(e).__name__}")

        try:
            threading.Thread(
                target=invoke,
                name="apollo-wake-detection",
                daemon=True,
            ).start()
        except Exception as e:
            # Never fall back to the native callback thread: that would restore
            # the unsafe stop-from-callback path.
            _vlog(f"wake-detection-dispatch-error type={type(e).__name__}")

    def _check_wake_word(self, text: str) -> None:
        now = time.time()
        if now - self._last_detection_time < self._cooldown:
            return

        norm = text.replace('á', 'a').replace('é', 'e').replace('í', 'i').replace('ó', 'o').replace('ú', 'u')
        tokens = re.findall(r'\b\w+\b', norm)

        for wake_word in self.wake_words:
            needs_prefix = ' ' in wake_word and wake_word.split()[0] not in ("apollo",)
            if needs_prefix:
                prefix_variants = wake_word.split()[0]
                second_word = wake_word.split()[1] if len(wake_word.split()) > 1 else ""
                prefix_pattern = f"({re.escape(prefix_variants)})"
                if re.search(r'\b' + prefix_pattern + r'\s+' + re.escape(second_word) + r'\b', norm):
                    self._last_detection_time = now
                    _vlog(f"Wake word coincide: {wake_word} (texto: '{text}')")
                    if self.on_detected:
                        self._dispatch_detected(wake_word)
                    return
            else:
                if re.search(r'\b' + re.escape(wake_word) + r'\b', norm):
                    self._last_detection_time = now
                    _vlog(f"Wake word coincide: {wake_word} (texto: '{text}')")
                    if self.on_detected:
                        self._dispatch_detected(wake_word)
                    return
                for tok in tokens:
                    if self._fuzzy_match(tok, wake_word):
                        self._last_detection_time = now
                        _vlog(f"Wake word difuso: '{tok}' ~ '{wake_word}' (texto: '{text}')")
                        if self.on_detected:
                            self._dispatch_detected(wake_word)
                        return

    def stop(self) -> None:
        # Idempotent: check state first
        with self._state_lock:
            if self._state == self._STATE_STOPPED:
                _vlog("wake-detector=stop-noop reason=already-stopped")
                return
            if self._state == self._STATE_STOPPING:
                _vlog("wake-detector=stop-noop reason=already-stopping")
                return
            # Transition: RUNNING → STOPPING
            self._state = self._STATE_STOPPING

        _vlog(f"wake-stop-requested id={self._wake_id} thread={threading.get_ident()} state=STOPPING")

        # Stop from a control thread, then wait for the callback's finally
        # barrier before releasing the native stream it may still be using.
        stream = self._stream
        if stream:
            stream.stop_stream()

        self._callback_done.wait()
        _vlog(f"wake-callback-quiesced id={self._wake_id} thread={threading.get_ident()}")
        self._callback_ack.wait()
        _vlog(f"wake-callback-ack id={self._wake_id} thread={threading.get_ident()}")

        if stream:
            stream.close()
            if self._stream is stream:
                self._stream = None
            _vlog(f"wake-stream-close id={self._wake_id} thread={threading.get_ident()}")

        # Transition: STOPPING → STOPPED
        with self._state_lock:
            self._state = self._STATE_STOPPED

        _vlog("wake-detector=stopped")

    def wait_callback_done(self, timeout: float = 2.0) -> None:
        self._callback_done.wait(timeout=timeout)

    def __del__(self):
        # Only clean up if we own the PyAudio and it's not already terminated
        try:
            if self._owns_pyaudio and hasattr(self, '_audio'):
                self._audio.terminate()
        except Exception:
            pass

    @property
    def state(self) -> str:
        with self._state_lock:
            return self._state


class ManualWakeWordDetector:
    """Fallback manual wake word detector (keyboard/key press)."""

    def __init__(
        self,
        wake_words: list[str],
        on_detected: Optional[Callable[[str], None]] = None,
    ):
        self.wake_words = wake_words
        self.on_detected = on_detected
        self._running = False
        _log(f"Wake word detector inicializado: Manual (words={wake_words})")

    def start(self) -> None:
        self._running = True
        _log("Modo manual activo - usa .trigger('palabra') para activar")

    def trigger(self, wake_word: Optional[str] = None) -> None:
        if not self._running:
            return
        word = wake_word or self.wake_words[0]
        _log(f"Wake word manual activado: {word}")
        if self.on_detected:
            self.on_detected(word)

    def stop(self) -> None:
        self._running = False
        _log("Wake word detector manual detenido")


def create_wake_detector(
    wake_words: list[str] = None,
    model_dir: str = None,
    prefer_vosk: bool = True,
    on_detected: Optional[Callable[[str], None]] = None,
    pyaudio_instance: Optional[pyaudio.PyAudio] = None,
    input_device_name: str = "Micrófono (JBL Quantum 300)",
    input_device_index: int = -1,
) -> VoskWakeWordDetector | ManualWakeWordDetector:
    wake_words = wake_words or ["apollo", "hey apollo"]
    model_dir = model_dir or os.path.join(os.path.dirname(__file__), "models")

    if prefer_vosk:
        for model_name in [
            "vosk-model-small-es-0.42",
            "vosk-model-small-en-us-0.15",
            "vosk-model-es-0.42",
            "vosk-model-en-us-0.22",
        ]:
            model_path = os.path.join(model_dir, model_name)
            if os.path.exists(model_path):
                try:
                    _log(f"Modelo Vosk encontrado: {model_name}")
                    return VoskWakeWordDetector(
                        model_path=model_path,
                        wake_words=wake_words,
                        on_detected=on_detected,
                        pyaudio_instance=pyaudio_instance,
                        input_device_name=input_device_name,
                        input_device_index=input_device_index,
                    )
                except Exception as e:
                    _log(f"Error cargando modelo {model_name}: {e}")
                    continue
        _log("No se encontro modelo Vosk valido, usando detector manual")

    return ManualWakeWordDetector(wake_words=wake_words, on_detected=on_detected)


def download_vosk_model(model_name: str, target_dir: str) -> str:
    import urllib.request
    import zipfile
    import io

    model_url = f"https://alphacephei.com/vosk/models/{model_name}.zip"
    model_path = os.path.join(target_dir, model_name)

    if os.path.exists(model_path):
        return model_path

    os.makedirs(target_dir, exist_ok=True)
    print(f"Downloading {model_name}...")

    try:
        with urllib.request.urlopen(model_url) as response:
            zip_data = io.BytesIO(response.read())

        with zipfile.ZipFile(zip_data) as zf:
            zf.extractall(target_dir)

        print(f"Model extracted to {model_path}")
        return model_path
    except Exception as e:
        raise RuntimeError(f"Failed to download model: {e}")
