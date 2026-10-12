"""Unit tests for robust audio device selection, filtering, and scoring."""

import sys
import os
import unittest
from unittest.mock import MagicMock, patch

# Ensure juana_client is in python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from juana_client.audio import (
    IGNORED_INPUT_KEYWORDS,
    IGNORED_OUTPUT_KEYWORDS,
    is_device_ignored,
    find_best_input_device,
    find_best_output_device,
)


class TestDeviceFiltering(unittest.TestCase):
    def test_ignored_input_devices(self):
        blacklisted = [
            "Virtual Mic (Virtual Mic for AudioRelay)",
            "Virtual Mic (Virtual Mic for Au",
            "AudioRelay Wave",
            "Mezcla estéreo (Realtek HD Audio Stereo input)",
            "Mezcla estereo",
            "Stereo Mix (Realtek Audio)",
            "Línea de entrada (Realtek HD Audio Line input)",
            "Linea de entrada",
            "Line in (High Definition Audio)",
            "Controlador primario de captura de sonido",
            "Primary Sound Capture Driver",
            "Asignador de sonido Microsoft - Input",
            "Microsoft Sound Mapper - Input",
        ]
        for name in blacklisted:
            self.assertTrue(
                is_device_ignored(name, IGNORED_INPUT_KEYWORDS),
                f"Expected '{name}' to be ignored for input",
            )

    def test_allowed_input_devices(self):
        allowed = [
            "Micrófono (JBL Quantum 300)",
            "Microfono (JBL Quantum 300)",
            "JBL Quantum 300 Headset Mic",
            "Micrófono (Realtek HD Audio Mic input)",
            "USB Audio Device Microphone",
        ]
        for name in allowed:
            self.assertFalse(
                is_device_ignored(name, IGNORED_INPUT_KEYWORDS),
                f"Expected '{name}' NOT to be ignored for input",
            )

    def test_ignored_output_devices(self):
        blacklisted = [
            "Virtual Mic (AudioRelay Wave)",
            "Line Out (AudioRelay Wave)",
            "Stereo Mix",
            "Mezcla estéreo",
        ]
        for name in blacklisted:
            self.assertTrue(
                is_device_ignored(name, IGNORED_OUTPUT_KEYWORDS),
                f"Expected '{name}' to be ignored for output",
            )

    def test_allowed_output_devices(self):
        allowed = [
            "Altavoces (JBL Quantum 300)",
            "Speakers (JBL Quantum 300)",
            "Speakers (Realtek HD Audio output)",
            "Headphones (High Definition Audio)",
        ]
        for name in allowed:
            self.assertFalse(
                is_device_ignored(name, IGNORED_OUTPUT_KEYWORDS),
                f"Expected '{name}' NOT to be ignored for output",
            )


class TestDeviceSelection(unittest.TestCase):
    def setUp(self):
        self.mock_audio = MagicMock()

    def test_input_prefers_jbl_quantum_300(self):
        # Setup mock devices
        devices = [
            # 0: Blacklisted
            {'index': 0, 'name': 'Asignador de sonido Microsoft - Input', 'maxInputChannels': 2, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 44100},
            # 1: Blacklisted
            {'index': 1, 'name': 'Virtual Mic (Virtual Mic for AudioRelay)', 'maxInputChannels': 2, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 44100},
            # 2: Generic physical mic
            {'index': 2, 'name': 'Micrófono (Realtek HD Audio)', 'maxInputChannels': 2, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 44100},
            # 3: Preferred mic!
            {'index': 3, 'name': 'Micrófono (JBL Quantum 300)', 'maxInputChannels': 1, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 16000},
        ]
        self.mock_audio.get_device_count.return_value = len(devices)
        self.mock_audio.get_device_info_by_index.side_effect = lambda i: devices[i]
        
        # Mock stream open to succeed
        mock_stream = MagicMock()
        self.mock_audio.open.return_value = mock_stream

        idx, name, ch, alts = find_best_input_device(
            self.mock_audio,
            preferred_name="Micrófono (JBL Quantum 300)",
            sample_rate=16000,
        )

        self.assertEqual(idx, 3)
        self.assertEqual(name, 'Micrófono (JBL Quantum 300)')
        self.assertEqual(ch, 1)
        # Verify alternatives contains the generic mic (index 2) but NOT virtual mics (0, 1)
        alt_indices = [a['index'] for a in alts]
        self.assertIn(2, alt_indices)
        self.assertNotIn(0, alt_indices)
        self.assertNotIn(1, alt_indices)

    def test_input_fallback_when_jbl_not_present(self):
        # Setup mock devices without JBL
        devices = [
            {'index': 0, 'name': 'Virtual Mic (Virtual Mic for AudioRelay)', 'maxInputChannels': 2, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 44100},
            {'index': 1, 'name': 'Micrófono (Realtek USB Audio)', 'maxInputChannels': 1, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 44100},
        ]
        self.mock_audio.get_device_count.return_value = len(devices)
        self.mock_audio.get_device_info_by_index.side_effect = lambda i: devices[i]

        mock_stream = MagicMock()
        self.mock_audio.open.return_value = mock_stream

        idx, name, ch, alts = find_best_input_device(
            self.mock_audio,
            preferred_name="Micrófono (JBL Quantum 300)",
            sample_rate=16000,
        )

        # Should fall back to Realtek USB Audio, NEVER Virtual Mic
        self.assertEqual(idx, 1)
        self.assertEqual(name, 'Micrófono (Realtek USB Audio)')

    def test_output_prefers_jbl_and_ignores_audiorelay(self):
        devices = [
            # 0: Input only (should be ignored)
            {'index': 0, 'name': 'Micrófono (Realtek)', 'maxInputChannels': 2, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 44100},
            # 1: AudioRelay Wave output (blacklisted)
            {'index': 1, 'name': 'Line Out (AudioRelay Wave)', 'maxInputChannels': 0, 'maxOutputChannels': 2, 'hostApi': 0, 'defaultSampleRate': 44100},
            # 2: Generic Speakers
            {'index': 2, 'name': 'Speakers (Realtek HD Audio)', 'maxInputChannels': 0, 'maxOutputChannels': 2, 'hostApi': 0, 'defaultSampleRate': 48000},
            # 3: Preferred JBL output
            {'index': 3, 'name': 'Altavoces (JBL Quantum 300)', 'maxInputChannels': 0, 'maxOutputChannels': 2, 'hostApi': 0, 'defaultSampleRate': 48000},
        ]
        self.mock_audio.get_device_count.return_value = len(devices)
        self.mock_audio.get_device_info_by_index.side_effect = lambda i: devices[i]

        mock_stream = MagicMock()
        self.mock_audio.open.return_value = mock_stream

        idx, name, rate, ch, alts = find_best_output_device(
            self.mock_audio,
            preferred_name="JBL Quantum 300",
            sample_rate=24000,
        )

        self.assertEqual(idx, 3)
        self.assertEqual(name, 'Altavoces (JBL Quantum 300)')
        # Alternatives should have Realtek (2) but NOT AudioRelay (1) or Input (0)
        alt_indices = [a['index'] for a in alts]
        self.assertIn(2, alt_indices)
        self.assertNotIn(1, alt_indices)
        self.assertNotIn(0, alt_indices)


if __name__ == "__main__":
    unittest.main()
