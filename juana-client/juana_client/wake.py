"""Wake word detection for Juana client using Vosk (offline, no account needed)."""

import json
import os
import queue
import threading
import time
from pathlib import Path
from typing import Callable, Optional

import pyaudio
from vosk import KaldiRecognizer, Model, SetLogLevel

SetLogLevel(-1)  # Suppress Vosk logs


class VoskWakeWordDetector:
    """Wake word detector using Vosk speech recognition."""

    def __init__(
        self,
        model_path: str,
        wake_words: list[str],
        sample_rate: int = 16000,
        sensitivity: float = 0.5,
        on_detected: Optional[Callable[[str], None]] = None,
    ):
        """
        Args:
            model_path: Path to Vosk model directory (e.g., vosk-model-small-es-0.42)
            wake_words: List of wake words to detect (e.g., ["juana", "hey juana"])
            sample_rate: Audio sample rate (must match model)
            sensitivity: Detection threshold (0.0-1.0), higher = more sensitive
            on_detected: Callback when wake word is detected
        """
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"Vosk model not found at: {model_path}")

        self.model = Model(model_path)
        self.recognizer = KaldiRecognizer(self.model, sample_rate)
        self.wake_words = [w.lower() for w in wake_words]
        self.sensitivity = sensitivity
        self.on_detected = on_detected

        self.sample_rate = sample_rate
        self.chunk_size = 4000  # frames per buffer
        self._audio = pyaudio.PyAudio()
        self._stream: Optional[pyaudio.Stream] = None
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._last_detection_time = 0.0
        self._cooldown = 2.0  # seconds between detections

    def start(self) -> None:
        """Start listening for wake word."""
        if self._running:
            return

        self._running = True
        self._stream = self._audio.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=self.sample_rate,
            input=True,
            frames_per_buffer=self.chunk_size,
            stream_callback=self._audio_callback,
        )
        self._stream.start_stream()

    def _audio_callback(
        self,
        in_data: bytes,
        frame_count: int,
        time_info: dict,
        status: int,
    ) -> tuple:
        """PyAudio callback - process audio chunk."""
        if self._running and self.recognizer.AcceptWaveform(in_data):
            result = json.loads(self.recognizer.Result())
            text = result.get("text", "").lower().strip()
            if text:
                self._check_wake_word(text)
        return (in_data, pyaudio.paContinue)

    def _check_wake_word(self, text: str) -> None:
        """Check if any wake word is in the recognized text."""
        now = time.time()
        if now - self._last_detection_time < self._cooldown:
            return

        for wake_word in self.wake_words:
            if wake_word in text:
                self._last_detection_time = now
                if self.on_detected:
                    try:
                        self.on_detected(wake_word)
                    except Exception:
                        pass
                break

    def stop(self) -> None:
        """Stop listening."""
        self._running = False
        if self._stream:
            self._stream.stop_stream()
            self._stream.close()
            self._stream = None

    def __del__(self):
        self.stop()
        self._audio.terminate()


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

    def start(self) -> None:
        """Start manual detection (simulated with a simple interface)."""
        self._running = True

    def trigger(self, wake_word: Optional[str] = None) -> None:
        """Manually trigger wake word detection (for testing/fallback)."""
        if not self._running:
            return
        word = wake_word or self.wake_words[0]
        if self.on_detected:
            self.on_detected(word)

    def stop(self) -> None:
        self._running = False


def create_wake_detector(
    wake_words: list[str] = None,
    model_dir: str = None,
    prefer_vosk: bool = True,
    on_detected: Optional[Callable[[str], None]] = None,
) -> VoskWakeWordDetector | ManualWakeWordDetector:
    """
    Factory to create the best available wake word detector.

    Args:
        wake_words: List of wake words to detect
        model_dir: Directory containing Vosk models
        prefer_vosk: Try Vosk first, fall back to manual
        on_detected: Callback when wake word detected

    Returns:
        Wake word detector instance
    """
    wake_words = wake_words or ["juana", "hey juana"]
    model_dir = model_dir or os.path.join(os.path.dirname(__file__), "models")

    if prefer_vosk:
        # Look for Spanish or English small models
        for model_name in [
            "vosk-model-small-es-0.42",
            "vosk-model-small-en-us-0.15",
            "vosk-model-es-0.42",
            "vosk-model-en-us-0.22",
        ]:
            model_path = os.path.join(model_dir, model_name)
            if os.path.exists(model_path):
                try:
                    return VoskWakeWordDetector(
                        model_path=model_path,
                        wake_words=wake_words,
                        on_detected=on_detected,
                    )
                except Exception:
                    continue

    # Fallback to manual
    return ManualWakeWordDetector(wake_words=wake_words, on_detected=on_detected)


def download_vosk_model(model_name: str, target_dir: str) -> str:
    """
    Download a Vosk model if not present.

    Args:
        model_name: Model name (e.g., "vosk-model-small-es-0.42")
        target_dir: Directory to extract model

    Returns:
        Path to extracted model
    """
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