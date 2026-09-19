"""In-memory session history with size limits."""

import threading
from typing import Any


class SessionHistory:
    """Thread-safe in-memory history per session_id."""

    def __init__(self, max_turns: int = 10, max_tokens: int = 2000):
        self.max_turns = max_turns
        self.max_tokens = max_tokens
        self._data: dict[str, list[dict]] = {}
        self._lock = threading.RLock()

    def add(self, session_id: str, role: str, content: str) -> None:
        """Add a message to session history."""
        with self._lock:
            if session_id not in self._data:
                self._data[session_id] = []
            self._data[session_id].append({"role": role, "content": content})
            self._trim(session_id)

    def get(self, session_id: str) -> list[dict]:
        """Get history for session."""
        with self._lock:
            return self._data.get(session_id, []).copy()

    def clear(self, session_id: str) -> None:
        """Clear history for session."""
        with self._lock:
            self._data.pop(session_id, None)

    def _trim(self, session_id: str) -> None:
        """Trim history to limits."""
        history = self._data[session_id]
        # Trim by turns (each turn = user + assistant = 2 messages)
        max_messages = self.max_turns * 2
        if len(history) > max_messages:
            history[:] = history[-max_messages:]

        # Rough token estimate: 1 token ~= 4 chars
        total_chars = sum(len(m["content"]) for m in history)
        estimated_tokens = total_chars // 4
        while estimated_tokens > self.max_tokens and len(history) > 2:
            removed = history.pop(0)
            total_chars -= len(removed["content"])
            estimated_tokens = total_chars // 4


# Global instance
_history = SessionHistory()


def get_history() -> SessionHistory:
    return _history