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

connected_clients: dict[str, dict] = {}
session_counter = 0

# Initialize providers
qwen_provider = LocalQwenProvider()
history = get_history()


def validate_token(secret_from_ws: str, expected_secret: str) -> bool:
    return secret_from_ws == expected_secret


def _safe_print(msg: str) -> None:
    print(msg)
    sys.stdout.flush()


def run_whisper_transcribe(audio_chunks: bytes, language: str = "es") -> str:
    """Transcribe audio chunks using Whisper Tiny model."""
    try:
        temp_path = f"/tmp/apollo_audio_{uuid.uuid4().hex}.pcm"
        with open(temp_path, "wb") as f:
            f.write(audio_chunks)
        
        result = subprocess.run(
            [
                "whisper",
                temp_path,
                "--model", "tiny",
                "--language", language,
                "--output_format", "json",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        
        if result.returncode == 0 and result.stdout:
            import json as _json
            try:
                data = _json.loads(result.stdout)
                return data.get("text", "").strip()
            except (json.JSONDecodeError, TypeError):
                return ""
        
        return ""
    except Exception as e:
        _safe_print(f"[juana-core] Error en Whisper transcription: {str(e)[:100]}", )
        return ""


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
    
    # Clear time/date patterns (B) - handles both accented and non-accented Spanish
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
    
    return None


async def handle_text_input(session_id: str, client_id: str, user_text: str, websocket) -> None:
    """Process text input through deterministic detection -> Qwen local -> tools."""
    _safe_print(f"[juana-core] TEXT_INPUT: '{user_text}' (session={session_id})")
    
    # Get conversation history
    hist = history.get(session_id)
    history.add(session_id, "user", user_text)
    
    # 1. Deterministic detection FIRST (before Qwen)
    intent = _determine_intent_deterministic(user_text)
    if intent:
        if intent == "A":
            _safe_print(f"[juana-core] INTENT=PC (deterministic)")
        elif intent == "B":
            _safe_print(f"[juana-core] INTENT=TIME (deterministic)")
    else:
        # 2. Only call Qwen for ambiguous/conversational cases
        try:
            intent = await qwen_provider.classify_intent(user_text)
        except Exception as e:
            _safe_print(f"[juana-core] Qwen classification error: {e}")
            intent = "C"  # Default to local conversation
        _safe_print(f"[juana-core] INTENT=QWEN_LOCAL -> {intent}")
    
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
            elif msg_type == "AUDIO_START":
                _safe_print("[juana-core] AUDIO_START recibido", )
                is_recording = True
                audio_chunks = bytearray()
                await websocket.send(json.dumps({"type": "ack"}))
            elif msg_type == "AUDIO_CHUNK":
                _safe_print(f"[juana-core] AUDIO_CHUNK recibido ({len(message)} bytes)", )
                if is_recording:
                    audio_chunks.extend(message)
                await websocket.send(json.dumps({"type": "ack"}))
            elif msg_type == "AUDIO_END":
                _safe_print("[juana-core] AUDIO_END recibido, procesando con Whisper...", )
                is_recording = False
                
                transcript = run_whisper_transcribe(bytes(audio_chunks), language="es")
                
                _safe_print(f"[juana-core] Transcripción: '{transcript}'", )
                
                transcript_msg = {
                    "type": "TRANSCRIPT",
                    "session_id": session_id,
                    "client_id": client_id,
                    "text": transcript,
                }
                await websocket.send(json.dumps(transcript_msg))
                _safe_print(f"[juana-core] TRANSCRIPT enviado: '{transcript}'", )
                
                audio_chunks = bytearray()
            elif msg_type in ("TEXT_INPUT", "text_input"):
                user_text = msg.get("text", "").strip()
                if user_text:
                    await handle_text_input(session_id, client_id, user_text, websocket)
                else:
                    _safe_print("[juana-core] TEXT_INPUT vacío ignorado")
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