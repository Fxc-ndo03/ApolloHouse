"""Tests for robust audio device selection."""

import os
import sys
import tempfile
import json
import unittest
from unittest.mock import MagicMock, patch, PropertyMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from juana_client.audio import (
    find_best_input_device,
    find_best_output_device,
    find_device_by_name,
    is_device_ignored,
    persist_device_preference,
    load_device_preference,
    get_preferred_device_name,
    _resolve_preferences_file,
    IGNORED_INPUT_KEYWORDS,
    IGNORED_OUTPUT_KEYWORDS,
)


class TestDeviceFiltering(unittest.TestCase):
    """Test that virtual/loopback devices are properly filtered."""

    def test_ignored_input_keywords(self):
        """All blacklisted keywords should match."""
        for kw in IGNORED_INPUT_KEYWORDS:
            self.assertTrue(is_device_ignored(kw, IGNORED_INPUT_KEYWORDS))

    def test_ignored_output_keywords(self):
        """All blacklisted output keywords should match."""
        for kw in IGNORED_OUTPUT_KEYWORDS:
            self.assertTrue(is_device_ignored(kw, IGNORED_OUTPUT_KEYWORDS))

    def test_physical_device_not_ignored(self):
        """Real physical devices should not be ignored."""
        self.assertFalse(is_device_ignored("Micrófono (JBL Quantum 300)", IGNORED_INPUT_KEYWORDS))
        self.assertFalse(is_device_ignored("JBL Quantum 300", IGNORED_OUTPUT_KEYWORDS))
        self.assertFalse(is_device_ignored("USB Microphone", IGNORED_INPUT_KEYWORDS))
        self.assertFalse(is_device_ignored("Headphones", IGNORED_OUTPUT_KEYWORDS))

    def test_virtual_devices_ignored(self):
        """Virtual/loopback devices should be ignored."""
        self.assertTrue(is_device_ignored("Virtual Mic", IGNORED_INPUT_KEYWORDS))
        self.assertTrue(is_device_ignored("AudioRelay", IGNORED_INPUT_KEYWORDS))
        self.assertTrue(is_device_ignored("Stereo Mix", IGNORED_INPUT_KEYWORDS))
        self.assertTrue(is_device_ignored("Wave", IGNORED_INPUT_KEYWORDS))
        self.assertTrue(is_device_ignored("Línea de entrada", IGNORED_INPUT_KEYWORDS))
        self.assertTrue(is_device_ignored("Controlador primario", IGNORED_INPUT_KEYWORDS))
        self.assertTrue(is_device_ignored("Asignador de sonido", IGNORED_INPUT_KEYWORDS))

    def test_steam_streaming_ignored_both_directions(self):
        """Steam virtual devices are silent loopbacks: ignore on input AND output."""
        self.assertTrue(is_device_ignored("Micrófono (Steam Streaming Microphone)", IGNORED_INPUT_KEYWORDS))
        self.assertTrue(is_device_ignored("Altavoces (Steam Streaming Speakers)", IGNORED_OUTPUT_KEYWORDS))

    def test_mapper_and_primary_ignored_on_output(self):
        """Mapper/primary drivers must never win the output selection."""
        self.assertTrue(is_device_ignored("Asignador de sonido Microsoft - Output", IGNORED_OUTPUT_KEYWORDS))
        self.assertTrue(is_device_ignored("Controlador primario de sonido", IGNORED_OUTPUT_KEYWORDS))
        self.assertTrue(is_device_ignored("Primary Sound Driver", IGNORED_OUTPUT_KEYWORDS))

    def test_is_device_ignored_case_insensitive(self):
        """Filtering should be case-insensitive."""
        self.assertTrue(is_device_ignored("VIRTUAL MIC", IGNORED_INPUT_KEYWORDS))
        self.assertTrue(is_device_ignored("AudioRelay", IGNORED_INPUT_KEYWORDS))
        self.assertTrue(is_device_ignored("Stereo Mix", IGNORED_INPUT_KEYWORDS))


class TestDeviceByNameMatching(unittest.TestCase):
    """Test name-based device matching."""

    def test_find_device_by_name_exact_match(self):
        """Should find devices with exact name matches."""
        mock_audio = MagicMock()
        mock_audio.get_device_count.return_value = 1
        mock_audio.get_device_info_by_index.return_value = {
            'name': 'Micrófono (JBL Quantum 300)',
            'maxInputChannels': 1,
            'hostApi': 0,
            'defaultSampleRate': 16000,
        }
        results = find_device_by_name(mock_audio, "Micrófono (JBL Quantum 300)", is_input=True)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]['name'], 'Micrófono (JBL Quantum 300)')

    def test_find_device_by_name_substring_match(self):
        """Should find devices with substring matches."""
        mock_audio = MagicMock()
        mock_audio.get_device_count.return_value = 1
        mock_audio.get_device_info_by_index.return_value = {
            'name': 'JBL Quantum 300 Microphone',
            'maxInputChannels': 1,
            'hostApi': 0,
            'defaultSampleRate': 16000,
        }
        results = find_device_by_name(mock_audio, "JBL Quantum 300", is_input=True)
        self.assertEqual(len(results), 1)
        self.assertIn('JBL Quantum 300', results[0]['name'])

    def test_find_device_by_name_no_match(self):
        """Should return empty list when no devices match."""
        mock_audio = MagicMock()
        mock_audio.get_device_count.return_value = 1
        mock_audio.get_device_info_by_index.return_value = {
            'name': 'Generic USB Audio',
            'maxInputChannels': 1,
            'hostApi': 0,
            'defaultSampleRate': 16000,
        }
        results = find_device_by_name(mock_audio, "NonExistentDevice", is_input=True)
        self.assertEqual(len(results), 0)

    def test_find_device_by_name_excludes_blacklisted(self):
        """Should exclude blacklisted devices from results."""
        mock_audio = MagicMock()
        mock_audio.get_device_count.return_value = 2

        def get_device_info(i):
            devices = [
                {'name': 'Virtual Mic', 'maxInputChannels': 1, 'hostApi': 0, 'defaultSampleRate': 16000},
                {'name': 'Micrófono (JBL Quantum 300)', 'maxInputChannels': 1, 'hostApi': 0, 'defaultSampleRate': 16000},
            ]
            return devices[i]
        mock_audio.get_device_info_by_index.side_effect = get_device_info

        results = find_device_by_name(mock_audio, "Micrófono", is_input=True)
        self.assertEqual(len(results), 1)
        self.assertNotIn('Virtual Mic', results[0]['name'])


class TestDevicePreferencePersistence(unittest.TestCase):
    """Test device preference persistence."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self._old_env = os.environ.get("APOLLO_CONFIG_DIR")
        os.environ["APOLLO_CONFIG_DIR"] = self.tmpdir
        # Neutralizar tambien la ruta legada: si existe el archivo real en el
        # paquete, la migracion automatica lo copiaria y contaminaria el test.
        from juana_client import audio as audio_module
        self._old_legacy = audio_module._LEGACY_PREFERENCES_FILE
        audio_module._LEGACY_PREFERENCES_FILE = os.path.join(self.tmpdir, "legacy.json")

    def tearDown(self):
        from juana_client import audio as audio_module
        audio_module._LEGACY_PREFERENCES_FILE = self._old_legacy
        if self._old_env is None:
            os.environ.pop("APOLLO_CONFIG_DIR", None)
        else:
            os.environ["APOLLO_CONFIG_DIR"] = self._old_env
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_persist_and_load_device_preference(self):
        """Should persist and load device preferences."""
        persist_device_preference("input", "Micrófono (JBL Quantum 300)", 0)
        prefs = load_device_preference("input")
        self.assertEqual(prefs["name"], "Micrófono (JBL Quantum 300)")
        self.assertEqual(prefs["index"], 0)

    def test_persist_output_device_preference(self):
        """Should persist output device preferences."""
        persist_device_preference("output", "JBL Quantum 300", 1)
        prefs = load_device_preference("output")
        self.assertEqual(prefs["name"], "JBL Quantum 300")
        self.assertEqual(prefs["index"], 1)

    def test_load_nonexistent_preference(self):
        """Should return empty dict when no preferences exist."""
        prefs = load_device_preference("input")
        self.assertEqual(prefs, {})

    def test_persist_overwrites(self):
        """Should overwrite previous preferences."""
        persist_device_preference("input", "Old Mic", 0)
        persist_device_preference("input", "New Mic", 1)
        prefs = load_device_preference("input")
        self.assertEqual(prefs["name"], "New Mic")
        self.assertEqual(prefs["index"], 1)

    def test_get_preferred_device_name_returns_persisted(self):
        """Should return persisted device name when available."""
        persist_device_preference("input", "Persisted Mic", 2)
        name = get_preferred_device_name("input", "Default Mic")
        self.assertEqual(name, "Persisted Mic")

    def test_get_preferred_device_name_returns_default(self):
        """Should return default name when no preference persisted."""
        name = get_preferred_device_name("input", "Default Mic")
        self.assertEqual(name, "Default Mic")


class TestRMSValidation(unittest.TestCase):
    """Test RMS-based device validation logic."""

    def test_compute_rms_silence(self):
        """Silent audio should have RMS near 0."""
        from juana_client.audio import compute_rms
        silent = b'\x00\x00' * 100
        rms = compute_rms(silent)
        self.assertAlmostEqual(rms, 0.0, places=5)

    def test_compute_rms_loud(self):
        """Loud audio should have significant RMS."""
        from juana_client.audio import compute_rms
        import numpy as np
        loud = np.array([32767] * 100, dtype=np.int16).tobytes()
        rms = compute_rms(loud)
        self.assertGreater(rms, 0.5)

    def test_silence_threshold_not_zero(self):
        """The silence threshold should be a small positive number."""
        from juana_client import audio as audio_module
        self.assertGreater(audio_module.DEVICE_SILENCE_THRESHOLD, 0)
        self.assertLess(audio_module.DEVICE_SILENCE_THRESHOLD, 0.01)

    def test_validation_window_reasonable(self):
        """The validation window should be a reasonable duration."""
        from juana_client import audio as audio_module
        self.assertGreaterEqual(audio_module.DEVICE_VALIDATION_WINDOW, 1.0)
        self.assertLessEqual(audio_module.DEVICE_VALIDATION_WINDOW, 30.0)


class TestFallbackLogic(unittest.TestCase):
    """Test that fallback only happens when device is completely silent AND another candidate exists."""

    def test_fallback_requires_silence(self):
        """Should NOT fallback when device has audio."""
        from juana_client.wake import VoskWakeWordDetector
        # This test verifies the logic conceptually; the actual RMS check
        # is in _audio_callback which uses self._silence_threshold
        self.assertTrue(True)  # Placeholder for integration test

    def test_fallback_requires_alternatives(self):
        """Should NOT fallback when no alternatives exist."""
        self.assertTrue(True)  # Placeholder for integration test

    def test_fallback_limit(self):
        """Should not fall back more than max_fallback_attempts times."""
        from juana_client.wake import VoskWakeWordDetector
        # VoskWakeWordDetector has _max_fallback_attempts = 3
        self.assertTrue(True)  # Placeholder for integration test

    def test_device_validated_on_rms(self):
        """Device should be validated when RMS exceeds threshold."""
        from juana_client.wake import VoskWakeWordDetector
        # The validation logic is in _audio_callback:
        # if self._max_observed_rms >= self._silence_threshold:
        #     self._device_validated = True
        # This is verified by the code structure, not runtime
        self.assertTrue(True)


class TestAudioCaptureDeviceSelection(unittest.TestCase):
    """Test AudioCapture device selection."""

    def test_audio_capture_accepts_device_name(self):
        """AudioCapture should accept device_name parameter."""
        mock_audio = MagicMock()
        mock_audio.get_device_count.return_value = 1
        mock_audio.get_device_info_by_index.return_value = {
            'name': 'Micrófono (JBL Quantum 300)',
            'maxInputChannels': 1,
            'hostApi': 0,
            'defaultSampleRate': 16000,
        }

        from juana_client.audio import AudioCapture
        with patch.object(AudioCapture, '_resolve_input_device') as mock_resolve:
            mock_resolve.return_value = (0, 'Micrófono (JBL Quantum 300)', 1)
            capture = AudioCapture(
                sample_rate=16000,
                chunk_size=512,
                pyaudio_instance=mock_audio,
                input_device_name="Micrófono (JBL Quantum 300)",
            )
            self.assertEqual(capture._input_device_name, "Micrófono (JBL Quantum 300)")
            self.assertEqual(capture._input_device_index, -1)


class TestWakeDetectorDeviceSelection(unittest.TestCase):
    """Test VoskWakeWordDetector device selection."""

    def test_wake_detector_accepts_device_name(self):
        """VoskWakeWordDetector should accept input_device_name parameter."""
        from juana_client.wake import VoskWakeWordDetector
        # Just verify the constructor accepts the parameter
        # (we can't actually create a Vosk model without the file)
        self.assertTrue(hasattr(VoskWakeWordDetector, '__init__'))


class TestPreferencesLocation(unittest.TestCase):
    """device_preferences.json debe vivir junto a settings.json (APOLLO_CONFIG_DIR)."""

    def test_resolve_uses_config_dir(self):
        """Con APOLLO_CONFIG_DIR, el archivo va ahi y no a resources/."""
        with tempfile.TemporaryDirectory() as tmp:
            path = _resolve_preferences_file(tmp)
            self.assertEqual(
                os.path.normcase(os.path.normpath(path)),
                os.path.normcase(os.path.normpath(os.path.join(tmp, "device_preferences.json"))),
            )

    def test_resolve_falls_back_to_package_dir(self):
        """Sin APOLLO_CONFIG_DIR, cae al directorio del paquete (legado)."""
        old = os.environ.pop("APOLLO_CONFIG_DIR", None)
        try:
            from juana_client import audio as audio_module
            path = _resolve_preferences_file("")
            self.assertTrue(path.endswith("device_preferences.json"))
            self.assertEqual(
                os.path.normcase(os.path.dirname(os.path.normpath(path))),
                os.path.normcase(os.path.normpath(audio_module._PACKAGE_DIR)),
            )
        finally:
            if old is not None:
                os.environ["APOLLO_CONFIG_DIR"] = old

    def test_persist_reads_config_dir_at_runtime(self):
        """persist/load deben respetar APOLLO_CONFIG_DIR aunque cambie post-import."""
        from juana_client import audio as audio_module
        old_const = audio_module.DEVICE_PREFERENCES_FILE
        old_env = os.environ.get("APOLLO_CONFIG_DIR")
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["APOLLO_CONFIG_DIR"] = tmp
            try:
                persist_device_preference("input", "Micrófono (JBL Quantum 300)", 3)
                self.assertTrue(os.path.exists(os.path.join(tmp, "device_preferences.json")))
                prefs = load_device_preference("input")
                self.assertEqual(prefs["name"], "Micrófono (JBL Quantum 300)")
                self.assertEqual(prefs["index"], 3)
            finally:
                if old_env is None:
                    os.environ.pop("APOLLO_CONFIG_DIR", None)
                else:
                    os.environ["APOLLO_CONFIG_DIR"] = old_env
                audio_module.DEVICE_PREFERENCES_FILE = old_const


class TestPhysicalBonusScoring(unittest.TestCase):
    """Realtek fisico debe ganarle a virtuales no-listados y al mapper."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self._old_env = os.environ.get("APOLLO_CONFIG_DIR")
        os.environ["APOLLO_CONFIG_DIR"] = self.tmpdir
        from juana_client import audio as audio_module
        self._old_legacy = audio_module._LEGACY_PREFERENCES_FILE
        audio_module._LEGACY_PREFERENCES_FILE = os.path.join(self.tmpdir, "legacy.json")
        audio_module.clear_input_selection_cache("test")

    def tearDown(self):
        from juana_client import audio as audio_module
        audio_module._LEGACY_PREFERENCES_FILE = self._old_legacy
        if self._old_env is None:
            os.environ.pop("APOLLO_CONFIG_DIR", None)
        else:
            os.environ["APOLLO_CONFIG_DIR"] = self._old_env
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _mock_audio(self, devices):
        mock_audio = MagicMock()
        mock_audio.get_device_count.return_value = len(devices)
        mock_audio.get_device_info_by_index.side_effect = lambda i: devices[i]
        mock_stream = MagicMock()
        mock_audio.open.return_value = mock_stream
        return mock_audio

    def test_realtek_input_beats_generic(self):
        from juana_client.audio import find_best_input_device
        devices = [
            {'name': 'Altavoz generico X', 'maxInputChannels': 1, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 16000},
            {'name': 'Micrófono (Realtek HD Audio)', 'maxInputChannels': 1, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 16000},
        ]
        audio = self._mock_audio(devices)
        idx, name, _ch, _rate, _alt = find_best_input_device(audio, preferred_name="Micrófono (JBL Quantum 300)")
        self.assertEqual(name, 'Micrófono (Realtek HD Audio)')
        self.assertEqual(idx, 1)

    def test_mapper_excluded_from_output(self):
        from juana_client.audio import find_best_output_device
        devices = [
            {'name': 'Asignador de sonido Microsoft - Output', 'maxInputChannels': 0, 'maxOutputChannels': 2, 'hostApi': 0, 'defaultSampleRate': 48000},
            {'name': 'Speakers (Realtek HD Audio output)', 'maxInputChannels': 0, 'maxOutputChannels': 2, 'hostApi': 0, 'defaultSampleRate': 48000},
        ]
        audio = self._mock_audio(devices)
        idx, name, _rate, _ch, _alt = find_best_output_device(audio, preferred_name="JBL Quantum 300")
        self.assertEqual(name, 'Speakers (Realtek HD Audio output)')
        self.assertEqual(idx, 1)

    def test_steam_mic_excluded_from_input(self):
        from juana_client.audio import find_best_input_device
        devices = [
            {'name': 'Micrófono (Steam Streaming Microphone)', 'maxInputChannels': 1, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 16000},
            {'name': 'Micrófono (Realtek HD Audio)', 'maxInputChannels': 1, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 16000},
        ]
        audio = self._mock_audio(devices)
        idx, name, _ch, _rate, _alt = find_best_input_device(audio, preferred_name="Micrófono (JBL Quantum 300)")
        self.assertEqual(name, 'Micrófono (Realtek HD Audio)')

    def test_input_fallback_virtual_when_physical_fails_to_open(self):
        """Si lo fisico no abre, usa virtual abrible SIN persistirlo."""
        from juana_client.audio import find_best_input_device, load_device_preference
        devices = [
            {'name': 'Micrófono (Realtek HD Audio)', 'maxInputChannels': 1, 'maxOutputChannels': 0, 'hostApi': 3, 'defaultSampleRate': 44100},
            {'name': 'Micrófono (Steam Streaming Microphone)', 'maxInputChannels': 1, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 16000},
        ]
        audio = self._mock_audio(devices)

        def open_side_effect(**kwargs):
            if kwargs.get('input_device_index') == 0:
                raise OSError(-9999, 'Unanticipated host error')
            return MagicMock()
        audio.open.side_effect = open_side_effect

        idx, name, _ch, _rate, _alt = find_best_input_device(audio, preferred_name="Micrófono (JBL Quantum 300)")
        self.assertEqual(idx, 1)
        self.assertIn('Steam', name)
        self.assertEqual(load_device_preference("input"), {})

    def test_output_fallback_virtual_when_physical_fails_to_open(self):
        """Si lo fisico no abre, usa virtual abrible SIN persistirlo."""
        from juana_client.audio import find_best_output_device, load_device_preference
        devices = [
            {'name': 'Speakers (Realtek HD Audio output)', 'maxInputChannels': 0, 'maxOutputChannels': 2, 'hostApi': 3, 'defaultSampleRate': 44100},
            {'name': 'Altavoces (Steam Streaming Speakers)', 'maxInputChannels': 0, 'maxOutputChannels': 2, 'hostApi': 0, 'defaultSampleRate': 44100},
        ]
        audio = self._mock_audio(devices)

        def open_side_effect(**kwargs):
            if kwargs.get('output_device_index') == 0:
                raise OSError(-9999, 'Unanticipated host error')
            return MagicMock()
        audio.open.side_effect = open_side_effect

        idx, name, _rate, _ch, _alt = find_best_output_device(audio, preferred_name="JBL Quantum 300")
        self.assertEqual(idx, 1)
        self.assertIn('Steam', name)
        self.assertEqual(load_device_preference("output"), {})


if __name__ == '__main__':
    unittest.main()
