"""Reproduccion del patron multiturno del crash STT (sin hardware).

Por turno, como la app real:
  1. churn de wake en el thread principal: Model + recognizer nuevos,
     un AcceptWaveform, destruir ambos (como _restart_wake_detector);
  2. turno STT en un thread fresco: crear recognizer del Model STT
     compartido, AcceptWaveform x2, FinalResult, destruir.

El crash original caia en la creacion del recognizer del 3er turno.
Sobrevivir == pass (un Access Violation mataria el proceso: exit != 0).
"""

import gc
import json
import math
import os
import struct
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from vosk import KaldiRecognizer, Model, SetLogLevel

SetLogLevel(-1)

SAMPLE_RATE = 16000


def _models_path() -> str:
    base = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models"
    )
    for name in ["vosk-model-small-es-0.42", "vosk-model-es-0.42"]:
        candidate = os.path.join(base, name)
        if os.path.exists(candidate):
            return candidate
    raise unittest.SkipTest("sin modelo Vosk en repo")


def _half_second_tone() -> bytes:
    samples = [
        int(3000.0 * math.sin(2.0 * math.pi * 440.0 * i / SAMPLE_RATE))
        for i in range(SAMPLE_RATE // 2)
    ]
    return struct.pack(f"<{len(samples)}h", *samples)


class TestMultiturnLifecycle(unittest.TestCase):
    def test_8_turns_wake_churn_plus_fresh_stt_threads(self):
        model_path = _models_path()
        # Model STT compartido, creado una vez en main (como el turno 1 real).
        stt_model = Model(model_path)
        stt_model_id = id(stt_model)
        pcm = _half_second_tone()
        errors: list[str] = []
        worker_tids: set[int] = set()
        main_tid = threading.get_ident()

        for turn in range(1, 9):
            # --- churn de wake en main (restart del detector) ---
            wake_model = Model(model_path)
            wake_rec = KaldiRecognizer(wake_model, SAMPLE_RATE)
            wake_rec.AcceptWaveform(pcm)
            json.loads(wake_rec.FinalResult())
            del wake_rec
            del wake_model

            # --- turno STT en thread fresco (como el worker real) ---
            result: dict = {}

            def stt_turn():
                tid = threading.get_ident()
                worker_tids.add(tid)
                rec = KaldiRecognizer(stt_model, SAMPLE_RATE)
                if id(stt_model) != stt_model_id:
                    errors.append(f"turno {turn}: cambio el Model STT")
                rec.AcceptWaveform(pcm)
                rec.AcceptWaveform(pcm)
                json.loads(rec.FinalResult())
                result["rec_id"] = id(rec)
                result["tid"] = tid
                del rec

            th = threading.Thread(target=stt_turn)
            th.start()
            th.join(timeout=60.0)
            if th.is_alive():
                self.fail(f"turno {turn}: worker colgado")
            self.assertNotEqual(result.get("tid"), main_tid)

            if turn % 4 == 0:
                gc.collect()

        self.assertEqual(errors, [])
        # Cada turno uso un thread fresco distinto del main.
        self.assertGreaterEqual(len(worker_tids), 2)
        del stt_model
        gc.collect()


if __name__ == "__main__":
    unittest.main()
