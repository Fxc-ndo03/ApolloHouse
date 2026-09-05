"""Audio capture and playback for Juana client."""

import pyaudio
import numpy as np
import threading
import queue
import time
from typing import Optional, Callable


class AudioCapture:
    """Captures audio from microphone at 16kHz mono."""
    
    def __init__(
        self,
        sample_rate: int = 16000,
        channels: int = 1,
        chunk_size: int = 512,
        format: int = pyaudio.paInt16,
    ):
        self.sample_rate = sample_rate
        self.channels = channels
        self.chunk_size = chunk_size
        self.format = format
        self._audio = pyaudio.PyAudio()
        self._stream: Optional[pyaudio.Stream] = None
        self._running = False
        self._callback: Optional[Callable[[bytes], None]] = None
        self._thread: Optional[threading.Thread] = None

    def start(self, callback: Callable[[bytes], None]) -> None:
        """Start capturing audio."""
        if self._running:
            return
        
        self._callback = callback
        self._running = True
        
        self._stream = self._audio.open(
            format=self.format,
            channels=self.channels,
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
        """PyAudio callback."""
        if self._callback and self._running:
            self._callback(in_data)
        return (in_data, pyaudio.paContinue)

    def stop(self) -> None:
        """Stop capturing audio."""
        self._running = False
        if self._stream:
            self._stream.stop_stream()
            self._stream.close()
            self._stream = None

    def __del__(self):
        self.stop()
        self._audio.terminate()


class AudioPlayback:
    """Plays back PCM audio at 24kHz mono."""
    
    def __init__(
        self,
        sample_rate: int = 24000,
        channels: int = 1,
        chunk_size: int = 1024,
        format: int = pyaudio.paInt16,
        on_end: Optional[Callable[[], None]] = None,
    ):
        self.sample_rate = sample_rate
        self.channels = channels
        self.chunk_size = chunk_size
        self.format = format
        self._audio = pyaudio.PyAudio()
        self._stream: Optional[pyaudio.Stream] = None
        self._buffer = queue.Queue()
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._on_end_callback: Optional[Callable[[], None]] = on_end

    def start(self, on_end: Optional[Callable[[], None]] = None) -> None:
        """Start playback stream."""
        if self._running:
            return
        
        if on_end is not None:
            self._on_end_callback = on_end
        self._running = True
        
        self._stream = self._audio.open(
            format=self.format,
            channels=self.channels,
            rate=self.sample_rate,
            output=True,
            frames_per_buffer=self.chunk_size,
            stream_callback=self._playback_callback,
        )
        self._stream.start_stream()
        self._thread = threading.Thread(target=self._playback_loop, daemon=True)
        self._thread.start()

    def _playback_callback(
        self,
        in_data: bytes,
        frame_count: int,
        time_info: dict,
        status: int,
    ) -> tuple:
        """PyAudio output callback."""
        try:
            data = self._buffer.get_nowait()
            if len(data) < frame_count * 2 * self.channels:
                # Pad with silence
                data += b'\x00' * (frame_count * 2 * self.channels - len(data))
        except queue.Empty:
            data = b'\x00' * (frame_count * 2 * self.channels)
        return (data, pyaudio.paContinue)

    def _playback_loop(self) -> None:
        """Monitor for end of stream."""
        while self._running:
            time.sleep(0.1)
            # Check if stream is still active
            if self._stream and not self._stream.is_active():
                break
        
        if self._on_end_callback:
            self._on_end_callback()

    def write(self, data: bytes) -> None:
        """Write audio data to playback buffer."""
        if self._running:
            self._buffer.put(data)

    def stop(self) -> None:
        """Stop playback."""
        self._running = False
        # Clear buffer
        while not self._buffer.empty():
            try:
                self._buffer.get_nowait()
            except queue.Empty:
                break
        
        if self._stream:
            self._stream.stop_stream()
            self._stream.close()
            self._stream = None
        
        if self._thread:
            self._thread.join(timeout=1.0)
            self._thread = None

    def __del__(self):
        try:
            self.stop()
        except AttributeError:
            pass
        try:
            self._audio.terminate()
        except AttributeError:
            pass


def pcm_to_numpy(pcm_data: bytes, dtype=np.int16) -> np.ndarray:
    """Convert PCM bytes to numpy array."""
    return np.frombuffer(pcm_data, dtype=dtype)


def numpy_to_pcm(arr: np.ndarray) -> bytes:
    """Convert numpy array to PCM bytes."""
    return arr.astype(np.int16).tobytes()