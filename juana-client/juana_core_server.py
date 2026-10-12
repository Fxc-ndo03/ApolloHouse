import asyncio
import json
import os
import re
import subprocess
import sys
import uuid
import time
from typing import Optional
from urllib.parse import parse_qs, urlsplit

import websockets

try:
    import numpy as np
except ImportError:  # numpy es opcional: TTS se degrada a reproducción local con aplay
    np = None

# Local imports
import sys as _sys
_sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from juana_core.providers.local_qwen import LocalQwenProvider
from juana_core.tools.registry import (
    handle_intent_A, handle_intent_B, handle_intent_C, handle_intent_D,
)
from juana_core.session.history import get_history

DEFAULT_PORT = 9876
PORT = int(os.environ.get("JUANA_CORE_PORT", str(DEFAULT_PORT)))
SECRET_ENV_VAR = "DEVICE_SHARED_SECRET"

# TTS (edge-tts con Microsoft Elena Neural, gratis y rápido)
TTS_VOICE = os.environ.get("JARVIS_TTS_VOICE", "es-AR-ElenaNeural")
TTS_SAMPLE_RATE_OUT = 24000  # edge-tts emite a 24kHz; no necesita resample
_FFMPEG_PATH = os.environ.get(
    "FFMPEG_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "ffmpeg-7.0.2-amd64-static", "ffmpeg"),
)
RESPONSE_TARGET_DEFAULT = "pc"  # "pc" → stream TTS al sidecar; "server" → aplay local

connected_clients: dict[str, dict] = {}

# Serializa turnos en todo el proceso: mientras Apollo procesa una orden
# (detección -> respuesta -> TTS), ningún otro cliente/sesión puede comenzar
# otra hasta que responda, para no pisarse con dos comandos simultáneos.
TURN_LOCK = asyncio.Lock()
session_counter = 0

# Initialize providers
qwen_provider = LocalQwenProvider()
history = get_history()


def validate_token(secret_from_ws: str, expected_secret: str) -> bool:
    return secret_from_ws == expected_secret


def _safe_print(msg: str) -> None:
    print(msg)
    sys.stdout.flush()


_vosk_model = None


def _get_vosk_model():
    """Carga el modelo Vosk (español) una sola vez."""
    global _vosk_model
    if _vosk_model is None:
        import vosk
        model_path = os.path.abspath(
            os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "juana_client", "models", "vosk-model-small-es-0.42")
        )
        _safe_print(f"[juana-core] Loading Vosk model: {model_path}")
        _vosk_model = vosk.Model(model_path)
        _safe_print("[juana-core] Vosk model loaded")
    return _vosk_model


def run_whisper_transcribe(audio_chunks: bytes, language: str = "es") -> str:
    """Transcribe audio chunks using Vosk (local, 16 kHz mono).

    Whisper CLI no está disponible en la .8; usamos Vosk que ya está
    instalado con el modelo es_AR-daniela-small-es-0.42.
    """
    try:
        model = _get_vosk_model()
        rec = vosk.KaldiRecognizer(model, 16000)
        rec.SetWords(False)
        if rec.AcceptWaveform(audio_chunks):
            data = json.loads(rec.Result())
            return data.get("text", "").strip()
        data = json.loads(rec.FinalResult())
        return data.get("text", "").strip()
    except Exception as e:
        _safe_print(f"[juana-core] Error en Vosk transcription: {str(e)[:120]}")
        return ""


def synth_pcm(text: str) -> bytes | None:
    """Genera PCM int16 mono a 24000 Hz con edge-tts (es-AR-ElenaNeural).

    Usa edge-tts (Microsoft cloud, gratis) + ffmpeg para convertir MP3→PCM.
    ~1.7s de latencia vs ~5-12s de Piper local.
    """
    if not text.strip():
        return None
    try:
        import asyncio
        import edge_tts

        async def _synthesize():
            communicate = edge_tts.Communicate(text, TTS_VOICE)
            mp3_data = b""
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    mp3_data += chunk["data"]
            return mp3_data

        # Usar thread pool para no bloquear el event loop de asyncio
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                mp3_data = pool.submit(asyncio.run, _synthesize()).result(timeout=20)
        else:
            mp3_data = asyncio.new_event_loop().run_until_complete(_synthesize())

        if not mp3_data:
            return None

        ffmpeg_bin = _FFMPEG_PATH if os.path.isfile(_FFMPEG_PATH) else "ffmpeg"
        proc = subprocess.run(
            [ffmpeg_bin, "-i", "pipe:0", "-f", "s16le", "-ar", str(TTS_SAMPLE_RATE_OUT),
             "-ac", "1", "-loglevel", "error", "pipe:1"],
            input=mp3_data,
            capture_output=True,
            timeout=15,
        )
        if proc.returncode != 0:
            _safe_print(f"[juana-core] ffmpeg error: {proc.stderr.decode()[:200]}")
            return None
        return proc.stdout if proc.stdout else None
    except Exception as e:
        _safe_print(f"[juana-core] Error TTS: {e}")
        return None


def play_pcm_local(pcm: bytes) -> None:
    """Reproduce PCM en el altavoz local (aplay). Se usa cuando target=server."""
    if not pcm:
        return
    try:
        subprocess.run(
            ["aplay", "-q", "-f", "S16_LE", "-r", str(TTS_SAMPLE_RATE_OUT), "-c", "1"],
            input=pcm,
            timeout=90,
            check=True,
        )
    except Exception as e:
        _safe_print(f"[juana-core] Error aplay: {e}")


async def send_tts_stream(websocket, text: str, session_id: str) -> None:
    """Manda la voz de la respuesta al sidecar: tts_start + binario + tts_end."""
    pcm = synth_pcm(text)
    if not pcm:
        _safe_print("[juana-core] TTS vacío, no se envía audio")
        return
    sequence = int(time.time() * 1000) % 1000000
    start = {
        "type": "tts_start",
        "format": "pcm",
        "bytes": len(pcm),
        "sequence": sequence,
        "sample_rate": TTS_SAMPLE_RATE_OUT,
        "channels": 1,
        "session_id": session_id,
    }
    await websocket.send(json.dumps(start))
    await websocket.send(pcm)
    end = {"type": "tts_end", "sequence": sequence, "session_id": session_id}
    await websocket.send(json.dumps(end))
    _safe_print(f"[juana-core] TTS enviado: {len(pcm)} bytes (seq={sequence})")


async def send_ui_state(websocket, session_id: str, state: str, caption: str = "") -> None:
    """Notifica al sidecar el modo visual de Apollo (en reposo/pensando/respondiendo)."""
    try:
        await websocket.send(json.dumps({
            "type": "ui_state",
            "state": state,
            "caption": caption,
            "session_id": session_id,
        }))
    except Exception as e:
        _safe_print(f"[juana-core] Error enviando ui_state={state}: {e}")


_SALUDOS_Y_MULETILLAS = re.compile(
    r"\b("
    # saludos
    r"hol[ao]|saludos|buen\s*(?:os\s*)?d[ií]as|buenas\s*tardes|buenas\s*noches|"
    r"qu[eé]\s*(?:tal|onda|haces?|hac[eé]s|est[aá]s?|and[aá]s|anda|te\s+encuentras)|"
    r"c[oó]mo\s*(?:est[aá]s?|and[aá]s|te\s*va|va|andas)|hey|ey|hii|te\s+va|bien\s*ah[ií]"
    # muletillas rioplatenses
    r"|che|bolu|boludo|mae|guach|capo|viste|ves|mir[aá]|fijate|escuch[aá]|he[yo]?"
    r"|bah|eh|mm|mmm|bueno|bue|ta|no\s*te|s[aá]b[eé]s?|ok|okey|listo|dale|ah|aah"
    r"|por\s*lo\s*que|entonces|o\s*sea|as[ií]|tipo|digamos|primero|ai|uy|guau"
    # conectores/palabras que no aportan al "objeto" de una acción
    r"|como|estas|est[eá]s|c[oó]mo|que|qu[eé]|a|de|el|la|los|las|lo|le|un|una|"
    r"unos|unas|al|del|y|o|pero|si|s[ií]|no|me|te|se|mi|tu|su"
    r")\b"
)


def _determine_intent_deterministic(user_text: str) -> str | None:
    """Deterministic intent detection for clear cases - runs BEFORE Qwen.
    
    Returns intent letter (A, B) or None if ambiguous/requires Qwen.
    """
    text = user_text.lower().strip()
    # Quitar saludos y muletillas rioplatenses: "hola trae, como estas?"
    # no debe clasificarse como acción de PC solo por contener "trae".
    cleaned = _SALUDOS_Y_MULETILLAS.sub(" ", text)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    # La pregunta de hora/fecha gana sobre una posible acción de PC:
    # "hola trae, que hora es?" no debe abrir una app llamada "trae".
    time_patterns = [
        r"\bqu[eé]\s+hora\b",
        r"\bque\s+hora\b",
        r"\bhora\s+actual\b",
        r"\bqu[eé]\s+fecha\b",
        r"\bque\s+fecha\b",
        r"\bfecha\s+(de\s+hoy|actual)\b",
        r"\bqu[eé]\s+d[ií]a\s+es\b",
        r"\bque\s+dia\s+es\b",
        r"\bcu[aá]l\s+es\s+la\s+hora\b",
        r"\bcual\s+es\s+la\s+hora\b",
        r"\bcu[aá]l\s+es\s+la\s+fecha\b",
    ]
    for pattern in time_patterns:
        if re.search(pattern, text):
            return "B"

    # Clear PC action patterns (A)
    pc_action_patterns = [
        r"\b(abr[íi]|abre|abrir|ejecut[ai]|inici[ao]|lanzar)\b",
        r"\b(cerrar|cerr[ao]|cierr[aáe]|cerre|matar|terminar)\b",
        r"\b(enfoca|enfocar|trae|traer|foco|focus)\b",
        r"\b(bloquea|bloquear|lock|bloquear\s+pantalla)\b",
    ]
    for pattern in pc_action_patterns:
        if re.search(pattern, cleaned):
            # Una orden real de PC tiene verbo + objeto ("trae navegador").
            # Un verbo suelto sin objeto ("hola trae, como estas" -> "trae")
            # es una muletilla: dejarlo para Qwen.
            tokens = [t for t in re.split(r"\s+", cleaned) if t]
            content_tokens = [
                t for t in tokens
                if re.search(r"[a-záéíóúüñ]", t)
            ]
            if len(content_tokens) >= 2:
                return "A"
    
    return None


async def handle_text_input(session_id: str, client_id: str, user_text: str, websocket) -> None:
    """Process text input through deterministic detection -> Qwen local -> tools."""
    _safe_print(f"[juana-core] TEXT_INPUT: '{user_text}' (session={session_id})")
    # Espera a que termine cualquier turno en curso (serialización global).
    async with TURN_LOCK:
        # Get conversation history
        hist = history.get(session_id)
        history.add(session_id, "user", user_text)

        await send_ui_state(websocket, session_id, "thinking")
        # 1. Deterministic detection FIRST (before Qwen)
        intent = _determine_intent_deterministic(user_text)
        if not intent:
            # 2. Only call Qwen for ambiguous/conversational cases
            try:
                intent = await qwen_provider.classify_intent(user_text)
            except Exception as e:
                _safe_print(f"[juana-core] Qwen classification error: {e}")
                # Fallback deterministic cuando llama-server no está disponible
                intent = _determine_intent_deterministic(user_text) or "C"
            _safe_print(f"[juana-core] INTENT=QWEN_LOCAL -> {intent}")
        else:
            _safe_print(f"[juana-core] INTENT={'PC' if intent=='A' else 'TIME'} (deterministic)")

        response_text = ""
        tool_result = {"ok": False}

        try:
            if intent == "A":
                _safe_print(f"[juana-core] INTENT=PC")
                response_text, tool_result = await handle_intent_A(user_text)
            elif intent == "B":
                _safe_print(f"[juana-core] INTENT=TIME")
                response_text, tool_result = await handle_intent_B(user_text)
            elif intent == "C":
                _safe_print(f"[juana-core] INTENT=QWEN_LOCAL")
                response_text, tool_result = await handle_intent_C(user_text, qwen_provider, hist)
            elif intent == "D":
                _safe_print(f"[juana-core] INTENT=GEMINI")
                response_text, tool_result = await handle_intent_D(user_text, hist)
            else:
                response_text = "No entendí la intención."
                tool_result = {"ok": False}
        except Exception as e:
            _safe_print(f"[juana-core] Handler error: {e}")
            response_text = "Error procesando la solicitud."
            tool_result = {"ok": False}

        # Add to history
        history.add(session_id, "assistant", response_text)

        # Send TEXT_RESPONSE
        resp = {
            "type": "text_response",
            "session_id": session_id,
            "client_id": client_id,
            "text": response_text,
            "ts": int(time.time() * 1000),
        }
        await websocket.send(json.dumps(resp))
        _safe_print(f"[juana-core] TEXT_RESPONSE: '{response_text[:80]}'")

        # Voz de la respuesta según el target (pc → stream al sidecar, server → aplay)
        target = connected_clients.get(session_id, {}).get("response_target", RESPONSE_TARGET_DEFAULT)
        if target == "server":
            _safe_print("[juana-core] target=server, reproduciendo en altavoz local")
            await send_ui_state(websocket, session_id, "speaking")
            play_pcm_local(synth_pcm(response_text))
        elif target == "pc":
            await send_ui_state(websocket, session_id, "speaking")
            await send_tts_stream(websocket, response_text, session_id)
        else:
            _safe_print(f"[juana-core] target '{target}' desconocido, sin audio")

    # Turno completado: volver a reposo si este session sigue viva
    if session_id in connected_clients:
        await send_ui_state(websocket, session_id, "idle")


async def process_transcribed_audio(
    websocket, session_id: str, client_id: str, audio_chunks: bytes
) -> None:
    """Transcribe y genera respuesta de voz (misma pipeline que texto)."""
    try:
        transcript = run_whisper_transcribe(audio_chunks, language="es")
        _safe_print(f"[juana-core] Transcripción: '{transcript}'", )
        transcript_msg = {
            "type": "TRANSCRIPT",
            "session_id": session_id,
            "client_id": client_id,
            "text": transcript,
        }
        await websocket.send(json.dumps(transcript_msg))
        _safe_print(f"[juana-core] TRANSCRIPT enviado: '{transcript}'", )
        if transcript.strip():
            await handle_text_input(session_id, client_id, transcript, websocket)
        else:
            _safe_print("[juana-core] Transcripción vacía, sin respuesta")
            await send_ui_state(websocket, session_id, "idle")
    except Exception as e:
        _safe_print(f"[juana-core] Error en process_transcribed_audio: {e}")
        await send_ui_state(websocket, session_id, "idle")


async def handler(websocket: websockets.WebSocketServerProtocol) -> None:
    global connected_clients, session_counter
    _safe_print(f"[juana-core] Nueva conexión WS desde {websocket.remote_address}")
    try:
        # websockets >= 17: el server expone la ruta pedida (path + query) en
        # request.path; versiones antiguas la tienen en websocket.path.
        request = getattr(websocket, "request", None)
        full_path = getattr(request, "path", "") if request is not None else ""
        if not full_path:
            full_path = getattr(websocket, "path", "") or ""
        query = parse_qs(urlsplit(full_path).query)
        token = query.get("token", [None])[0] if query else None
    except Exception:
        token = None
    _safe_print(f"[juana-core] Nueva conexión WS desde {websocket.remote_address}")
    _safe_print(f"[juana-core] Token recibido: {token[:4] if token else 'None'}****")
    if not token:
        _safe_print("[juana-core] Conexión sin token: rejecting", )
        await websocket.close(code=1008, reason="missing token")
        return
    expected_secret = os.environ.get(SECRET_ENV_VAR, "")
    if not validate_token(token, expected_secret):
        _safe_print(f"[juana-core] Token inválido. Prefijo esperado: {expected_secret[:4] if expected_secret else 'None'}****", )
        await websocket.close(code=1008, reason="invalid token")
        return
    session_counter += 1
    session_id = str(uuid.uuid4())
    client_id = token[:8]
    connected_clients[session_id] = {
        "session_id": session_id,
        "client_id": client_id,
        "token": token,
        "connected_at": time.time(),
        "response_target": RESPONSE_TARGET_DEFAULT,
    }
    _safe_print(f"[juana-core] Sesión {session_id} activada para {client_id}", )
    _safe_print(f"[juana-core] Endpoint: ws://0.0.0.0:{PORT}/connect?token={token[:4] if token else 'None'}****", )
    _safe_print(f"[juana-core] Cliente ID: {client_id}", )
    session_msg = {
        "type": "session_ready",
        "session_id": session_id,
        "client_id": client_id,
    }
    await websocket.send(json.dumps(session_msg))
    _safe_print(f"[juana-core] SESSION_READY enviado", )
    
    # Audio session state
    audio_chunks: bytearray = bytearray()
    is_recording = False
    
    try:
        async for message in websocket:
            if isinstance(message, bytes):
                # Binary audio chunk (raw PCM)
                if is_recording:
                    audio_chunks.extend(message)
                continue
            
            text = message if isinstance(message, str) else json.dumps(message)
            try:
                msg = json.loads(text)
            except (json.JSONDecodeError, TypeError):
                continue
            
            _safe_print(f"[juana-core] Mensaje recibido: type={msg.get('type')}", )
            msg_type = msg.get("type")
            
            if msg_type == "ack":
                _safe_print(f"[juana-core] ACK recibido para sesión {msg.get('session_id')}", )
                await websocket.send(json.dumps({"type": "heartbeat", "session_id": msg.get("session_id")}))
            elif msg_type == "ping":
                _safe_print("[juana-core] PING recibido", )
                await websocket.send(json.dumps({"type": "pong"}))
            elif msg_type == "orb_state":
                await websocket.send(json.dumps({"type": "orb_state_ack", "session_id": msg.get("session_id"), "state": msg.get("state")}))
            elif msg_type == "disconnect":
                _safe_print("[juana-core] Solicitud de desconexión", )
                break
            elif msg_type in ("AUDIO_START", "hold_start"):
                _safe_print(f"[juana-core] {msg_type} recibido", )
                is_recording = True
                audio_chunks = bytearray()
                await websocket.send(json.dumps({"type": "ack"}))
            elif msg_type == "AUDIO_CHUNK":
                _safe_print(f"[juana-core] AUDIO_CHUNK recibido ({len(message)} bytes)", )
                if is_recording:
                    audio_chunks.extend(message)
                await websocket.send(json.dumps({"type": "ack"}))
            elif msg_type in ("AUDIO_END", "hold_end", "audio_end"):
                _safe_print(f"[juana-core] {msg_type} recibido, procesando transcripción...")
                is_recording = False
                try:
                    await process_transcribed_audio(websocket, session_id, client_id, bytes(audio_chunks))
                except Exception as e:
                    _safe_print(f"[juana-core] Error procesando audio: {e}")
                    await send_ui_state(websocket, session_id, "idle")
                audio_chunks = bytearray()
            elif msg_type in ("TEXT_INPUT", "text_input"):
                user_text = msg.get("text", "").strip()
                if user_text:
                    await handle_text_input(session_id, client_id, user_text, websocket)
                else:
                    _safe_print("[juana-core] TEXT_INPUT vacío ignorado")
            elif msg_type == "set_response_output_target":
                target = msg.get("target", RESPONSE_TARGET_DEFAULT)
                if target in ("pc", "server"):
                    if session_id in connected_clients:
                        connected_clients[session_id]["response_target"] = target
                    _safe_print(f"[juana-core] Respuesta de voz dirigida a: {target}")
                else:
                    _safe_print(f"[juana-core] target '{target}' inválido, ignorado")
            else:
                _safe_print(f"[juana-core] Tipo de mensaje desconocido: {msg_type}", )
    except websockets.exceptions.ConnectionClosed:
        _safe_print("[juana-core] Conexión cerrada por el cliente", )
    finally:
        # Use session_id for cleanup, not websocket.session_id
        connected_clients.pop(session_id, None)
        _safe_print("[juana-core] Cliente desconectado", )


async def main() -> None:
    if not os.environ.get(SECRET_ENV_VAR):
        print(f"[juana-core] ADVERTENCIA: {SECRET_ENV_VAR} no está configurado. ", )
        print(f"[juana-core] El cliente Apollo fallará al conectar hasta que se setee este env var.", )
    async with websockets.serve(handler, "0.0.0.0", PORT):
        _safe_print(f"[juana-core] Apollo Core escuchando en ws://0.0.0.0:{PORT}", )
        print(f"[juana-core] Presiona Ctrl+C para detener el servidor", )
        await asyncio.Future()


if __name__ == "__main__":
    _safe_print("[juana-core] Iniciando Apollo Core...")
    asyncio.run(main())