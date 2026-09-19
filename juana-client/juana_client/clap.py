"""Double-clap detection from microphone amplitude (RMS).

No machine learning, no heavy dependencies: a clap is a short, loud
transient, so two RMS spikes close together (and nothing sustained in
between) is enough for an alternative physical trigger — e.g. silencing
an alarm without speaking.

The detection core (push_samples) is hardware-free and unit-testable;
start/stop opens a dedicated microphone stream, same pattern as the
wake-word detector.
"""

import threading
import time
from collections import deque
from typing import Callable, Optional

import numpy as np
import pyaudio


def _log(msg: str) -> None:
    """Print timestamped log message to stdout (never raises)."""
    try:
        print(f"[CLAP] {msg}", flush=True)
    except OSError:
        pass


def compute_rms(pcm_data: bytes) -> float:
    """Root-mean-square amplitude of int16 mono PCM bytes."""
    if len(pcm_data) < 2:
        return 0.0
    samples = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float64)
    return float(np.sqrt(np.mean(samples * samples)))


class ClapDetector:
    """Detects two hand claps in a short time window.

    The on_detected callback runs in the audio thread; callers that need
    the asyncio loop must marshal it themselves.
    """

    def __init__(
        self,
        sample_rate: int = 16000,
        absolute_floor_rms: float = 700.0,
        baseline_ratio: float = 4.0,
        baseline_window_frames: int = 64,
        min_interval_seconds: float = 0.25,
        max_interval_seconds: float = 1.0,
        transient_settle_seconds: float = 0.2,
        cooldown_seconds: float = 2.0,
        on_detected: Optional[Callable[[], None]] = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.sample_rate = sample_rate
        self.absolute_floor_rms = absolute_floor_rms
        self.baseline_ratio = baseline_ratio
        self.min_interval_seconds = min_interval_seconds
        self.max_interval_seconds = max_interval_seconds
        self.transient_settle_seconds = transient_settle_seconds
        self.cooldown_seconds = cooldown_seconds
        self.on_detected = on_detected
        self._clock = clock

        self._baseline_window: deque[float] = deque(maxlen=baseline_window_frames)
        self._lock = threading.Lock()
        self._first_spike_time: Optional[float] = None
        self._first_spike_peak = 0.0
        self._spike_pending_settle = False
        self._cooldown_until = 0.0

        self._audio = None
        self._stream = None
        self._running = False

    def _threshold(self) -> float:
        if len(self._baseline_window) == 0:
            return self.absolute_floor_rms
        baseline = sum(self._baseline_window) / len(self._baseline_window)
        return max(self.absolute_floor_rms, baseline * self.baseline_ratio)

    def push_samples(self, pcm_data: bytes) -> bool:
        """Feed one chunk of int16 mono PCM. Returns True on double-clap."""
        rms = compute_rms(pcm_data)
        now = self._clock()
        with self._lock:
            if now < self._cooldown_until:
                return False
            threshold = self._threshold()
            if rms <= threshold:
                self._baseline_window.append(rms)
                return self._advance_quiet(now)
            return self._advance_spike(now, rms)

    def _advance_quiet(self, now: float) -> bool:
        if self._first_spike_time is None:
            return False
        if self._spike_pending_settle:
            self._spike_pending_settle = False
            return False
        if now - self._first_spike_time > self.max_interval_seconds:
            self._first_spike_time = None
        return False

    def _advance_spike(self, now: float, rms: float) -> bool:
        if self._first_spike_time is None:
            self._first_spike_time = now
            self._first_spike_peak = rms
            self._spike_pending_settle = True
            return False
        if self._spike_pending_settle:
            if now - self._first_spike_time > self.transient_settle_seconds:
                self._first_spike_time = None
                self._spike_pending_settle = False
                return False
            return False
        elapsed = now - self._first_spike_time
        if elapsed < self.min_interval_seconds:
            return False
        if elapsed > self.max_interval_seconds:
            self._first_spike_time = now
            self._first_spike_peak = rms
            self._spike_pending_settle = True
            return False
        self._first_spike_time = None
        self._cooldown_until = now + self.cooldown_seconds
        if self.on_detected is not None:
            self.on_detected()
        return True

    def reset(self) -> None:
        """Clear pending first-clap state."""
        with self._lock:
            self._first_spike_time = None
            self._spike_pending_settle = False

    def start(self, chunk_frames: int = 512) -> None:
        """Open the microphone and feed every chunk to the detector."""
        if self._running:
            return
        self._running = True
        self._audio = pyaudio.PyAudio()
        self._stream = self._audio.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=self.sample_rate,
            input=True,
            frames_per_buffer=chunk_frames,
            stream_callback=self._audio_callback,
        )
        self._stream.start_stream()
        _log("Escuchando doble palmada...")

    def _audio_callback(
        self,
        in_data: bytes,
        frame_count: int,
        time_info: dict,
        status: int,
    ) -> tuple:
        if self._running:
            try:
                self.push_samples(in_data)
            except Exception as exc:
                _log(f"error en detector: {exc}")
        return (in_data, pyaudio.paContinue)

    def stop(self) -> None:
        """Close the microphone stream."""
        self._running = False
        if self._stream is not None:
            try:
                self._stream.stop_stream()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        if self._audio is not None:
            try:
                self._audio.terminate()
            except Exception:
                pass
            self._audio = None
