"""Local Qwen provider using llama-server HTTP API."""

import asyncio
import json
import os
from typing import Any

import aiohttp


DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080/v1/chat/completions"
DEFAULT_MODEL = "qwen2.5-0.5b-instruct"


# Short, stable system prompt for classification - no history
CLASSIFIER_SYSTEM_PROMPT = """Clasifica la intención del usuario en una sola letra:

A = ACCIÓN EN PC (abrir/cerrar/enfocar apps, bloquear pantalla)
B = HORA/FECHA (consultar hora o fecha actual)
C = CONVERSACIÓN LOCAL (saludos, charla casual, preguntas simples)
D = ESCALAR A GEMINI (preguntas complejas, conocimiento general, código, análisis)

Responde SOLO con la letra (A, B, C o D). Sin explicaciones."""


class LocalQwenProvider:
    """Client for llama-server OpenAI-compatible API."""

    def __init__(
        self,
        base_url: str | None = None,
        model: str | None = None,
        timeout: float = 3.0,
    ):
        self.base_url = base_url or os.getenv("LLAMA_SERVER_URL", DEFAULT_LLAMA_SERVER_URL)
        self.model = model or os.getenv("LLAMA_MODEL", DEFAULT_MODEL)
        self.timeout = aiohttp.ClientTimeout(total=timeout, connect=2.0)
        self._session: aiohttp.ClientSession | None = None
        self._server_down = False

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=self.timeout)
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    async def classify_intent(self, user_text: str) -> str:
        """Classify user intent: A, B, C, or D.
        
        Does NOT use history - classifier works best with short prompts.
        Uses temperature=0 for deterministic output, max_tokens=1 for single letter.
        """
        if self._server_down:
            return "C"
        session = await self._ensure_session()

        messages = [
            {"role": "system", "content": CLASSIFIER_SYSTEM_PROMPT},
            {"role": "user", "content": user_text}
        ]

        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0,
            "max_tokens": 1,
            "stop": ["\n", " "],
        }

        try:
            async with session.post(self.base_url, json=payload) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    raise RuntimeError(f"llama-server error {resp.status}: {error_text}")
                data = await resp.json()
        except asyncio.TimeoutError:
            self._server_down = True
            raise RuntimeError("llama-server timeout")
        except aiohttp.ClientError as e:
            self._server_down = True
            raise RuntimeError(f"llama-server connection error: {e}")

        try:
            content = data["choices"][0]["message"]["content"].strip().upper()
            if content and content[0] in ("A", "B", "C", "D"):
                return content[0]
        except (KeyError, IndexError, TypeError):
            pass

        # Default fallback
        return "C"

    async def chat_local(self, user_text: str, history: list[dict] | None = None) -> str:
        """Generate a local conversational response (for intent C)."""
        if self._server_down:
            raise RuntimeError("llama-server down")
        session = await self._ensure_session()

        messages = [
            {
                "role": "system",
                "content": "Eres Apollo, un asistente local breve y útil. Responde en español de forma natural y concisa.",
            }
        ]
        if history:
            messages.extend(history[-6:])
        messages.append({"role": "user", "content": user_text})

        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.5,
            "max_tokens": 150,
        }

        try:
            async with session.post(self.base_url, json=payload) as resp:
                if resp.status != 200:
                    self._server_down = True
                    raise RuntimeError(f"llama-server error {resp.status}")
                data = await resp.json()
                return data["choices"][0]["message"]["content"].strip()
        except Exception as e:
            self._server_down = True
            raise RuntimeError(f"Local chat failed: {e}")


async def test_provider():
    """Quick test if run directly."""
    provider = LocalQwenProvider()
    try:
        test_cases = [
            "abrí el bloc de notas",
            "qué hora es",
            "che Apollo, ¿cómo estás?",
            "explícame la teoría de la relatividad",
        ]
        for tc in test_cases:
            intent = await provider.classify_intent(tc)
            print(f"  '{tc}' -> {intent}")
    finally:
        await provider.close()


if __name__ == "__main__":
    asyncio.run(test_provider())