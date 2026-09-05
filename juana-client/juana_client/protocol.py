"""Protocol message types for Juana client."""

from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional
import json


class ClientMessageType(str, Enum):
    """Message types sent from client to server."""
    HELLO = "hello"
    HOLD_START = "hold_start"
    HOLD_END = "hold_end"
    WAKE = "wake"
    AUDIO_END = "audio_end"
    LISTEN_CANCEL = "listen_cancel"
    TEXT_INPUT = "text_input"
    ABORT = "abort"
    CONFIRM = "confirm"
    GESTURE = "gesture"
    TELEMETRY = "telemetry"
    MCP = "mcp"
    PLAYBACK_ACK = "playback_ack"
    ALARM_DISMISS = "alarm_dismiss"
    SET_RESPONSE_OUTPUT_TARGET = "set_response_output_target"


class ServerMessageType(str, Enum):
    """Message types received from server."""
    UI_STATE = "ui_state"
    CONFIRM_REQUEST = "confirm_request"
    CONFIRM_CLOSE = "confirm_close"
    TTS_START = "tts_start"
    TTS_END = "tts_end"
    TTS_ABORTED = "tts_aborted"
    TIMER = "timer"
    TURN_END = "turn_end"
    ERROR = "error"
    DASHBOARD = "dashboard"
    BACKGROUND_RESULT = "background_result"
    REMINDER = "reminder"
    PLAY_EFFECT = "play_effect"
    MCP = "mcp"
    ALARM_RING = "alarm_ring"
    SET_RESPONSE_OUTPUT_TARGET = "set_response_output_target"


@dataclass
class HelloMessage:
    """Initial hello message to establish connection."""
    type: str = "hello"
    hostname: str = "juana-client"
    ts: int = 0

    def to_json(self) -> str:
        return json.dumps(self.__dict__)


@dataclass
class HoldStartMessage:
    """Start of a press-and-hold audio capture."""
    type: str = "hold_start"
    ts: int = 0

    def to_json(self) -> str:
        return json.dumps(self.__dict__)


@dataclass
class HoldEndMessage:
    """End of a press-and-hold audio capture."""
    type: str = "hold_end"
    ts: int = 0

    def to_json(self) -> str:
        return json.dumps(self.__dict__)


@dataclass
class TextInputMessage:
    """Text input (alternative to voice)."""
    type: str = "text_input"
    text: str = ""
    ts: int = 0

    def to_json(self) -> str:
        return json.dumps(self.__dict__)


@dataclass
class AbortMessage:
    """Abort current turn."""
    type: str = "abort"
    ts: int = 0

    def to_json(self) -> str:
        return json.dumps(self.__dict__)


@dataclass
class ConfirmMessage:
    """Confirm or deny a pending tool confirmation."""
    type: str = "confirm"
    ok: bool = False
    ts: int = 0

    def to_json(self) -> str:
        return json.dumps(self.__dict__)


@dataclass
class SetResponseOutputTargetMessage:
    """Set where TTS audio should be routed."""
    type: str = "set_response_output_target"
    target: str = "pc"  # "pc" or "server"
    ts: int = 0

    def to_json(self) -> str:
        return json.dumps(self.__dict__)


@dataclass
class TelemetryMessage:
    """Device telemetry."""
    type: str = "telemetry"
    battery: Optional[int] = None
    charging: Optional[bool] = None
    volume: Optional[int] = None
    wifi_rssi: Optional[int] = None
    firmware_version: Optional[str] = None
    ts: int = 0

    def to_json(self) -> str:
        data = {k: v for k, v in self.__dict__.items() if v is not None}
        return json.dumps(data)


# Server message types (for parsing)

@dataclass
class TtsStartMessage:
    """Start of TTS audio stream."""
    type: str = "tts_start"
    format: str = "pcm"
    bytes: Optional[int] = None
    sequence: Optional[int] = None
    sample_rate: Optional[int] = None
    channels: Optional[int] = None


@dataclass
class TtsEndMessage:
    """End of TTS audio stream."""
    type: str = "tts_end"


@dataclass
class TtsAbortedMessage:
    """TTS stream aborted."""
    type: str = "tts_aborted"


@dataclass
class TurnEndMessage:
    """Turn completed."""
    type: str = "turn_end"
    expects_reply: bool = False


@dataclass
class UiStateMessage:
    """UI state update."""
    type: str = "ui_state"
    state: str = ""
    speech_mode: str = ""
    caption: Optional[str] = None
    focus_remaining_sec: Optional[int] = None
    focus_started_at: Optional[int] = None
    focus_ends_at: Optional[int] = None
    emotion: Optional[str] = None
    accent_color: Optional[str] = None


@dataclass
class ConfirmRequestMessage:
    """Request for tool confirmation."""
    type: str = "confirm_request"
    id: str = ""
    summary: str = ""
    expires_at: int = 0


@dataclass
class ErrorMessage:
    """Error from server."""
    type: str = "error"
    code: str = ""
    message: str = ""


def parse_server_message(data: str | bytes) -> Optional[Any]:
    """Parse a server message from JSON."""
    if isinstance(data, bytes):
        data = data.decode('utf-8')
    try:
        msg = json.loads(data)
        msg_type = msg.get('type')
        
        if msg_type == ServerMessageType.TTS_START:
            return TtsStartMessage(**msg)
        elif msg_type == ServerMessageType.TTS_END:
            return TtsEndMessage(**msg)
        elif msg_type == ServerMessageType.TTS_ABORTED:
            return TtsAbortedMessage(**msg)
        elif msg_type == ServerMessageType.TURN_END:
            return TurnEndMessage(**msg)
        elif msg_type == ServerMessageType.UI_STATE:
            return UiStateMessage(**msg)
        elif msg_type == ServerMessageType.CONFIRM_REQUEST:
            return ConfirmRequestMessage(**msg)
        elif msg_type == ServerMessageType.ERROR:
            return ErrorMessage(**msg)
        else:
            return msg
    except Exception:
        return None