"""Unit tests for STT signal quality: auto-gain, resampling, signal probe.

Contexto: el JBL entrega voz real pero 20-30 dB por debajo (picos ~0.08,
RMS 0.0001-0.01). Vosk vacio +Endpoint por max_turn. Estos tests pinnean
(CI-safe, sin hardware):
- apply_auto_gain: silencio intacto, voz fuerte intacta, voz debil
  normalizada hacia el objetivo con techo de ganancia.
- resample_mono_pcm: un tono de 440 Hz sobrevive 48k->16k sin perder
  frecuencia dominante ni amplitud (sin degradacion).
- probe_candidate_signal + desempate: entre duplicados con el mismo nombre
  (JBL en MME/DirectSound/WASAPI) gana el que entregue senal real, no el
  de indice mas bajo.
"""

import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from juana_client.audio import (
    apply_auto_gain,
    compute_rms,
    probe_candidate_signal,
    resample_mono_pcm,
)


def _pcm(peak_float: float, frames: int = 1024) -> bytes:
    return np.full(frames, int(peak_float * 32768), dtype=np.int16).tobytes()


class TestAutoGainMath(unittest.TestCase):
    def test_silence_untouched(self):
        self.assertEqual(apply_auto_gain(b"\x00" * 2048), b"\x00" * 2048)

    def test_near_silence_untouched(self):
        near = _pcm(0.001)
        self.assertEqual(apply_auto_gain(near), near)

    def test_loud_untouched(self):
        loud = _pcm(0.4)
        self.assertEqual(apply_auto_gain(loud), loud)

    def test_weak_voice_normalized_toward_target(self):
        out = np.frombuffer(apply_auto_gain(_pcm(0.05)), dtype=np.int16)
        peak = np.abs(out).max() / 32768.0
        self.assertGreater(peak, 0.3)
        self.assertLessEqual(peak, 0.55)

    def test_gain_capped(self):
        out = np.frombuffer(apply_auto_gain(_pcm(0.01)), dtype=np.int16)
        peak = np.abs(out).max() / 32768.0
        # 0.01 * 15 (techo) = 0.15, no llega al objetivo 0.5 pero no explota.
        self.assertAlmostEqual(peak, 0.15, delta=0.02)


class TestFixedGain(unittest.TestCase):
    def test_preserves_dynamics_between_chunks(self):
        """La ganancia fija escala sin igualar: la razon fuerte/debil vive."""
        from juana_client.audio import apply_fixed_gain
        loud = _pcm(0.03)
        soft = _pcm(0.005)
        out_loud = np.abs(np.frombuffer(apply_fixed_gain(loud), dtype=np.int16)).max()
        out_soft = np.abs(np.frombuffer(apply_fixed_gain(soft), dtype=np.int16)).max()
        self.assertAlmostEqual(out_loud / out_soft, 0.03 / 0.005, delta=0.05)

    def test_clips_at_full_scale(self):
        from juana_client.audio import apply_fixed_gain
        out = np.frombuffer(apply_fixed_gain(_pcm(0.4), 8.0), dtype=np.int16)
        self.assertEqual(np.abs(out).max(), 32767)

    def test_gain_one_is_passthrough(self):
        from juana_client.audio import apply_fixed_gain
        pcm = _pcm(0.05)
        self.assertEqual(apply_fixed_gain(pcm, 1.0), pcm)

    def test_stt_gain_defaults_to_fixed(self):
        """apply_stt_gain por defecto == fixed x8 (no per-chunk auto)."""
        from juana_client import audio as audio_module
        from juana_client.audio import apply_fixed_gain, apply_stt_gain
        old_mode = audio_module.STT_GAIN_MODE
        audio_module.STT_GAIN_MODE = "fixed"
        try:
            pcm = _pcm(0.02)
            self.assertEqual(apply_stt_gain(pcm), apply_fixed_gain(pcm, 8.0))
        finally:
            audio_module.STT_GAIN_MODE = old_mode


class TestStreamingAgc(unittest.TestCase):
    def _tone(self, peak: float, freq: float = 440.0, frames: int = 512) -> bytes:
        t = np.arange(frames) / 16000.0
        return (np.sin(2 * np.pi * freq * t) * peak * 32767).astype(np.int16).tobytes()

    def test_adapts_down_fast_on_loud(self):
        """Voz fuerte sostenida: la ganancia baja en ~15 chunks (anti-clip)."""
        from juana_client.audio import StreamingAgc
        agc = StreamingAgc()
        loud = self._tone(0.4)
        for _ in range(15):
            out = agc.process(loud)
        peak = np.abs(np.frombuffer(out, dtype=np.int16)).max() / 32768.0
        self.assertLess(peak, 0.45)
        self.assertGreater(agc.gain, 0.9)
        self.assertLess(agc.gain, 2.0)

    def test_adapts_up_slowly_on_quiet(self):
        """Voz debil sostenida: la ganancia sube sin bombear de golpe."""
        from juana_client.audio import StreamingAgc
        agc = StreamingAgc(init_gain=1.0)
        quiet = self._tone(0.01)
        first = np.abs(np.frombuffer(agc.process(quiet), dtype=np.int16)).max()
        for _ in range(200):
            out = agc.process(quiet)
        last = np.abs(np.frombuffer(out, dtype=np.int16)).max()
        self.assertGreater(last, first * 3)
        self.assertLessEqual(agc.gain, 12.0)

    def test_silence_freezes_gain(self):
        """Chunks silenciosos no mueven la ganancia."""
        from juana_client.audio import StreamingAgc
        agc = StreamingAgc(init_gain=5.0)
        agc.process(b"\x00" * 1024)
        agc.process(self._tone(0.0005))
        self.assertEqual(agc.gain, 5.0)

    def test_preserves_relative_dynamics(self):
        """Tras adaptarse, la razon fuerte/debil se preserva (RMS, robusto)."""
        from juana_client.audio import StreamingAgc
        agc = StreamingAgc(init_gain=4.0, attack=1.0, release=0.0)
        long_tone = lambda peak: self._tone(peak, frames=4096)
        agc.process(long_tone(0.075))  # fija ganancia: 0.3/0.075 = 4.0
        out_loud = np.frombuffer(agc.process(long_tone(0.06)), dtype=np.int16)
        out_soft = np.frombuffer(agc.process(long_tone(0.02)), dtype=np.int16)
        rms = lambda a: float(np.sqrt(np.mean(a.astype(np.float64) ** 2)))
        self.assertAlmostEqual(rms(out_loud) / rms(out_soft), 3.0, delta=0.1)

    def test_soft_knee_prevents_digital_clip(self):
        """Transitorio fuerte: el codo suave evita clip digital duro."""
        from juana_client.audio import StreamingAgc
        agc = StreamingAgc(init_gain=8.0, attack=0.0)  # ganancia clavada
        out = np.frombuffer(agc.process(self._tone(0.15)), dtype=np.int16)
        peak = np.abs(out).max() / 32768.0
        self.assertLess(peak, 0.99)
        self.assertGreater(peak, 0.7)  # comprime, no aplasta


class TestResampleFidelity(unittest.TestCase):
    def test_tone_survives_48k_to_16k(self):
        freq = 440.0
        seconds = 0.5
        t = np.arange(int(48000 * seconds)) / 48000.0
        tone48 = (0.3 * np.sin(2 * np.pi * freq * t) * 32767).astype(np.int16)
        out = np.frombuffer(
            resample_mono_pcm(tone48.tobytes(), 48000, 16000), dtype=np.int16
        ).astype(np.float32)
        spectrum = np.abs(np.fft.rfft(out))
        freqs = np.fft.rfftfreq(len(out), 1.0 / 16000.0)
        dominant = freqs[int(np.argmax(spectrum))]
        self.assertAlmostEqual(dominant, freq, delta=10.0)
        out_peak = np.abs(out).max() / 32768.0
        self.assertGreater(out_peak, 0.2)
        self.assertLess(out_peak, 0.4)

    def test_resample_preserves_rms(self):
        rng = np.random.RandomState(7)
        noise = (rng.standard_normal(16000) * 5000).astype(np.int16)
        out = np.frombuffer(
            resample_mono_pcm(noise.tobytes(), 16000, 16000), dtype=np.int16
        )
        self.assertAlmostEqual(compute_rms(out.tobytes()), compute_rms(noise.tobytes()), delta=0.005)


class TestSignalProbeTiebreak(unittest.TestCase):
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

    def _mock_audio(self, devices, pcm_by_index):
        mock_audio = MagicMock()
        mock_audio.get_device_count.return_value = len(devices)
        mock_audio.get_device_info_by_index.side_effect = lambda i: devices[i]

        def open_side_effect(**kwargs):
            idx = kwargs.get("input_device_index", -1)
            stream = MagicMock()
            stream.read.return_value = pcm_by_index.get(idx, b"\x00" * 2048)
            return stream

        mock_audio.open.side_effect = open_side_effect
        return mock_audio

    def _jbl_pair(self):
        return [
            {'name': 'Micrófono (JBL Quantum 300)', 'maxInputChannels': 2, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 44100},
            {'name': 'Micrófono (JBL Quantum 300)', 'maxInputChannels': 2, 'maxOutputChannels': 0, 'hostApi': 2, 'defaultSampleRate': 48000},
        ]

    def test_probe_measures_silence_as_zero_rms(self):
        audio = self._mock_audio([], {})
        sig = probe_candidate_signal(audio, 0, 16000, 1, duration_ms=100.0)
        self.assertEqual(sig["rms_max"], 0.0)
        self.assertGreater(sig["windows"], 0)

    def test_probe_measures_loud_device(self):
        audio = self._mock_audio([], {5: _pcm(0.2, frames=1024)})
        sig = probe_candidate_signal(audio, 5, 16000, 1, duration_ms=100.0)
        self.assertGreater(sig["windows"], 0)
        self.assertAlmostEqual(sig["rms_max"], 0.2, delta=0.01)

    def test_louder_duplicate_wins_over_lower_index(self):
        from juana_client.audio import find_best_input_device
        devices = self._jbl_pair()
        pcm = {0: b"\x00" * 2048, 1: _pcm(0.1, frames=1024)}
        audio = self._mock_audio(devices, pcm)
        idx, _name, _ch, _rate, _alt = find_best_input_device(
            audio, preferred_name="Micrófono (JBL Quantum 300)"
        )
        self.assertEqual(idx, 1)

    def test_silent_duplicate_loses(self):
        from juana_client.audio import find_best_input_device
        devices = self._jbl_pair()
        pcm = {0: _pcm(0.1, frames=1024), 1: b"\x00" * 2048}
        audio = self._mock_audio(devices, pcm)
        idx, _name, _ch, _rate, _alt = find_best_input_device(
            audio, preferred_name="Micrófono (JBL Quantum 300)"
        )
        self.assertEqual(idx, 0)

    def test_distinct_names_keep_score_order(self):
        """Sin duplicados no hay sonda que altere el orden por escore."""
        from juana_client.audio import find_best_input_device
        devices = [
            {'name': 'Micrófono (JBL Quantum 300)', 'maxInputChannels': 2, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 44100},
            {'name': 'Micrófono (Realtek HD Audio)', 'maxInputChannels': 2, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 44100},
        ]
        pcm = {0: b"\x00" * 2048, 1: _pcm(0.3, frames=1024)}
        audio = self._mock_audio(devices, pcm)
        idx, name, _ch, _rate, _alt = find_best_input_device(
            audio, preferred_name="Micrófono (JBL Quantum 300)"
        )
        self.assertEqual(idx, 0)
        self.assertIn("JBL", name)

    def test_fullscale_garbage_duplicate_excluded(self):
        """Basura digital (pico 32765 + RMS alto) pierde contra sano silencioso."""
        from juana_client.audio import find_best_input_device
        devices = self._jbl_pair()
        pcm = {0: b"\x00" * 2048, 1: _pcm(0.99, frames=1024)}
        audio = self._mock_audio(devices, pcm)
        idx, _name, _ch, _rate, _alt = find_best_input_device(
            audio, preferred_name="Micrófono (JBL Quantum 300)"
        )
        self.assertEqual(idx, 0)

    def test_probe_reports_dc_offset(self):
        audio = self._mock_audio([], {5: _pcm(0.2, frames=1024)})
        sig = probe_candidate_signal(audio, 5, 16000, 1, duration_ms=100.0)
        self.assertAlmostEqual(sig["dc_offset"], 0.2 * 32768, delta=1500)

    def test_signal_history_prefers_proven_endpoint(self):
        """Con historial de voz real, el endpoint probado gana aun en silencio."""
        import json
        from juana_client.audio import find_best_input_device
        prefs_path = os.path.join(self.tmpdir, "device_preferences.json")
        with open(prefs_path, "w", encoding="utf-8") as f:
            json.dump({
                "input_signal_history": {
                    "micrófono (jbl quantum 300)|host2": {
                        "speech_rms": 0.05, "turns": 3,
                    },
                },
            }, f)
        devices = self._jbl_pair()
        pcm = {0: b"\x00" * 2048, 1: b"\x00" * 2048}
        audio = self._mock_audio(devices, pcm)
        idx, _name, _ch, _rate, _alt = find_best_input_device(
            audio, preferred_name="Micrófono (JBL Quantum 300)"
        )
        self.assertEqual(idx, 1)

    def test_silent_duplicates_keep_deterministic_order(self):
        """Dos duplicados en silencio empatan bajo el piso: gana el de menor indice."""
        from juana_client.audio import find_best_input_device
        devices = self._jbl_pair()
        pcm = {0: b"\x01\x00" * 1024, 1: b"\x02\x00" * 1024}
        audio = self._mock_audio(devices, pcm)
        idx, _name, _ch, _rate, _alt = find_best_input_device(
            audio, preferred_name="Micrófono (JBL Quantum 300)"
        )
        self.assertEqual(idx, 0)

    def test_note_signal_quality_keeps_max(self):
        from juana_client.audio import note_input_signal_quality, _load_device_preferences
        note_input_signal_quality("mic x", 0, 0.03)
        note_input_signal_quality("mic x", 0, 0.01)
        note_input_signal_quality("mic x", 0, 0.07)
        hist = _load_device_preferences().get("input_signal_history", {})
        self.assertAlmostEqual(hist["mic x|host0"]["speech_rms"], 0.07)
        self.assertEqual(hist["mic x|host0"]["turns"], 3)


def _tone(peak: float, freq: float = 440.0, frames: int = 640, rate: int = 16000) -> bytes:
    t = np.arange(frames) / float(rate)
    return (np.sin(2 * np.pi * freq * t) * peak * 32767).astype(np.int16).tobytes()


class TestNoisyConditions(unittest.TestCase):
    """Casos acusticos adversos deterministicos (req. 11)."""

    def test_low_voice_gets_lifted_to_target(self):
        """Voz baja (pico 0.02, como el JBL) sube hacia el objetivo sin clip."""
        from juana_client.audio import StreamingAgc
        agc = StreamingAgc(noise_floor=0.000015)
        out = None
        for _ in range(120):
            out = agc.process(_tone(0.02, frames=512))
        peak = np.abs(np.frombuffer(out, dtype=np.int16)).max() / 32768.0
        self.assertGreater(peak, 0.1)
        self.assertLess(peak, 0.6)

    def test_low_noise_floor_drops_gate(self):
        """Piso bajisimo: el gate adaptativo baja al minimo y pesca susurros."""
        from juana_client.audio import SpeechEndpoint
        ep = SpeechEndpoint(noise_floor=0.0001)
        self.assertLess(ep.gate, 0.012)
        for _ in range(10):
            if ep.update(0.006, 40.0):
                break
        self.assertTrue(ep.speech_started)

    def test_pure_silence_never_starts(self):
        """Silencio puro jamas inicia habla (sin falsos positivos)."""
        from juana_client.audio import SpeechEndpoint
        ep = SpeechEndpoint(noise_floor=0.000015, max_turn_ms=1_000_000.0)
        for _ in range(300):
            self.assertFalse(ep.update(0.0, 40.0))
        self.assertFalse(ep.speech_started)

    def test_sustained_clipping_marks_degraded(self):
        """Clip sostenido post-gain -> clipping_ratio alto -> degraded."""
        from juana_client.audio import compute_turn_health
        n = 100
        rms = [0.5] * n
        peaks = [0.99] * n
        h = compute_turn_health(
            rms_list=rms, peak_list=peaks, gain_avg=1.0, gate=0.012,
            noise_floor=0.001, speech_started=True, speech_ms=4000.0,
            endpoint_reason="silence", transcript_chars=10,
        )
        self.assertGreater(h["clipping_ratio"], 0.5)
        self.assertEqual(h["quality"], "degraded")

    def test_dc_offset_scores_as_garbage(self):
        """DC alto + clip: la sonda lo marca basura con razon explicita."""
        from juana_client.audio import score_probe_for_selection
        key, reason = score_probe_for_selection(
            {"peak": 32764, "rms_max": 0.43, "dc_offset": 2600.0}
        )
        self.assertLess(key[0], 0)
        self.assertIn("garbage", reason)

    def test_dc_does_not_drive_agc(self):
        """Un offset DC sostenido lo mata el pasa-altos: en regimen la
        ganancia queda congelada (el transitorio de conexion es inevitable
        y breve, no persistente)."""
        from juana_client.audio import StreamingAgc
        agc = StreamingAgc(init_gain=6.0)
        dc = (np.full(512, 8000, dtype=np.int16)).tobytes()
        for _ in range(50):  # asienta el pasa-altos
            agc.process(dc)
        frozen = agc.gain
        for _ in range(10):
            agc.process(dc)
        self.assertEqual(agc.gain, frozen)

    def test_voice_plus_noise_endpoints(self):
        """Voz sobre piso ruidoso (0.03): el gate queda en config y el corte
        relativo termina el turno igual."""
        from juana_client.audio import SpeechEndpoint
        ep = SpeechEndpoint(rms_threshold=0.012, noise_floor=0.03)
        self.assertLessEqual(ep.gate, 0.012)
        seq = [0.30] * 10 + [0.03] * 20
        idx = None
        for i, r in enumerate(seq):
            if ep.update(r, 40.0):
                idx = i
                break
        self.assertIsNotNone(idx)
        self.assertEqual(ep.end_reason, "silence")

    def test_low_but_intelligible_voice_proxy(self):
        """Voz baja pero sostenida (silabas simuladas a pico 0.008): el AGC
        la levanta, el endpoint la delimita y el health NO es bad.
        (Proxy deterministico; la inteligibilidad real la prueba sapi_ref.)"""
        from juana_client.audio import StreamingAgc, SpeechEndpoint, compute_turn_health, compute_rms, peak_of_pcm
        agc = StreamingAgc(noise_floor=0.000015)
        ep = SpeechEndpoint(noise_floor=0.0001)
        syl = _tone(0.008, freq=300.0, frames=2400)  # silaba 150ms
        gap = b"\x00" * 1600  # 100ms
        stream = (syl + gap) * 6
        chunks = [stream[i:i + 1280] for i in range(0, len(stream), 1280)]
        rms_list, peak_list = [], []
        for c in chunks:
            g = agc.process(c)
            r = compute_rms(g)
            rms_list.append(r)
            peak_list.append(peak_of_pcm(g))
            ep.update(r, 40.0)
        for _ in range(20):  # 800ms de silencio final
            c = b"\x00" * 1280
            r = compute_rms(agc.process(c))
            rms_list.append(r)
            peak_list.append(peak_of_pcm(c))
            if ep.update(r, 40.0):
                break
        self.assertTrue(ep.speech_started)
        self.assertEqual(ep.end_reason, "silence")
        h = compute_turn_health(
            rms_list=rms_list, peak_list=peak_list, gain_avg=agc.stats()["gain_avg"],
            gate=ep.gate, noise_floor=ep.noise_floor, speech_started=ep.speech_started,
            speech_ms=ep.speech_ms, endpoint_reason=ep.end_reason, transcript_chars=30,
        )
        self.assertIn(h["quality"], ("good", "degraded"))


class TestTurnHealth(unittest.TestCase):
    def test_good_turn(self):
        from juana_client.audio import compute_turn_health
        rms = [0.0001] * 50 + [0.07] * 300 + [0.0001] * 50
        peaks = [min(r * 3, 0.5) for r in rms]
        h = compute_turn_health(
            rms_list=rms, peak_list=peaks, gain_avg=8.0, gate=0.004,
            noise_floor=0.0001, speech_started=True, speech_ms=4000.0,
            endpoint_reason="silence", transcript_chars=20,
        )
        self.assertEqual(h["quality"], "good")
        self.assertGreater(h["snr_db"], 15.0)
        for k in ("signal_rms", "noise_rms", "snr_db", "peak", "clipping_ratio",
                  "gain_applied", "endpoint", "sample_rate", "quality"):
            self.assertIn(k, h)

    def test_bad_quiet_turn(self):
        from juana_client.audio import compute_turn_health
        rms = [0.00002] * 300
        h = compute_turn_health(
            rms_list=rms, peak_list=[0.0001] * 300, gain_avg=12.0, gate=0.004,
            noise_floor=0.00002, speech_started=False, speech_ms=0.0,
            endpoint_reason="max_turn", transcript_chars=0,
        )
        self.assertEqual(h["quality"], "bad")

    def test_bad_low_snr(self):
        from juana_client.audio import compute_turn_health
        rms = [0.0015] * 300
        h = compute_turn_health(
            rms_list=rms, peak_list=[0.0045] * 300, gain_avg=12.0, gate=0.004,
            noise_floor=0.001, speech_started=True, speech_ms=4000.0,
            endpoint_reason="silence", transcript_chars=5,
        )
        self.assertLess(h["snr_db"], 6.0)
        self.assertEqual(h["quality"], "bad")

    def test_empty_lists_never_crash(self):
        from juana_client.audio import compute_turn_health
        h = compute_turn_health(rms_list=[], peak_list=[])
        self.assertEqual(h["quality"], "bad")
        self.assertEqual(h["snr_db"], 0.0)


class TestCalibration(unittest.TestCase):
    def setUp(self):
        import tempfile
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

    def _mock_audio(self, read_bytes):
        mock_audio = MagicMock()
        mock_stream = MagicMock()
        mock_stream.read.return_value = read_bytes
        mock_audio.open.return_value = mock_stream
        mock_audio.get_device_count.return_value = 1
        mock_audio.get_device_info_by_index.return_value = {
            "name": "Mic", "maxInputChannels": 1, "hostApi": 0, "defaultSampleRate": 16000,
        }
        return mock_audio

    def test_dynamic_ceiling_from_floor(self):
        """Piso bajisimo -> techo 32 (boost >x12 seguro); piso ruidoso -> techo bajo."""
        from juana_client.audio import StreamingAgc
        quiet_agc = StreamingAgc(noise_floor=0.000015)
        self.assertEqual(quiet_agc.max_gain, 32.0)
        noisy_agc = StreamingAgc(noise_floor=0.001)
        self.assertAlmostEqual(noisy_agc.max_gain, 3.0)
        self.assertLessEqual(noisy_agc.max_gain, 32.0)

    def test_calibrate_measures_and_caches(self):
        from juana_client import audio as audio_module
        audio = self._mock_audio(b"\x00" * 2048)
        cal1 = audio_module.calibrate_input_endpoint(audio, 0, "mic", 0, 16000, 1, force=True)
        self.assertTrue(cal1["measured"])
        self.assertLess(cal1["noise_floor"], 0.001)
        self.assertEqual(cal1["max_gain"], 32.0)
        opens_after_first = audio.open.call_count
        cal2 = audio_module.calibrate_input_endpoint(audio, 0, "mic", 0, 16000, 1)
        self.assertTrue(cal2["cached"])
        self.assertEqual(audio.open.call_count, opens_after_first)

    def test_speech_stats_refine_range(self):
        from juana_client.audio import note_input_speech_stats, load_input_calibration
        note_input_speech_stats("mic y", 2, 0.05, 0.2)
        note_input_speech_stats("mic y", 2, 0.07, 0.15)
        entry = load_input_calibration()["mic y|host2"]
        self.assertGreater(entry["speech_p50"], 0.05)
        self.assertLess(entry["speech_p50"], 0.07)
        self.assertAlmostEqual(entry["speech_max"], 0.2)
        self.assertEqual(entry["speech_turns"], 2)

    def test_no_midturn_reselection_probe_once(self):
        """Dos selecciones seguidas: la segunda usa cache (0 sondas)."""
        from juana_client import audio as audio_module
        from juana_client.audio import find_best_input_device
        devices = [
            {'name': 'Micrófono (JBL Quantum 300)', 'maxInputChannels': 2, 'maxOutputChannels': 0, 'hostApi': 0, 'defaultSampleRate': 44100},
            {'name': 'Micrófono (JBL Quantum 300)', 'maxInputChannels': 2, 'maxOutputChannels': 0, 'hostApi': 2, 'defaultSampleRate': 48000},
        ]
        mock_audio = MagicMock()
        mock_audio.get_device_count.return_value = len(devices)
        mock_audio.get_device_info_by_index.side_effect = lambda i: devices[i]
        stream = MagicMock()
        stream.read.return_value = b"\x00" * 2048
        mock_audio.open.return_value = stream
        calls = {"n": 0}
        real_probe = audio_module.probe_candidate_signal

        def counting_probe(*a, **k):
            calls["n"] += 1
            return real_probe(*a, **k)

        with unittest.mock.patch.object(audio_module, "probe_candidate_signal", counting_probe):
            idx1, *_ = find_best_input_device(mock_audio, preferred_name="Micrófono (JBL Quantum 300)")
            first = calls["n"]
            idx2, *_ = find_best_input_device(mock_audio, preferred_name="Micrófono (JBL Quantum 300)")
            second = calls["n"] - first
        self.assertEqual(idx1, idx2)
        self.assertGreater(first, 0)
        self.assertEqual(second, 0)


class TestBlock2Recovery(unittest.TestCase):
    """BLOCK 2: recovery, close-safety, TTS purge/backlog, barge, latencia."""

    def setUp(self):
        import tempfile
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

    def test_capture_stop_order_safe(self):
        """stop_stream SIEMPRE antes que close (nunca close con read en curso)."""
        from juana_client.audio import AudioCapture
        mock_audio = MagicMock()
        mock_stream = MagicMock()
        mock_audio.open.return_value = mock_stream
        capture = AudioCapture(
            sample_rate=16000, chunk_size=512, pyaudio_instance=mock_audio,
            use_callback=False,
        )
        from unittest.mock import patch as _patch
        with _patch.object(
            AudioCapture, "_resolve_input_device", return_value=(3, "Mic", 1, 16000)
        ):
            capture.start()
        capture.stop()
        calls = [c[0] for c in mock_stream.method_calls]
        self.assertIn("stop_stream", calls)
        self.assertIn("close", calls)
        self.assertLess(calls.index("stop_stream"), calls.index("close"))

    def test_forced_index_falls_back_to_native_rate(self):
        """Indice forzado que falla a 16k abre a nativa (48k) en vez de morir."""
        from juana_client.audio import AudioCapture
        mock_audio = MagicMock()
        mock_audio.get_device_info_by_index.return_value = {
            "name": "Mic", "maxInputChannels": 1, "hostApi": 2, "defaultSampleRate": 48000,
        }

        def open_side_effect(**kwargs):
            if kwargs.get("rate") == 16000:
                raise OSError(-9997, "Invalid sample rate")
            return MagicMock()

        mock_audio.open.side_effect = open_side_effect
        capture = AudioCapture(
            sample_rate=16000, chunk_size=640, pyaudio_instance=mock_audio,
            input_device_index=19, use_callback=False,
        )
        idx, _name, _ch, rate = capture._resolve_input_device()
        self.assertEqual(idx, 19)
        self.assertEqual(rate, 48000)

    def test_recover_success_and_failure(self):
        """Recovery: ok reabre y marca good; fallo marca unavailable."""
        from unittest.mock import MagicMock as _MagicMock
        from juana_client.client import JuanaClient, JuanaConfig
        client = JuanaClient(JuanaConfig())
        capture = _MagicMock()
        capture._valid_input_index = 1
        capture.stream_rate_hz = 16000
        client._audio_capture = capture
        self.assertTrue(client._recover_stt_capture("test-ok"))
        capture.stop.assert_called_once()
        capture.start.assert_called_once()
        self.assertEqual(client._audio_device_state, "good")
        capture.start.side_effect = OSError("sin dispositivo")
        self.assertFalse(client._recover_stt_capture("test-fail"))
        self.assertEqual(client._audio_device_state, "unavailable")
        client._pyaudio.terminate()

    def test_playback_purge_and_backlog_cap(self):
        """purge() vacia sin cerrar; la cola se acota con drop-oldest."""
        from juana_client.audio import AudioPlayback
        mock_audio = MagicMock()
        pb = AudioPlayback(sample_rate=24000, chunk_size=1024, pyaudio_instance=mock_audio)
        pb._running = True
        pb._stream_channels = 1
        pb.write(b"\x01\x02" * 2048 * 150)  # ~150 frames >> cota 100
        self.assertGreater(pb._dropped_frames, 0)
        self.assertLessEqual(pb._buffer.qsize(), 101)
        dropped = pb.purge()
        self.assertGreater(dropped, 0)
        self.assertTrue(pb._buffer.empty())
        self.assertFalse(pb._playback_started)

    def test_tts_utterance_purge_logic(self):
        """2do tts_start del MISMO utterance no purga; aborted si; nuevo si."""
        from unittest.mock import MagicMock as _MagicMock
        from juana_client.client import JuanaClient, JuanaConfig
        client = JuanaClient(JuanaConfig())
        pb = _MagicMock()
        client._audio_playback = pb
        client._running = False  # restart-wake queda no-op
        client.handle_stdin_message({"type": "tts_start"})
        self.assertEqual(pb.purge.call_count, 1)
        client.handle_stdin_message({"type": "tts_start"})
        self.assertEqual(pb.purge.call_count, 1)
        client.handle_stdin_message({"type": "tts_aborted"})
        self.assertEqual(pb.purge.call_count, 2)
        client.handle_stdin_message({"type": "tts_start"})
        self.assertEqual(pb.purge.call_count, 3)
        client._stop_barge_monitor()
        client._pyaudio.terminate()

    def test_barge_detector_bleed_vs_voice(self):
        """Bleed sostenido (0.036, medido) jamas dispara; voz firme si;
        transitorio corto no; susurro bajo el piso absoluto tampoco;
        salto de TTS (eco) vetado por referencia aunque el gate tarde."""
        from juana_client.audio import BargeDetector
        chunk_ms = 10.7
        # Bleed 2s: el gate lo persigue, sin disparo.
        det = BargeDetector()
        fired = [det.update(0.036, chunk_ms, played_ref=0.21) for _ in range(200)]
        self.assertFalse(any(fired))
        self.assertGreater(det.gate, 0.05)
        # Voz firme sobre bleed: dispara tras ~300ms.
        det2 = BargeDetector()
        out = []
        for _ in range(50):
            out.append(det2.update(0.036, chunk_ms, played_ref=0.21))
        for _ in range(40):
            out.append(det2.update(0.16, chunk_ms, played_ref=0.21))
        self.assertTrue(any(out))
        first = next(i for i, v in enumerate(out) if v)
        self.assertGreaterEqual(first * chunk_ms, 300.0 - chunk_ms * 2)
        # Salto de volumen del TTS (mic 0.09, emitido 0.5): eco, no dispara.
        det5 = BargeDetector()
        res5 = [det5.update(0.036, chunk_ms, played_ref=0.21) for _ in range(50)]
        res5 += [det5.update(0.09, chunk_ms, played_ref=0.5) for _ in range(100)]
        self.assertFalse(any(res5))
        # Transitorio 100ms: no dispara.
        det3 = BargeDetector()
        res = [det3.update(0.036, chunk_ms, played_ref=0.21) for _ in range(50)]
        res += [det3.update(0.25, chunk_ms, played_ref=0.21) for _ in range(9)]
        res += [det3.update(0.036, chunk_ms, played_ref=0.21) for _ in range(50)]
        self.assertFalse(any(res))
        # Susurro bajo el piso absoluto: no dispara.
        det4 = BargeDetector()
        self.assertFalse(any(det4.update(0.025, chunk_ms) for _ in range(200)))

    def test_publish_envelope_keys(self):
        """El envelope lleva turn_id+generation+ts+speech timings."""
        from juana_client.client import JuanaClient, JuanaConfig
        client = JuanaClient(JuanaConfig())
        client._publish_stt_result("abc123", 7, "hola", 120, 900)
        item = client._stt_result_queue.get(timeout=1.0)
        self.assertEqual(item["turn_id"], "abc123")
        self.assertEqual(item["generation"], 7)
        self.assertGreater(item["ts"], 0)
        self.assertEqual(item["text"], "hola")
        self.assertEqual(item["speech_start_ms"], 120)
        self.assertEqual(item["speech_end_ms"], 900)
        client._publish_stt_result("abc123", 7, "   ")
        self.assertIsNone(client._stt_result_queue.get(timeout=1.0))
        client._pyaudio.terminate()

    def test_voice_turn_timing_fields(self):
        """build_voice_transcript_payload incluye correlacion FASE 3+4."""
        from juana_client.client import build_voice_transcript_payload
        p = build_voice_transcript_payload("hola", "tid1", 3, 123456789, 200, 1800)
        self.assertEqual(p["type"], "voice_transcript")
        self.assertEqual(p["turn_id"], "tid1")
        self.assertEqual(p["generation"], 3)
        self.assertEqual(p["ts"], 123456789)
        self.assertEqual(p["speech_start_ms"], 200)
        self.assertEqual(p["speech_end_ms"], 1800)


if __name__ == "__main__":
    unittest.main()
