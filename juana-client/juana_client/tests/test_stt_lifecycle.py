"""Tests aislados del lifecycle Vosk Model/Recognizer (sin hardware).

Reproducen el patron de threads del sidecar integrado:
- Test A (patron real): Model STT compartido creado en main + por ciclo un
  thread fresco crea/usa/destruye su recognizer; en paralelo main crea/usa/
  destruye un recognizer "wake" de otro Model. 50 iteraciones.
- Test B (baseline): Model nuevo + recognizer nuevo por ciclo, todo en el
  mismo thread (create/use/destroy). 50 ciclos.

Criterio: sobrevivir sin Access Violation. Un crash nativo falla el proceso
(exit != 0), no una asercion.
"""

import gc
import json
import math
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from vosk import KaldiRecognizer, Model, SetLogLevel

SetLogLevel(-1)

SAMPLE_RATE = 16000


def _models_dir() -> str:
    # tests/ -> juana_client/ -> models/ (igual que wake.py: dirname(__file__)/models)
    return os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models"
    )


def _find_model_path() -> str:
    model_dir = _models_dir()
    for name in ["vosk-model-small-es-0.42", "vosk-model-es-0.42"]:
        candidate = os.path.join(model_dir, name)
        if os.path.exists(candidate):
            return candidate
    raise unittest.SkipTest("sin modelo Vosk en repo")


def _half_second_tone() -> bytes:
    import struct
    samples = [
        int(3000.0 * math.sin(2.0 * math.pi * 440.0 * i / SAMPLE_RATE))
        for i in range(SAMPLE_RATE // 2)
    ]
    return struct.pack(f"<{len(samples)}h", *samples)


class TestSharedModelThreadedRecognizers(unittest.TestCase):
    """Patron EXACTO del integrado: Model compartido + recognizer por thread."""

    def test_50_cycles_shared_model_fresh_thread_recognizer(self):
        model_path = _find_model_path()
        stt_model = Model(model_path)
        wake_model = Model(model_path)
        pcm = _half_second_tone()
        errors: list[str] = []
        seen_threads: set[int] = set()

        for i in range(50):
            worker_tid: list[int] = []

            def stt_turn():
                worker_tid.append(threading.get_ident())
                rec = KaldiRecognizer(stt_model, SAMPLE_RATE)
                rec_id = id(rec)
                rec.AcceptWaveform(pcm)
                rec.AcceptWaveform(pcm)
                json.loads(rec.FinalResult())
                # create/use/destroy en ESTE thread; verificar afinidad
                if threading.get_ident() != worker_tid[0]:
                    errors.append(f"iter {i}: thread mismatch")
                del rec
                return rec_id

            # Wake-style: crear/usar/destruir en el thread main en paralelo
            wake_rec = KaldiRecognizer(wake_model, SAMPLE_RATE)
            wake_rec.AcceptWaveform(pcm)
            json.loads(wake_rec.FinalResult())
            del wake_rec

            th = threading.Thread(target=stt_turn)
            th.start()
            th.join(timeout=30.0)
            if th.is_alive():
                self.fail(f"iter {i}: worker colgado")
            seen_threads.add(worker_tid[0])

            if i % 10 == 0:
                gc.collect()

        self.assertEqual(errors, [])
        # Cada ciclo uso un thread fresco (como el worker STT real)
        self.assertGreaterEqual(len(seen_threads), 2)
        del stt_model
        del wake_model
        gc.collect()


class TestFreshModelPerCycleSameThread(unittest.TestCase):
    """Baseline: Model nuevo + recognizer nuevo por ciclo, mismo thread."""

    def test_50_cycles_fresh_model_same_thread(self):
        model_path = _find_model_path()
        pcm = _half_second_tone()
        main_tid = threading.get_ident()
        for i in range(50):
            model = Model(model_path)
            rec = KaldiRecognizer(model, SAMPLE_RATE)
            self.assertEqual(threading.get_ident(), main_tid)
            rec.AcceptWaveform(pcm)
            rec.AcceptWaveform(pcm)
            json.loads(rec.FinalResult())
            del rec
            del model
            if i % 10 == 0:
                gc.collect()


class _FakeVoskModel:
    created: list = []
    destroyed: list = []

    def __init__(self, path):
        self._tid = threading.get_ident()
        self._path = path
        _FakeVoskModel.created.append((id(self), self._tid))

    def __del__(self):
        try:
            _FakeVoskModel.destroyed.append(id(self))
        except Exception:
            pass


class _FakeVoskRecognizer:
    created: list = []
    destroyed: list = []

    def __init__(self, model, rate):
        self._tid = threading.get_ident()
        self._model_id = id(model)
        _FakeVoskRecognizer.created.append((id(self), self._tid, self._model_id))

    def AcceptWaveform(self, data):
        return False

    def PartialResult(self):
        return '{"partial": ""}'

    def FinalResult(self):
        return '{"text": "hola mundo"}'

    def __del__(self):
        try:
            _FakeVoskRecognizer.destroyed.append(id(self))
        except Exception:
            pass


class _FakeCapture:
    """Captura sintetica: 8 chunks fuertes + silencio (endpoint por silencio)."""

    def __init__(self, audio):
        import math as _math
        import struct as _struct
        tone = _struct.pack(
            "<640h",
            *[int(0.1 * 32767 * _math.sin(2.0 * _math.pi * 440.0 * i / 16000)) for i in range(640)],
        )
        self._chunks = [tone] * 8 + [b"\x00" * 1280] * 100
        self._audio = audio
        self.capture_id = "fakecap"
        self._stream_id = "fakestream"
        self._stream = None
        self._valid_input_index = 3
        self.chunk_size = 640
        self.sample_rate = 16000

    @property
    def is_blocking(self):
        return True

    @property
    def stream_rate_hz(self):
        return 16000

    @property
    def agc_stats(self):
        return {"gain_avg": 1.0}

    @property
    def endpoint_noise_seed(self):
        return None

    def start(self):
        pass

    def stop(self):
        pass

    def get_preroll(self):
        return b""

    def clear_preroll(self):
        pass

    def get_chunk(self, timeout=0.1):
        if not self._chunks:
            return None
        return self._chunks.pop(0)


class TestSttOwnerAffinity(unittest.TestCase):
    """Worker STT persistente: Model nace/usa/muere en UN solo thread.

    2 turnos contra JuanaClient real (vosk fakeado, captura sintetica):
    - el Model se crea UNA vez, en el owner, nunca en el controlador;
    - cada Recognizer nace y muere en el owner (mismo thread que el Model);
    - el thread controlador jamas crea objetos vosk.
    """

    def setUp(self):
        import tempfile
        import shutil
        _FakeVoskModel.created = []
        _FakeVoskModel.destroyed = []
        _FakeVoskRecognizer.created = []
        _FakeVoskRecognizer.destroyed = []
        self.tmpdir = tempfile.mkdtemp()
        self._model_dir = os.path.join(self.tmpdir, "models")
        os.makedirs(os.path.join(self._model_dir, "vosk-model-small-es-0.42"))
        self._old_env = os.environ.get("APOLLO_CONFIG_DIR")
        os.environ["APOLLO_CONFIG_DIR"] = self.tmpdir
        from juana_client import audio as audio_module
        self._old_legacy = audio_module._LEGACY_PREFERENCES_FILE
        audio_module._LEGACY_PREFERENCES_FILE = os.path.join(self.tmpdir, "legacy.json")
        self._shutil = shutil

    def tearDown(self):
        from juana_client import audio as audio_module
        audio_module._LEGACY_PREFERENCES_FILE = self._old_legacy
        if self._old_env is None:
            os.environ.pop("APOLLO_CONFIG_DIR", None)
        else:
            os.environ["APOLLO_CONFIG_DIR"] = self._old_env
        self._shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_client(self):
        from unittest import mock as _mock
        from juana_client.client import JuanaClient, JuanaConfig
        config = JuanaConfig(wake_model_dir=self._model_dir)
        client = JuanaClient(config)
        fake_audio = _mock.MagicMock()
        fake_audio.get_device_info_by_index.return_value = {"name": "Fake Mic", "hostApi": 0}
        client._audio_capture = _FakeCapture(fake_audio)
        client._restart_wake_detector = lambda: None
        client._wake_detector = None
        self.transcripts = []
        self.payloads = []
        real_emit = client._emit_json

        def recording_emit(msg):
            if isinstance(msg, dict) and msg.get("type") == "voice_transcript":
                self.transcripts.append(msg.get("text", ""))
                self.payloads.append(dict(msg))
            return real_emit(msg)

        client._emit_json = recording_emit
        return client

    def _run_turn(self, client, expect_transcripts):
        from juana_client.client import VoiceState
        import math as _math
        import struct as _struct
        tone = _struct.pack(
            "<640h",
            *[int(0.1 * 32767 * _math.sin(2.0 * _math.pi * 440.0 * i / 16000)) for i in range(640)],
        )
        client._audio_capture._chunks = [tone] * 8 + [b"\x00" * 1280] * 100
        client._on_wake_detected("test")
        self.wake_ids.append(client._turn_id)
        self.assertTrue(client._stt_result_received.wait(timeout=15.0))
        deadline = time.monotonic() + 10.0
        while client._voice_state != VoiceState.IDLE:
            if time.monotonic() > deadline:
                self.fail("turno no llego a IDLE")
            time.sleep(0.1)
        # Fidelidad produccion: el proximo wake solo puede ocurrir tras
        # reiniciar el detector, que pasa AL FINAL del consume (post
        # transcript). Esperar el transcript evita pisar la queue del turno.
        deadline = time.monotonic() + 10.0
        while len(self.transcripts) < expect_transcripts:
            if time.monotonic() > deadline:
                self.fail("transcript no emitido")
            time.sleep(0.1)

    def test_two_turns_single_owner_thread(self):
        from unittest import mock as _mock
        from juana_client.client import VoiceState
        main_tid = threading.get_ident()
        self.wake_ids = []
        client = self._make_client()
        with _mock.patch("vosk.Model", _FakeVoskModel), _mock.patch(
            "vosk.KaldiRecognizer", _FakeVoskRecognizer
        ):
            self._run_turn(client, 1)
            self._run_turn(client, 2)
            owner = client._stt_owner_thread
            self.assertIsNotNone(owner)
            owner_tid = owner.ident
            # El controlador jamas es el owner.
            self.assertNotEqual(owner_tid, main_tid)
            # Model: creado UNA vez, en el owner.
            self.assertEqual(len(_FakeVoskModel.created), 1)
            model_id, model_tid = _FakeVoskModel.created[0]
            self.assertEqual(model_tid, owner_tid)
            self.assertEqual(client._stt_model_owner_tid, owner_tid)
            # Recognizers: uno por turno, todos en el owner, del mismo Model.
            self.assertEqual(len(_FakeVoskRecognizer.created), 2)
            for _rec_id, rec_tid, rec_model in _FakeVoskRecognizer.created:
                self.assertEqual(rec_tid, owner_tid)
                self.assertEqual(rec_model, model_id)
            # Ambos turnos transcribieron por el camino unico.
            self.assertEqual(self.transcripts, ["hola mundo", "hola mundo"])
            # FASE 3: cada payload lleva el turn_id de SU turno (no inferido).
            self.assertEqual(len(self.payloads), 2)
            self.assertEqual(self.payloads[0]["turn_id"], self.wake_ids[0])
            self.assertEqual(self.payloads[1]["turn_id"], self.wake_ids[1])
            self.assertNotEqual(self.payloads[0]["turn_id"], self.payloads[1]["turn_id"])
            self.assertEqual(
                [p.get("generation") for p in self.payloads],
                [1, 2],
            )
            for payload in self.payloads:
                self.assertGreater(payload.get("ts", 0), 0)
            # Destroy por turno (refcount CPython + gc).
            gc.collect()
            created_ids = {r[0] for r in _FakeVoskRecognizer.created}
            self.assertTrue(created_ids.issubset(set(_FakeVoskRecognizer.destroyed)))
            # Teardown: el Model muere en el owner.
            client._teardown_stt_owner()
            gc.collect()
            self.assertIn(model_id, _FakeVoskModel.destroyed)
            self.assertFalse(owner.is_alive())
        client._pyaudio.terminate()


    def test_stale_timer_is_ignored(self):
        """Un timer de una generacion vieja disparando en la ventana del
        turno actual se ignora (antes abortaba el turno ajeno a mitad de
        un chunk)."""
        from unittest import mock as _mock
        from juana_client.client import VoiceState
        self.wake_ids = []
        client = self._make_client()
        with _mock.patch("vosk.Model", _FakeVoskModel), _mock.patch(
            "vosk.KaldiRecognizer", _FakeVoskRecognizer
        ):
            self._run_turn(client, 1)
            self.assertEqual(client._stt_generation, 1)
            # Simula el timer del turno 1 disparando tarde (ya estamos en 2).
            client._stt_generation = 2
            client._voice_state = VoiceState.LISTENING
            client._on_listen_timeout(1)
            self.assertEqual(client._voice_state, VoiceState.LISTENING)
            # El timer de la generacion correcta si finaliza.
            client._on_listen_timeout(2)
            self.assertEqual(client._voice_state, VoiceState.IDLE)
        client._teardown_stt_owner()
        client._pyaudio.terminate()

    def test_stale_turn_wake_is_ignored(self):
        """Un wake en la ventana IDLE-temprano (turno aun cerrando) se ignora
        en vez de solapar turnos sobre el mismo stream/queue."""
        from unittest import mock as _mock
        from juana_client.client import VoiceState
        self.wake_ids = []
        client = self._make_client()
        with _mock.patch("vosk.Model", _FakeVoskModel), _mock.patch(
            "vosk.KaldiRecognizer", _FakeVoskRecognizer
        ):
            self._run_turn(client, 1)
            first_id = client._turn_id
            first_gen = client._stt_generation
            # Simula la ventana: IDLE ya marcado pero turno sin terminar.
            client._stt_turn_done.clear()
            client._on_wake_detected("test")
            self.assertEqual(client._turn_id, first_id)
            self.assertEqual(client._stt_generation, first_gen)
            self.assertFalse(client._stt_turn_event.is_set())
            client._stt_turn_done.set()
        client._teardown_stt_owner()
        client._pyaudio.terminate()


if __name__ == "__main__":
    unittest.main()
