"""Unit tests for blocking-mode STT transport (use_callback=False).

STT callback mode crashes with 0xC0000005; blocking mode went 20/20 clean
(see test_stt_cycles.py). These tests pin the wiring with mocks (CI-safe,
no hardware needed):
- stream opens with stream_callback=None
- get_chunk() reads via stream.read(), never touches the queue
- read errors degrade to None (worker loop survives)
- callback mode still wires stream_callback (wake/playback untouched)
"""

import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from juana_client.audio import AudioCapture


def _mock_audio():
    mock_audio = MagicMock()
    mock_stream = MagicMock()
    mock_audio.open.return_value = mock_stream
    return mock_audio, mock_stream


class TestBlockingWiring(unittest.TestCase):
    def test_blocking_open_passes_no_callback(self):
        """En modo blocking, open() debe recibir stream_callback=None."""
        mock_audio, _mock_stream = _mock_audio()
        capture = AudioCapture(
            sample_rate=16000,
            chunk_size=512,
            pyaudio_instance=mock_audio,
            input_device_name="Micrófono (JBL Quantum 300)",
            use_callback=False,
        )
        with patch.object(
            AudioCapture, "_resolve_input_device", return_value=(3, "Mic", 1, 16000)
        ):
            capture.start()
        _, kwargs = mock_audio.open.call_args
        self.assertIsNone(kwargs.get("stream_callback"))
        self.assertTrue(capture.is_blocking)
        capture.stop()

    def test_callback_mode_still_wires_callback(self):
        """El default (callback) no debe cambiar: wake/playback lo usan."""
        mock_audio, _mock_stream = _mock_audio()
        capture = AudioCapture(
            sample_rate=16000,
            chunk_size=512,
            pyaudio_instance=mock_audio,
            input_device_name="Micrófono (JBL Quantum 300)",
        )
        with patch.object(
            AudioCapture, "_resolve_input_device", return_value=(3, "Mic", 1, 16000)
        ):
            capture.start()
        _, kwargs = mock_audio.open.call_args
        self.assertIsNotNone(kwargs.get("stream_callback"))
        self.assertFalse(capture.is_blocking)
        capture.stop()

    def _byte_exact_gain(self):
        """Contexto de ganancia 1.0 para pinnear cableado byte-exacto."""
        from juana_client import audio as audio_module
        from unittest.mock import patch as _patch
        return (
            _patch.object(audio_module, "STT_GAIN_MODE", "fixed"),
            _patch.object(audio_module, "STT_FIXED_GAIN", 1.0),
        )

    def test_blocking_get_chunk_reads_stream(self):
        """get_chunk() en blocking lee del stream y copia los bytes."""
        mock_audio, mock_stream = _mock_audio()
        mock_stream.read.return_value = b"\x00\x60" * 256
        capture = AudioCapture(
            sample_rate=16000,
            chunk_size=512,
            pyaudio_instance=mock_audio,
            use_callback=False,
        )
        with patch.object(
            AudioCapture, "_resolve_input_device", return_value=(3, "Mic", 1, 16000)
        ):
            capture.start()
        mode_patch, gain_patch = self._byte_exact_gain()
        with mode_patch, gain_patch:
            chunk = capture.get_chunk(timeout=0.1)
        mock_stream.read.assert_called_with(512, exception_on_overflow=False)
        self.assertEqual(chunk, b"\x00\x60" * 256)
        capture.stop()

    def test_blocking_get_chunk_error_returns_none(self):
        """Un read fallido devuelve None: el worker sobrevive y sale por estado."""
        mock_audio, mock_stream = _mock_audio()
        mock_stream.read.side_effect = OSError("stream cerrado")
        capture = AudioCapture(
            sample_rate=16000,
            chunk_size=512,
            pyaudio_instance=mock_audio,
            use_callback=False,
        )
        with patch.object(
            AudioCapture, "_resolve_input_device", return_value=(3, "Mic", 1, 16000)
        ):
            capture.start()
        self.assertIsNone(capture.get_chunk(timeout=0.1))
        capture.stop()

    def test_blocking_stereo_downmix(self):
        """En blocking con 2 canales se mezcla a mono como en callback."""
        import numpy as np
        from juana_client import audio as audio_module
        mock_audio, mock_stream = _mock_audio()
        stereo = np.full(1024, 20000, dtype=np.int16).tobytes()
        mock_stream.read.return_value = stereo
        capture = AudioCapture(
            sample_rate=16000,
            chunk_size=512,
            pyaudio_instance=mock_audio,
            use_callback=False,
        )
        with patch.object(
            AudioCapture, "_resolve_input_device", return_value=(3, "Mic", 2, 16000)
        ):
            capture.start()
        mode_patch, gain_patch = self._byte_exact_gain()
        with mode_patch, gain_patch:
            chunk = capture.get_chunk(timeout=0.1)
        self.assertEqual(chunk, np.full(512, 20000, dtype=np.int16).tobytes())
        capture.stop()

    def test_blocking_weak_chunk_gets_agc_gain(self):
        """Senal debil real: el AGC (ganancia inicial 8.0) la levanta."""
        import numpy as np
        from unittest.mock import patch as _patch
        from juana_client import audio as audio_module
        from juana_client.audio import StreamingAgc
        mock_audio, mock_stream = _mock_audio()
        weak = (np.full(512, 655, dtype=np.int16)).tobytes()  # pico 0.02
        mock_stream.read.return_value = weak
        capture = AudioCapture(
            sample_rate=16000,
            chunk_size=512,
            pyaudio_instance=mock_audio,
            use_callback=False,
        )
        with patch.object(
            AudioCapture, "_resolve_input_device", return_value=(3, "Mic", 1, 16000)
        ):
            # Sin calibracion: AGC default (init 8.0) como en produccion fria.
            with _patch.object(audio_module, "STT_AUTO_CALIBRATE", False):
                capture.start()
        chunk = capture.get_chunk(timeout=0.1)
        # Cableado: get_chunk aplica el AGC del capture (misma salida que
        # un AGC fresco; la matematica se pinnea en TestStreamingAgc).
        self.assertEqual(chunk, StreamingAgc().process(weak))
        self.assertNotEqual(chunk, weak)
        capture.stop()

    def test_blocking_gain_opt_out(self):
        """STT_AUTO_GAIN=0 restaura byte-exacto (escape de emergencia)."""
        import numpy as np
        from juana_client import audio as audio_module
        mock_audio, mock_stream = _mock_audio()
        weak = (np.full(512, 655, dtype=np.int16)).tobytes()
        mock_stream.read.return_value = weak
        capture = AudioCapture(
            sample_rate=16000,
            chunk_size=512,
            pyaudio_instance=mock_audio,
            use_callback=False,
        )
        with patch.object(
            AudioCapture, "_resolve_input_device", return_value=(3, "Mic", 1, 16000)
        ):
            capture.start()
        old = audio_module.STT_AUTO_GAIN
        audio_module.STT_AUTO_GAIN = False
        try:
            self.assertEqual(capture.get_chunk(timeout=0.1), weak)
        finally:
            audio_module.STT_AUTO_GAIN = old
        capture.stop()


if __name__ == "__main__":
    unittest.main()
