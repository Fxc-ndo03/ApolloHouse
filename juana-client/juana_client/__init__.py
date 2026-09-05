"""Juana Client - Python client for Apollo (Juana) voice assistant."""

from .client import JuanaClient, JuanaConfig, ConnectionState
from .protocol import (
    HelloMessage,
    HoldStartMessage,
    HoldEndMessage,
    TextInputMessage,
    AbortMessage,
    ConfirmMessage,
    SetResponseOutputTargetMessage,
    TelemetryMessage,
    parse_server_message,
    TtsStartMessage,
    TtsEndMessage,
    TtsAbortedMessage,
    TurnEndMessage,
    UiStateMessage,
    ConfirmRequestMessage,
    ErrorMessage,
)
from .audio import AudioCapture, AudioPlayback
from .wake import (
    VoskWakeWordDetector,
    ManualWakeWordDetector,
    create_wake_detector,
    download_vosk_model,
)

__version__ = "0.1.0"
__all__ = [
    "JuanaClient",
    "JuanaConfig",
    "ConnectionState",
    "HelloMessage",
    "HoldStartMessage",
    "HoldEndMessage",
    "TextInputMessage",
    "AbortMessage",
    "ConfirmMessage",
    "SetResponseOutputTargetMessage",
    "TelemetryMessage",
    "parse_server_message",
    "TtsStartMessage",
    "TtsEndMessage",
    "TtsAbortedMessage",
    "TurnEndMessage",
    "UiStateMessage",
    "ConfirmRequestMessage",
    "ErrorMessage",
    "AudioCapture",
    "AudioPlayback",
    "VoskWakeWordDetector",
    "ManualWakeWordDetector",
    "create_wake_detector",
    "download_vosk_model",
]