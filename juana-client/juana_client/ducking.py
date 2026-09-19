"""Ducking: baja Spotify/navegador a 25% mientras Apollo habla (Windows, pycaw)."""

import time
from typing import Optional

try:
    from pycaw.pycaw import AudioUtilities  # type: ignore
    _PYCAW_AVAILABLE = True
except Exception:
    AudioUtilities = None  # type: ignore
    _PYCAW_AVAILABLE = False

DUCKED_VOLUME = 0.25
_DUCK_KEYWORDS = ("spotify", "brave", "chrome", "msedge", "firefox", "edge")


def _find_session_volume(session) -> Optional[object]:
    try:
        return session.SimpleAudioVolume
    except Exception:
        return None


def _session_matches(name: str) -> bool:
    low = (name or "").lower()
    return any(kw in low for kw in _DUCK_KEYWORDS)


def duck_sessions() -> dict[int, float]:
    """Baja a 25% las sesiones que estén sonando. Devuelve mapa id->volumen previo."""
    if not _PYCAW_AVAILABLE or AudioUtilities is None:
        return {}
    previous: dict[int, float] = {}
    try:
        for session in AudioUtilities.GetAllSessions():
            vol = _find_session_volume(session)
            if vol is None:
                continue
            try:
                current = float(vol.GetMasterVolume())
            except Exception:
                continue
            if current < 0.05:
                continue
            # solo si está sonando (evita tocar apps en silencio)
            name = ""
            try:
                name = session.Process.name() if session.Process else ""
            except Exception:
                pass
            if not _session_matches(name):
                continue
            previous[id(session)] = current
            try:
                vol.SetMasterVolume(DUCKED_VOLUME, None)
            except Exception:
                pass
    except Exception:
        pass
    # pequeño delay para que el duck sea audible antes del TTS
    if previous:
        time.sleep(0.08)
    return previous


def restore_sessions(previous: dict[int, float]) -> None:
    """Restaura volúmenes previos."""
    if not previous or not _PYCAW_AVAILABLE or AudioUtilities is None:
        return
    try:
        for session in AudioUtilities.GetAllSessions():
            prev = previous.get(id(session))
            if prev is None:
                continue
            vol = _find_session_volume(session)
            if vol is None:
                continue
            try:
                vol.SetMasterVolume(prev, None)
            except Exception:
                pass
    except Exception:
        pass
