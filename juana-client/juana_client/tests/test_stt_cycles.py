"""Minimal STT cycles test: blocking reads, same-thread recognizer.

Phase A (read-only): open -> stream.read() x N -> close, SIN Vosk.
Phase B (read+Vosk): open -> stream.read() -> AcceptWaveform (recognizer
creado Y usado en EL MISMO thread) -> close.

Empty transcripts (silence) still count: the crash criterion is
Access Violation / EOF / segfault across cycles, not speech content.

Usage:
    python -m juana_client.tests.test_stt_cycles [num_cycles] [a|b|both]
"""

import json
import os
import sys
import time

import pyaudio
from vosk import KaldiRecognizer, Model, SetLogLevel

SetLogLevel(-1)

SAMPLE_RATE = 16000
CHUNK = 4000
CHANNELS = 1


def find_input_device(audio: pyaudio.PyAudio) -> tuple[int, str, bool]:
    """Prefer JBL Quantum 300; else first openable input. Returns (index, name, is_jbl)."""
    count = audio.get_device_count()
    fallback = None
    for i in range(count):
        try:
            info = audio.get_device_info_by_index(i)
        except Exception:
            continue
        if info.get("maxInputChannels", 0) <= 0:
            continue
        name = info.get("name", "")
        if "jbl quantum 300" in name.lower():
            try:
                s = audio.open(
                    format=pyaudio.paInt16,
                    channels=CHANNELS,
                    rate=SAMPLE_RATE,
                    input=True,
                    frames_per_buffer=CHUNK,
                    input_device_index=i,
                )
                s.close()
                return i, name, True
            except Exception:
                continue
        if fallback is None:
            try:
                s = audio.open(
                    format=pyaudio.paInt16,
                    channels=CHANNELS,
                    rate=SAMPLE_RATE,
                    input=True,
                    frames_per_buffer=CHUNK,
                    input_device_index=i,
                )
                s.close()
                fallback = (i, name)
            except Exception:
                continue
    if fallback is not None:
        return fallback[0], fallback[1], False
    raise RuntimeError("No openable input device found")


def run_cycle(
    cycle_num: int,
    num_cycles: int,
    audio: pyaudio.PyAudio,
    model: Model,
    device_index: int,
    device_name: str,
    use_vosk: bool,
) -> dict:
    """Run one cycle. Returns result dict."""
    tag = "read+Vosk" if use_vosk else "read-only"
    print(f"\n--- Cycle {cycle_num}/{num_cycles} [{tag}] ---", flush=True)
    print(f"  Device: {device_name} (index={device_index})", flush=True)

    recognizer = KaldiRecognizer(model, SAMPLE_RATE) if use_vosk else None
    if recognizer is not None:
        print(f"  stt-recognizer-new id={id(recognizer):x} (mismo thread de uso)", flush=True)
    stream = None
    result = {"cycle": cycle_num, "transcript": "", "error": None, "rms_max": 0.0}

    try:
        stream = audio.open(
            format=pyaudio.paInt16,
            channels=CHANNELS,
            rate=SAMPLE_RATE,
            input=True,
            frames_per_buffer=CHUNK,
            input_device_index=device_index,
        )
        print("  Stream opened", flush=True)

        # Read for up to 5 seconds or until we get a result
        start = time.time()
        while time.time() - start < 5.0:
            data = stream.read(CHUNK, exception_on_overflow=False)
            if len(data) < 4:
                continue

            # Compute RMS
            import numpy as np
            samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
            rms = float(np.sqrt(np.mean(samples ** 2)))
            if rms > result["rms_max"]:
                result["rms_max"] = rms

            if not use_vosk:
                continue

            if recognizer.AcceptWaveform(data):
                res = json.loads(recognizer.Result())
                text = res.get("text", "").strip()
                if text:
                    result["transcript"] = text
                    print(f'  Transcript: "{text}"', flush=True)
                    break

        if not result["transcript"] and use_vosk:
            # Get final result
            res = json.loads(recognizer.FinalResult())
            text = res.get("text", "").strip()
            if text:
                result["transcript"] = text
                print(f'  Transcript (final): "{text}"', flush=True)

        if not result["transcript"]:
            if use_vosk:
                print(f"  No speech detected (rms_max={result['rms_max']:.4f})", flush=True)
            else:
                print(f"  Read-only OK (rms_max={result['rms_max']:.4f})", flush=True)

    except Exception as e:
        result["error"] = str(e)
        print(f"  ERROR: {e}", flush=True)
    finally:
        if stream:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
            print("  Stream closed", flush=True)

    return result


def main():
    num_cycles = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    phase = sys.argv[2] if len(sys.argv) > 2 else "both"
    assert phase in ("a", "b", "both"), "phase debe ser a, b o both"
    print(f"=== STT Cycles Test: {num_cycles} cycles/phase, phase={phase} ===", flush=True)

    # Find model
    model_dir = os.path.join(os.path.dirname(__file__), "..", "models")
    model_path = None
    for name in ["vosk-model-small-es-0.42", "vosk-model-es-0.42"]:
        candidate = os.path.join(model_dir, name)
        if os.path.exists(candidate):
            model_path = candidate
            break
    if model_path is None:
        print("ERROR: No Vosk model found", flush=True)
        sys.exit(1)
    print(f"Model: {os.path.basename(model_path)}", flush=True)

    # Load model once
    model = Model(model_path)
    print("Model loaded", flush=True)

    # Open PyAudio
    audio = pyaudio.PyAudio()
    try:
        device_index, device_name, is_jbl = find_input_device(audio)
        print(f"Input device: {device_name} (index={device_index} jbl={is_jbl})", flush=True)

        all_results = []
        phases = []
        if phase in ("a", "both"):
            phases.append(("A/read-only", False))
        if phase in ("b", "both"):
            phases.append(("B/read+Vosk", True))
        for phase_name, use_vosk in phases:
            print(f"\n===== Phase {phase_name} =====", flush=True)
            results = []
            for i in range(1, num_cycles + 1):
                r = run_cycle(i, num_cycles, audio, model, device_index, device_name, use_vosk)
                results.append(r)
                all_results.append(r)
                # Small delay between cycles
                time.sleep(0.5)

        # Summary
        print("\n=== Summary ===", flush=True)
        success = sum(1 for r in all_results if r["transcript"])
        errors = sum(1 for r in all_results if r["error"])
        print(f"Total cycles: {len(all_results)}", flush=True)
        print(f"Successful transcripts: {success}", flush=True)
        print(f"Errors: {errors}", flush=True)
        print(f"Max RMS seen: {max(r['rms_max'] for r in all_results):.4f}", flush=True)

        if errors > 0:
            print("\nErrors:", flush=True)
            for r in all_results:
                if r["error"]:
                    print(f"  Cycle {r['cycle']}: {r['error']}", flush=True)

        # Exit code: crash/errors fail; silence alone does not
        sys.exit(0 if errors == 0 else 1)

    finally:
        audio.terminate()
        print("\nPyAudio terminated", flush=True)


if __name__ == "__main__":
    main()
