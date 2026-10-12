"""Tests de auditoria: seleccion con errores, veredicto de senal, lifecycle.

Deterministas con PyAudio/streams simulados. Sin hardware real.
"""

import os
import sys
import tempfile
import unittest
import unittest.mock
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from juana_client.audio import (
    find_best_input_device,
    clear_input_selection_cache,
    validate_capture_signal,
    resample_mono_pcm,
    format_playback_summary,
    AudioCapture,
    AudioPlayback,
)


def _mock_audio(devices, fail_open_indexes=None):
    """PyAudio simulado. fail_open_indexes: indices cuya apertura lanza OSError."""
    fail_open_indexes = fail_open_indexes or set()
    mock_audio = MagicMock()
    mock_audio.get_device_count.return_value = len(devices)
    mock_audio.get_device_info_by_index.side_effect = lambda i: devices[i]

    def fake_open(**kwargs):
        idx = kwargs.get("input_device_index", kwargs.get("output_device_index"))
        if idx in fail_open_indexes:
            raise OSError(-9999, "Unanticipated host error")
        stream = MagicMock()
        return stream

    mock_audio.open.side_effect = fake_open
    return mock_audio


class AudioAuditTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self._old_env = os.environ.get("APOLLO_CONFIG_DIR")
        os.environ["APOLLO_CONFIG_DIR"] = self.tmpdir
        from juana_client import audio as audio_module
        self._old_legacy = audio_module._LEGACY_PREFERENCES_FILE
        audio_module._LEGACY_PREFERENCES_FILE = os.path.join(self.tmpdir, "legacy.json")
        clear_input_selection_cache("test")

    def tearDown(self):
        from juana_client import audio as audio_module
        audio_module._LEGACY_PREFERENCES_FILE = self._old_legacy
        clear_input_selection_cache("test")
        if self._old_env is None:
            os.environ.pop("APOLLO_CONFIG_DIR", None)
        else:
            os.environ["APOLLO_CONFIG_DIR"] = self._old_env
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)


class TestPreferredFailureFallsThrough(AudioAuditTestCase):
    """El preferido falla con excepcion -> se prueba el siguiente fisico."""

    def test_preferred_raises_next_physical_tried(self):
        devices = [
            {'name': 'Micrófono (JBL Quantum 300)', 'maxInputChannels': 1, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 16000},
            {'name': 'Micrófono (Realtek HD Audio)', 'maxInputChannels': 1, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 16000},
        ]
        audio = _mock_audio(devices, fail_open_indexes={0})
        idx, name, _ch, _rate, _alt = find_best_input_device(
            audio, preferred_name="Micrófono (JBL Quantum 300)", use_cache=False,
        )
        self.assertEqual(idx, 1)
        self.assertIn("Realtek", name)


class TestValidateCaptureSignal(unittest.TestCase):
    """Un dispositivo con lecturas nulas no se declara funcional."""

    def test_all_zero_is_dead(self):
        verdict = validate_capture_signal([(0.0, 0.0)] * 20, 500.0)
        self.assertEqual(verdict["verdict"], "dead")
        self.assertEqual(verdict["nonzero_ratio"], 0.0)

    def test_below_threshold_is_silent(self):
        verdict = validate_capture_signal([(0.005, 0.01)] * 20, 500.0)
        self.assertEqual(verdict["verdict"], "silent")

    def test_energy_is_ok(self):
        samples = [(0.0, 0.0)] * 5 + [(0.10, 0.2)] * 15
        verdict = validate_capture_signal(samples, 500.0)
        self.assertEqual(verdict["verdict"], "ok")
        self.assertAlmostEqual(verdict["rms_max"], 0.10)
        self.assertAlmostEqual(verdict["peak_max"], 0.2)
        self.assertAlmostEqual(verdict["nonzero_ratio"], 0.75)

    def test_empty_is_unknown(self):
        verdict = validate_capture_signal([], 0.0)
        self.assertEqual(verdict["verdict"], "unknown")


class TestResampleMono(unittest.TestCase):
    def test_same_rate_is_copy(self):
        import numpy as np
        data = (np.arange(100, dtype=np.int16)).tobytes()
        self.assertEqual(resample_mono_pcm(data, 16000, 16000), data)

    def test_downsample_ratio(self):
        import numpy as np
        data = (np.ones(441, dtype=np.int16) * 1000).tobytes()
        out = resample_mono_pcm(data, 44100, 16000)
        # ~160 muestras por cada 441 de entrada
        self.assertEqual(len(out) // 2, int(441 * 16000 / 44100))
        restored = np.frombuffer(out, dtype=np.int16).astype(float)
        self.assertTrue((restored > 900).all())


class TestSharedPyAudioLifecycle(AudioAuditTestCase):
    """Dos capturas comparten un PyAudio: stop de una no termina el comun."""

    def test_stop_one_capture_keeps_shared_pyaudio(self):
        devices = [
            {'name': 'Micrófono (JBL Quantum 300)', 'maxInputChannels': 1, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 16000},
        ]
        audio = _mock_audio(devices)
        first = AudioCapture(sample_rate=16000, chunk_size=512, pyaudio_instance=audio, use_callback=False)
        second = AudioCapture(sample_rate=16000, chunk_size=512, pyaudio_instance=audio, use_callback=False)
        with unittest.mock.patch.object(AudioCapture, "_resolve_input_device", return_value=(0, "Mic", 1, 16000)):
            first.start()
            second.start()
        first.stop()
        # El PyAudio compartido NO se termina; el otro stream sigue abierto.
        audio.terminate.assert_not_called()
        self.assertIsNotNone(second._stream)
        second.stop()
        audio.terminate.assert_not_called()

    def test_stop_is_idempotent(self):
        devices = [
            {'name': 'Micrófono (JBL Quantum 300)', 'maxInputChannels': 1, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 16000},
        ]
        audio = _mock_audio(devices)
        capture = AudioCapture(sample_rate=16000, chunk_size=512, pyaudio_instance=audio, use_callback=False)
        with unittest.mock.patch.object(AudioCapture, "_resolve_input_device", return_value=(0, "Mic", 1, 16000)):
            capture.start()
        capture.stop()
        capture.stop()  # no debe lanzar


class TestPlaybackSummary(unittest.TestCase):
    def test_format(self):
        line = format_playback_summary(10, 81920, 1500)
        self.assertIn("frames=10", line)
        self.assertIn("bytes=81920", line)
        self.assertIn("duration_ms=1500", line)

    def test_counters_accumulate(self):
        devices = [
            {'name': 'JBL Quantum 300', 'maxInputChannels': 0, 'maxOutputChannels': 2, 'hostApi': 0, 'defaultSampleRate': 48000},
        ]
        audio = _mock_audio(devices)
        playback = AudioPlayback(
            sample_rate=24000, chunk_size=1024,
            pyaudio_instance=audio, output_device_name="JBL Quantum 300",
        )
        from juana_client import audio as audio_module
        with unittest.mock.patch.object(
            audio_module, "find_best_output_device",
            return_value=(0, "JBL Quantum 300", 24000, 1, []),
        ):
            playback.start()
        playback.write(b"\x01\x02" * 2048)
        self.assertGreater(playback._bytes_written, 0)
        self.assertGreater(playback._frames_written, 0)
        playback.stop()


class TestTurnPayload(unittest.TestCase):
    def test_turn_id_preserved(self):
        from juana_client.client import build_voice_transcript_payload
        payload = build_voice_transcript_payload("hola", "abc123")
        self.assertEqual(payload["type"], "voice_transcript")
        self.assertEqual(payload["text"], "hola")
        self.assertEqual(payload["turn_id"], "abc123")


class TestWakeModelCache(unittest.TestCase):
    """Un restart del wake no recarga el Model: cache por ruta."""

    def test_shared_model_cache_hit(self):
        from juana_client import wake as wake_module
        fake_model = object()
        with unittest.mock.patch.object(wake_module, "Model", return_value=fake_model) as mock_model:
            wake_module._wake_model_cache.clear()
            try:
                first = wake_module.get_shared_wake_model("/fake/model")
                second = wake_module.get_shared_wake_model("/fake/model")
                self.assertIs(first, fake_model)
                self.assertIs(second, fake_model)
                self.assertEqual(mock_model.call_count, 1)
            finally:
                wake_module._wake_model_cache.clear()


if __name__ == "__main__":
    unittest.main()
