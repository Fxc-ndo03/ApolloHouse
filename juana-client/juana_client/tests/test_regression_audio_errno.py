"""Regresión FASE 4.00 — registro de errno en errores de audio.

Verifica que los errores de apertura de dispositivo capturan errno
para facilitar el diagnóstico del problema Realtek / -9999.
"""

import unittest
from unittest.mock import MagicMock
import sys
sys.path.insert(0, '.')

from juana_client.audio import _try_open_input, _try_open_output


class MockAudio:
    def open(self, **kwargs):
        raise OSError(-9999, "OSError: [Errno -9999] Unspecified error")


class RegressionAudioErrornoTest(unittest.TestCase):
    def test_try_open_input_captures_errno_minus_9999(self):
        audio = MockAudio()
        result = _try_open_input(audio, 0, 1, [16000])
        self.assertIsNone(result)

    def test_try_open_output_captures_errno_minus_9999(self):
        audio = MockAudio()
        result = _try_open_output(audio, 0, 1, 16000, 16000)
        self.assertIsNone(result)


if __name__ == '__main__':
    unittest.main()
