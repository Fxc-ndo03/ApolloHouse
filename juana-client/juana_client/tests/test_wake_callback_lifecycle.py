"""Regression tests for stopping Vosk wake capture after recognition."""

import os
import sys
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from juana_client.wake import VoskWakeWordDetector


class _Stream:
    def __init__(self, callback_returned):
        self.callback_returned = callback_returned
        self.callback_finished_before_stop = False
        self.closed = False

    def stop_stream(self):
        # PortAudio stop must be requested outside its callback and allow the
        # in-flight native callback to return before close releases the stream.
        self.callback_finished_before_stop = self.callback_returned.wait(2.0)

    def close(self):
        self.closed = True


class TestWakeCallbackLifecycle(unittest.TestCase):
    def test_detection_handler_stops_stream_after_audio_callback_returns(self):
        callback_returned = threading.Event()
        handler_finished = threading.Event()
        callback_thread = []
        handler_thread = []
        detector_ref = []

        def on_detected(_word):
            handler_thread.append(threading.current_thread())
            detector_ref[0].stop()
            handler_finished.set()

        recognizer = MagicMock()
        recognizer.AcceptWaveform.return_value = True
        recognizer.Result.return_value = '{"text":"apollo"}'

        with patch("juana_client.wake.get_shared_wake_model", return_value=object()), patch(
            "juana_client.wake.KaldiRecognizer", return_value=recognizer
        ):
            detector = VoskWakeWordDetector(
                model_path=__file__,
                wake_words=["apollo"],
                on_detected=on_detected,
                pyaudio_instance=MagicMock(),
            )

        detector_ref.append(detector)
        detector._state = detector._STATE_RUNNING
        detector._device_validated = True
        detector._last_level_log_time = time.time()
        stream = _Stream(callback_returned)
        detector._stream = stream

        def run_audio_callback():
            callback_thread.append(threading.current_thread())
            detector._audio_callback(bytes(1600), 800, {}, 0)
            callback_returned.set()

        callback_runner = threading.Thread(target=run_audio_callback)
        callback_runner.start()
        callback_runner.join(timeout=3.0)

        self.assertFalse(callback_runner.is_alive(), "native callback handler blocked the audio callback")
        self.assertTrue(callback_returned.is_set())
        self.assertTrue(handler_finished.wait(3.0), "wake handler did not stop the detector")
        self.assertIsNot(callback_thread[0], handler_thread[0])
        self.assertTrue(stream.callback_finished_before_stop)
        self.assertTrue(stream.closed)
        self.assertEqual(detector._state, detector._STATE_STOPPED)
        self.assertTrue(detector._callback_done.is_set())
        self.assertTrue(detector._callback_ack.is_set())


if __name__ == "__main__":
    unittest.main()
