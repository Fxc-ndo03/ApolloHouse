"""Unit tests for SpeechEndpoint (silence endpointing, deterministic)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from juana_client.audio import SpeechEndpoint


def _feed(endpoint: SpeechEndpoint, rms_list: list, chunk_ms: float = 40.0) -> int | None:
    """Feed RMS values; return index of first True (endpoint) or None."""
    for index, rms in enumerate(rms_list):
        if endpoint.update(rms, chunk_ms):
            return index
    return None


class TestSpeechEndpoint(unittest.TestCase):
    def test_silence_only_never_endpoints(self):
        """Silencio puro jamas termina por endpoint (solo max_turn)."""
        endpoint = SpeechEndpoint(silence_ms=600.0, min_speech_ms=250.0,
                                  max_turn_ms=1_000_000.0, rms_threshold=0.02)
        self.assertIsNone(_feed(endpoint, [0.0] * 200))
        self.assertFalse(endpoint.speech_started)

    def test_speech_then_silence_endpoints(self):
        """Habla + 600ms de silencio => endpoint por silencio."""
        endpoint = SpeechEndpoint(silence_ms=600.0, min_speech_ms=250.0,
                                  max_turn_ms=1_000_000.0, rms_threshold=0.02)
        chunks = [0.10] * 10 + [0.0] * 15  # 400ms habla + 600ms silencio
        index = _feed(endpoint, chunks)
        self.assertIsNotNone(index)
        self.assertEqual(endpoint.end_reason, "silence")
        # 10 habla (400ms) + 15 silencio (600ms): termina en el ultimo
        self.assertEqual(index, 24)

    def test_short_blip_ignored(self):
        """Rafaga < min_speech_ms no arma endpoint aunque siga silencio."""
        endpoint = SpeechEndpoint(silence_ms=600.0, min_speech_ms=250.0,
                                  max_turn_ms=1_000_000.0, rms_threshold=0.02)
        chunks = [0.10] * 3 + [0.0] * 40  # 120ms habla + 1600ms silencio
        self.assertIsNone(_feed(endpoint, chunks))
        self.assertFalse(endpoint.speech_started)

    def test_scattered_fragments_do_not_start_speech(self):
        """Fragmentos dispersos (dictado palabra-por-palabra) no deben
        acumular speech_ms a lo largo del turno: la puerta exige energia
        SOSTENIDA (campo: 5 rafagas aisladas falsificaban el inicio)."""
        endpoint = SpeechEndpoint(silence_ms=600.0, min_speech_ms=250.0,
                                  max_turn_ms=1_000_000.0, rms_threshold=0.02)
        chunks = []
        for _ in range(5):
            chunks += [0.10] * 2 + [0.0] * 60  # 80ms habla + 2400ms pausa
        self.assertIsNone(_feed(endpoint, chunks))
        self.assertFalse(endpoint.speech_started)

    def test_sustained_speech_with_micro_gap_starts(self):
        """Habla sostenida con micro-corte (<120ms) igual inicia."""
        endpoint = SpeechEndpoint(silence_ms=600.0, min_speech_ms=250.0,
                                  max_turn_ms=1_000_000.0, rms_threshold=0.02)
        chunks = [0.10] * 5 + [0.0] * 2 + [0.10] * 5  # 200+80gap+200ms
        _feed(endpoint, chunks)
        self.assertTrue(endpoint.speech_started)

    def test_silence_resets_on_speech(self):
        """Habla intermitente reinicia el contador de silencio."""
        endpoint = SpeechEndpoint(silence_ms=600.0, min_speech_ms=250.0,
                                  max_turn_ms=1_000_000.0, rms_threshold=0.02)
        chunks = [0.10] * 10 + [0.0] * 10 + [0.10] * 10 + [0.0] * 15
        index = _feed(endpoint, chunks)
        self.assertIsNotNone(index)
        # El endpoint cae al final, no en el primer bloque de silencio
        self.assertGreater(index, 19)
        self.assertEqual(endpoint.end_reason, "silence")

    def test_max_turn_forces_end(self):
        """Sin habla, max_turn corta igual (backstop)."""
        endpoint = SpeechEndpoint(silence_ms=600.0, min_speech_ms=250.0,
                                  max_turn_ms=1000.0, rms_threshold=0.02)
        index = _feed(endpoint, [0.0] * 100)
        self.assertIsNotNone(index)
        self.assertEqual(endpoint.end_reason, "max_turn")
        self.assertEqual(index, 24)  # 25 chunks * 40ms = 1000ms

    def test_end_is_sticky(self):
        """Una vez terminado, update sigue devolviendo True."""
        endpoint = SpeechEndpoint(silence_ms=200.0, min_speech_ms=80.0,
                                  max_turn_ms=1_000_000.0, rms_threshold=0.02)
        _feed(endpoint, [0.10] * 5 + [0.0] * 10)
        self.assertTrue(endpoint.ended)
        self.assertTrue(endpoint.update(0.10, 40.0))

    def test_threshold_boundary(self):
        """RMS justo en el threshold cuenta como habla."""
        endpoint = SpeechEndpoint(silence_ms=600.0, min_speech_ms=200.0,
                                  max_turn_ms=1_000_000.0, rms_threshold=0.02)
        _feed(endpoint, [0.02] * 5)
        self.assertTrue(endpoint.speech_started)
        endpoint2 = SpeechEndpoint(silence_ms=600.0, min_speech_ms=200.0,
                                   max_turn_ms=1_000_000.0, rms_threshold=0.02)
        _feed(endpoint2, [0.019] * 5)
        self.assertFalse(endpoint2.speech_started)

    def test_noisy_silence_endpoints_via_relative_drop(self):
        """Habla real + 'silencio' con piso de ruido POR ENCIMA del threshold.

        Regresion del turno real: el mic deja ~0.03 de piso y el endpoint
        absoluto jamas disparaba (12 s siempre). Con caida relativa al pico
        debe cortar ~600 ms despues del ultimo habla, no a los 12 s.
        """
        endpoint = SpeechEndpoint(silence_ms=600.0, min_speech_ms=250.0,
                                  max_turn_ms=12000.0, rms_threshold=0.02)
        chunks = [0.30] * 10 + [0.03] * 15  # 400ms habla + 600ms piso ruidoso
        index = _feed(endpoint, chunks)
        self.assertIsNotNone(index)
        self.assertEqual(endpoint.end_reason, "silence")
        # 10 habla + 15 silencio = 25 chunks => indice 24 (~1000 ms, no 12000)
        self.assertEqual(index, 24)
        self.assertLess(endpoint.elapsed_ms, 2000.0)

    def test_short_pause_does_not_end(self):
        """Pausa corta (<600 ms) no corta el turno."""
        endpoint = SpeechEndpoint(silence_ms=600.0, min_speech_ms=250.0,
                                  max_turn_ms=1_000_000.0, rms_threshold=0.02)
        chunks = [0.30] * 10 + [0.0] * 10  # 400ms habla + 400ms pausa
        self.assertIsNone(_feed(endpoint, chunks))
        self.assertTrue(endpoint.speech_started)
        self.assertFalse(endpoint.ended)


if __name__ == "__main__":
    unittest.main()
