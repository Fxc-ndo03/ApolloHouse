"""Tool registry with allowlist, validation, and executors."""

import datetime
import json
import os
import zoneinfo
from typing import Any

import aiohttp


# Allowlisted tools with schemas
TOOL_SCHEMAS = {
    "open_pc_app": {
        "type": "object",
        "properties": {
            "app_name": {"type": "string", "minLength": 1},
            "args": {"type": "string", "default": ""},
        },
        "required": ["app_name"],
        "additionalProperties": False,
    },
    "focus_pc_app": {
        "type": "object",
        "properties": {
            "app_name": {"type": "string", "minLength": 1},
        },
        "required": ["app_name"],
        "additionalProperties": False,
    },
    "close_pc_app": {
        "type": "object",
        "properties": {
            "app_name": {"type": "string", "minLength": 1},
        },
        "required": ["app_name"],
        "additionalProperties": False,
    },
    "lock_pc_screen": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
    "system.get_time": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
    "system.get_date": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
}

ALLOWED_TOOLS = frozenset(TOOL_SCHEMAS.keys())

PC_BRIDGE_TOOLS = frozenset(["open_pc_app", "focus_pc_app", "close_pc_app", "lock_pc_screen"])
LOCAL_TOOLS = frozenset(["system.get_time", "system.get_date"])

# Map intent letter to tool name
INTENT_TO_TOOL = {
    "A": ["open_pc_app", "focus_pc_app", "close_pc_app", "lock_pc_screen"],
    "B": ["system.get_time", "system.get_date"],
}

# Argentina timezone
ARGENTINA_TZ = zoneinfo.ZoneInfo("America/Argentina/Buenos_Aires")

# Worker URL - must be the deployed Cloudflare Worker, NOT localhost
WORKER_INTERNAL_URL = os.getenv("WORKER_INTERNAL_URL", "https://apollo.facupapollo.workers.dev")


def validate_tool_call(tool_name: str, args: dict) -> tuple[bool, str | None]:
    """Validate tool name and arguments against schema."""
    if tool_name not in ALLOWED_TOOLS:
        return False, f"Tool not allowed: {tool_name}"

    schema = TOOL_SCHEMAS[tool_name]
    # Required fields
    for req in schema.get("required", []):
        if req not in args:
            return False, f"Missing required field: {req}"
    # No extra properties
    for key in args:
        if key not in schema["properties"]:
            return False, f"Unexpected field: {key}"
    return True, None


async def execute_local_tool(tool_name: str, args: dict) -> dict:
    """Execute local tools (time, date) directly in Core using Argentina timezone."""
    now = datetime.datetime.now(ARGENTINA_TZ)
    if tool_name == "system.get_time":
        return {"ok": True, "result": now.strftime("%H:%M:%S")}
    elif tool_name == "system.get_date":
        return {"ok": True, "result": now.strftime("%A, %d de %B de %Y")}
    return {"ok": False, "error": f"Unknown local tool: {tool_name}"}


async def execute_pc_bridge_tool(tool_name: str, args: dict) -> dict:
    """Execute PC Bridge tools via Worker internal endpoint."""
    worker_url = os.getenv("WORKER_INTERNAL_URL", WORKER_INTERNAL_URL)
    internal_token = os.getenv("INTERNAL_CORE_TOKEN", "")

    # Map tool_name to PcBridge command
    command_map = {
        "open_pc_app": ("apps_open", {"appName": args["app_name"], "args": args.get("args", "")}),
        "focus_pc_app": ("apps_focus", {"appName": args["app_name"]}),
        "close_pc_app": ("apps_close", {"appName": args["app_name"]}),
        "lock_pc_screen": ("lock_screen", {}),
    }

    if tool_name not in command_map:
        return {"ok": False, "error": f"Unknown PC tool: {tool_name}"}

    command_type, payload = command_map[tool_name]

    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
            headers = {"Content-Type": "application/json"}
            if internal_token:
                headers["X-Internal-Token"] = internal_token

            async with session.post(
                f"{worker_url}/api/internal/pc-bridge",
                json={"command": command_type, "args": payload},
                headers=headers,
            ) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    return {"ok": False, "error": f"Worker error {resp.status}: {error_text}"}
                return await resp.json()
    except aiohttp.ClientError as e:
        return {"ok": False, "error": f"Worker connection failed: {e}"}
    except asyncio.TimeoutError:
        return {"ok": False, "error": "Worker timeout"}


async def execute_tool(tool_name: str, args: dict) -> dict:
    """Main entry: validate and execute tool."""
    valid, error = validate_tool_call(tool_name, args)
    if not valid:
        return {"ok": False, "error": error}

    if tool_name in LOCAL_TOOLS:
        return await execute_local_tool(tool_name, args)
    elif tool_name in PC_BRIDGE_TOOLS:
        return await execute_pc_bridge_tool(tool_name, args)
    return {"ok": False, "error": f"Tool not implemented: {tool_name}"}


def resolve_tool_for_intent(intent: str, user_text: str) -> str | None:
    """Map intent letter + user text to specific tool."""
    if intent == "B":
        # Time or date?
        if any(w in user_text.lower() for w in ["hora", "horas", "time"]):
            return "system.get_time"
        return "system.get_date"
    elif intent == "A":
        # Determine which PC action
        text = user_text.lower()
        if any(w in text for w in ["abr", "abre", "abrir", "ejecut", "iniciar", "lanzar"]):
            return "open_pc_app"
        elif any(w in text for w in ["enfoc", "traer", "foco", "focus"]):
            return "focus_pc_app"
        elif any(w in text for w in ["cierr", "cierra", "close", "matar", "terminar"]):
            return "close_pc_app"
        elif any(w in text for w in ["bloque", "lock", "bloquear"]):
            return "lock_pc_screen"
        # Default to open
        return "open_pc_app"
    return None


def extract_app_name(user_text: str) -> str:
    """Extract app name from user text for open/focus/close."""
    text = user_text.lower().strip()
    for suffix in ["en mi pc", "en la pc", "en pc"]:
        if text.endswith(suffix):
            text = text[:-len(suffix)].strip()
    verbs_long = ["abre el", "abre la", "ejecuta el", "ejecuta la",
                  "inicia el", "inicia la", "lanza el", "lanza la",
                  "cierra el", "cierra la"]
    verbs_short = ["abri", "abre", "abrir", "abro", "ejecuta", "inicia", "lanza",
                   "enfoca", "enfocar", "trae", "traer",
                   "cierra", "cerrar", "matar"]
    for verb in verbs_long + verbs_short:
        if text.startswith(verb + " "):
            text = text[len(verb):].strip()
            break
    for art in ["el ", "la ", "los ", "las "]:
        if text.startswith(art):
            text = text[len(art):].strip()
    text = text.strip(" ,.¿?¡!")
    app_map = {
        "bloc de notas": "notepad",
        "bloc": "notepad",
        "notas": "notepad",
        "notepad": "notepad",
        "navegador": "brave",
        "browser": "brave",
        "brave": "brave",
        "edge": "msedge",
        "chrome": "chrome",
        "firefox": "firefox",
        "explorador": "explorer",
        "explorador de archivos": "explorer",
        "archivos": "explorer",
        "calculadora": "calc",
        "calc": "calc",
        "spotify": "spotify",
        "código": "code",
        "vscode": "code",
        "visual studio code": "code",
        "terminal": "powershell",
        "consola": "powershell",
        "powershell": "powershell",
        "configuración": "ms-settings:",
        "ajustes": "ms-settings:",
    }
    if text in app_map:
        return app_map[text]
    for key, val in app_map.items():
        if key in text:
            return val
    return text


async def handle_intent_A(user_text: str) -> tuple[str, dict]:
    """Handle PC action intent: determine tool, extract args, execute."""
    tool_name = resolve_tool_for_intent("A", user_text)
    if not tool_name:
        return "No entendí la acción.", {"ok": False}

    if tool_name in ["open_pc_app", "focus_pc_app", "close_pc_app"]:
        app_name = extract_app_name(user_text)
        args = {"app_name": app_name}
        if tool_name == "open_pc_app":
            # Check for URL args
            if "http" in user_text:
                import re
                urls = re.findall(r'https?://\S+', user_text)
                if urls:
                    args["args"] = urls[0]
    else:
        args = {}

    result = await execute_tool(tool_name, args)
    if result.get("ok"):
        action_verb = {
            "open_pc_app": "Abriendo",
            "focus_pc_app": "Enfocando",
            "close_pc_app": "Cerrando",
            "lock_pc_screen": "Bloqueando",
        }.get(tool_name, "Ejecutando")
        return f"{action_verb} {args.get('app_name', '')}.", result
    else:
        return f"No pude ejecutar la acción: {result.get('error', 'error desconocido')}", result


async def handle_intent_B(user_text: str) -> tuple[str, dict]:
    """Handle system info intent."""
    tool_name = resolve_tool_for_intent("B", user_text)
    result = await execute_tool(tool_name, {})
    if result.get("ok"):
        if tool_name == "system.get_time":
            return f"Son las {result['result']}.", result
        else:
            return f"Hoy es {result['result']}.", result
    return "No pude obtener la información.", result


async def handle_intent_C(user_text: str, qwen_provider, history: list[dict]) -> tuple[str, dict]:
    """Handle local conversation intent."""
    try:
        response = await qwen_provider.chat_local(user_text, history)
        return response, {"ok": True}
    except Exception:
        # Cuando llama-server no está disponible, respuesta genérica amable.
        lowered = user_text.lower()
        if any(w in lowered for w in ["hola", "buenos", "qué tal", "hey", "saludos"]):
            return "¡Hola! Puedo ayudarte con tareas de la PC (abrir apps, consultar hora/fecha).", {"ok": False}
        return "Puedo ayudarte abriendo apps, consultando hora o fecha. ¿En qué te puedo ayudar?", {"ok": False}


async def handle_intent_D(user_text: str, history: list[dict]) -> tuple[str, dict]:
    """Handle escalation to Gemini via Worker."""
    worker_url = os.getenv("WORKER_INTERNAL_URL", WORKER_INTERNAL_URL)
    internal_token = os.getenv("INTERNAL_CORE_TOKEN", "")

    messages = []
    if history:
        messages.extend(history[-6:])
    messages.append({"role": "user", "content": user_text})

    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
            headers = {"Content-Type": "application/json"}
            if internal_token:
                headers["X-Internal-Token"] = internal_token

            async with session.post(
                f"{worker_url}/api/internal/gemini-chat",
                json={"messages": messages, "tools": []},
                headers=headers,
            ) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    return f"Error en Gemini: {resp.status}", {"ok": False}
                data = await resp.json()
                return data.get("text", "Sin respuesta de Gemini."), {"ok": True}
    except Exception as e:
        return f"Error escalando a Gemini: {e}", {"ok": False}