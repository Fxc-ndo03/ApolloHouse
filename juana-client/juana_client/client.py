"""Main Juana client for connecting to Apollo."""

import asyncio
import json
import os
import time
import uuid
from typing import Optional, Callable, Any
from dataclasses import dataclass
from enum import Enum

import websockets
from websockets.client import WebSocketClientProtocol

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
    ServerMessageType,
)
from .audio import AudioCapture, AudioPlayback
from .wake import create_wake_detector, VoskWakeWordDetector, ManualWakeWordDetector


class ConnectionState(Enum):
    """WebSocket connection state."""
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    AUTHENTICATED = "authenticated"
    ERROR = "error"


@dataclass
class JuanaConfig:
    """Configuration for Juana client."""
    worker_url: str = "wss://apollo.facupapollo.workers.dev"
    device_id: str = "juana-client"
    device_shared_secret: str = ""
    sample_rate_capture: int = 16000
    sample_rate_playback: int = 24000
    chunk_size_capture: int = 512
    chunk_size_playback: int = 1024
    auto_reconnect: bool = True
    reconnect_interval: float = 5.0
    # Wake word settings
    wake_words: list[str] = None
    wake_model_dir: str = None
    use_vosk_wake: bool = True


class JuanaClient:
    """Client for connecting to Apollo (Juana) via WebSocket."""
    
    def __init__(self, config: Optional[JuanaConfig] = None):
        self.config = config or JuanaConfig()
        if self.config.wake_words is None:
            self.config.wake_words = ["juana", "hey juana"]
        self._ws: Optional[WebSocketClientProtocol] = None
        self._state = ConnectionState.DISCONNECTED
        self._running = False
        self._receive_task: Optional[asyncio.Task] = None
        self._audio_capture: Optional[AudioCapture] = None
        self._audio_playback: Optional[AudioPlayback] = None
        self._wake_detector: Optional[VoskWakeWordDetector | ManualWakeWordDetector] = None
        self._audio_buffer = bytearray()
        self._tts_sequence: Optional[int] = None
        self._tts_expected_bytes: Optional[int] = None
        self._tts_received_bytes = 0
        self._holding = False
        
        # Callbacks
        self.on_state_change: Optional[Callable[[ConnectionState], None]] = None
        self.on_ui_state: Optional[Callable[[UiStateMessage], None]] = None
        self.on_transcript: Optional[Callable[[str], None]] = None
        self.on_confirm_request: Optional[Callable[[ConfirmRequestMessage], None]] = None
        self.on_error: Optional[Callable[[ErrorMessage], None]] = None
        self.on_turn_end: Optional[Callable[[bool], None]] = None
        self.on_audio_start: Optional[Callable[[], None]] = None
        self.on_audio_end: Optional[Callable[[], None]] = None
        self.on_wake_detected: Optional[Callable[[str], None]] = None

    @property
    def state(self) -> ConnectionState:
        return self._state

    @property
    def is_connected(self) -> bool:
        return self._state in (ConnectionState.CONNECTED, ConnectionState.AUTHENTICATED)

    def _set_state(self, state: ConnectionState) -> None:
        self._state = state
        if self.on_state_change:
            self.on_state_change(state)

    async def connect(self) -> None:
        """Connect to the Apollo worker."""
        if self._running:
            return
        
        self._set_state(ConnectionState.CONNECTING)
        self._running = True
        
        # Build WebSocket URL with token
        url = f"{self.config.worker_url}?token={self.config.device_shared_secret}"
        
        try:
            self._ws = await websockets.connect(
                url,
                ping_interval=20,
                ping_timeout=10,
                close_timeout=5,
            )
            self._set_state(ConnectionState.CONNECTED)
            
            # Send hello
            hello = HelloMessage(hostname=self.config.device_id, ts=int(time.time() * 1000))
            await self._ws.send(hello.to_json())
            
            # Start receive loop
            self._receive_task = asyncio.create_task(self._receive_loop())
            
            # Initialize audio
            self._audio_capture = AudioCapture(
                sample_rate=self.config.sample_rate_capture,
                chunk_size=self.config.chunk_size_capture,
            )
            self._audio_playback = AudioPlayback(
                sample_rate=self.config.sample_rate_playback,
                chunk_size=self.config.chunk_size_playback,
                on_end=self._on_playback_end,
            )
            self._audio_playback.start()
            
            # Initialize wake word detector
            self._wake_detector = create_wake_detector(
                wake_words=self.config.wake_words,
                model_dir=self.config.wake_model_dir,
                prefer_vosk=self.config.use_vosk_wake,
                on_detected=self._on_wake_detected,
            )
            self._wake_detector.start()
            
            self._set_state(ConnectionState.AUTHENTICATED)
            
        except Exception as e:
            self._set_state(ConnectionState.ERROR)
            raise ConnectionError(f"Failed to connect: {e}")

    async def disconnect(self) -> None:
        """Disconnect from the server."""
        self._running = False
        
        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass
        
        if self._wake_detector:
            self._wake_detector.stop()
            self._wake_detector = None
        
        if self._audio_capture:
            self._audio_capture.stop()
            self._audio_capture = None
        
        if self._audio_playback:
            self._audio_playback.stop()
            self._audio_playback = None
        
        if self._ws:
            await self._ws.close()
            self._ws = None
        
        self._set_state(ConnectionState.DISCONNECTED)

    async def _receive_loop(self) -> None:
        """Main receive loop for server messages."""
        try:
            async for message in self._ws:
                if isinstance(message, bytes):
                    await self._handle_binary(message)
                else:
                    await self._handle_text(message)
        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception as e:
            self._set_state(ConnectionState.ERROR)
            if self.on_error:
                self.on_error(ErrorMessage(code="receive_error", message=str(e)))

    async def _handle_text(self, message: str) -> None:
        """Handle text message from server."""
        parsed = parse_server_message(message)
        
        if parsed is None:
            return
        
        if isinstance(parsed, UiStateMessage):
            if self.on_ui_state:
                self.on_ui_state(parsed)
                
        elif isinstance(parsed, ConfirmRequestMessage):
            if self.on_confirm_request:
                self.on_confirm_request(parsed)
                
        elif isinstance(parsed, TtsStartMessage):
            self._tts_sequence = parsed.sequence
            self._tts_expected_bytes = parsed.bytes
            self._tts_received_bytes = 0
            self._audio_buffer.clear()
            if self.on_audio_start:
                self.on_audio_start()
                
        elif isinstance(parsed, TtsEndMessage):
            if self.on_audio_end:
                self.on_audio_end()
                
        elif isinstance(parsed, TtsAbortedMessage):
            self._audio_buffer.clear()
            if self.on_audio_end:
                self.on_audio_end()
                
        elif isinstance(parsed, TurnEndMessage):
            if self.on_turn_end:
                self.on_turn_end(parsed.expects_reply)
                
        elif isinstance(parsed, ErrorMessage):
            if self.on_error:
                self.on_error(parsed)

    async def _handle_binary(self, data: bytes) -> None:
        """Handle binary audio data from server."""
        # Check if this is a TTS audio chunk
        if self._tts_expected_bytes is not None and self._tts_received_bytes < self._tts_expected_bytes:
            self._audio_buffer.extend(data)
            self._tts_received_bytes += len(data)
            
            # Write to playback
            if self._audio_playback:
                self._audio_playback.write(data)
            
            # Send playback ack periodically
            if self._tts_received_bytes % 48000 == 0:  # Every ~1 second at 24kHz
                await self._send_playback_ack()
        
        # If we've received all expected bytes, send final ack
        if self._tts_expected_bytes is not None and self._tts_received_bytes >= self._tts_expected_bytes:
            await self._send_playback_ack()

    async def _send_playback_ack(self) -> None:
        """Send playback acknowledgment."""
        if self._ws and self._tts_sequence is not None:
            ack = {
                "type": "playback_ack",
                "sequence": self._tts_sequence,
                "playedMilliseconds": int((self._tts_received_bytes / 2) / self.config.sample_rate_playback * 1000),
                "ts": int(time.time() * 1000),
            }
            await self._ws.send(json.dumps(ack))

    def _on_playback_end(self) -> None:
        """Called when playback stream ends."""
        self._tts_sequence = None
        self._tts_expected_bytes = None
        self._tts_received_bytes = 0

    def _on_wake_detected(self, wake_word: str) -> None:
        """Callback when wake word is detected."""
        if self.on_wake_detected:
            self.on_wake_detected(wake_word)
        # Automatically start listening when wake word detected
        self.start_listening()

    def start_listening(self) -> None:
        """Start capturing audio (press-and-hold start)."""
        if not self._audio_capture or self._holding:
            return
        
        self._holding = True
        self._audio_buffer.clear()
        
        # Send hold_start
        asyncio.create_task(self._send_hold_start())
        
        # Start capture
        self._audio_capture.start(self._on_audio_chunk)

    def _on_audio_chunk(self, chunk: bytes) -> None:
        """Callback for captured audio chunk."""
        if self._ws and self._holding:
            asyncio.create_task(self._ws.send(chunk))

    async def _send_hold_start(self) -> None:
        """Send hold_start message."""
        if self._ws:
            msg = HoldStartMessage(ts=int(time.time() * 1000))
            await self._ws.send(msg.to_json())

    def stop_listening(self) -> None:
        """Stop capturing audio (press-and-hold end)."""
        if not self._holding:
            return
        
        self._holding = False
        
        if self._audio_capture:
            self._audio_capture.stop()
        
        # Send audio_end
        asyncio.create_task(self._send_audio_end())

    async def _send_audio_end(self) -> None:
        """Send audio_end message."""
        if self._ws:
            msg = HoldEndMessage(ts=int(time.time() * 1000))
            await self._ws.send(msg.to_json())

    async def send_text(self, text: str) -> None:
        """Send text input instead of voice."""
        if self._ws:
            msg = TextInputMessage(text=text, ts=int(time.time() * 1000))
            await self._ws.send(msg.to_json())

    async def abort(self) -> None:
        """Abort current turn."""
        if self._ws:
            msg = AbortMessage(ts=int(time.time() * 1000))
            await self._ws.send(msg.to_json())
        
        if self._audio_playback:
            self._audio_playback.stop()
            self._audio_playback.start(on_end=self._on_playback_end)

    async def confirm(self, ok: bool) -> None:
        """Confirm or deny a pending tool confirmation."""
        if self._ws:
            msg = ConfirmMessage(ok=ok, ts=int(time.time() * 1000))
            await self._ws.send(msg.to_json())

    async def set_response_output_target(self, target: str) -> None:
        """Set where TTS audio should be routed ('pc' or 'server')."""
        if self._ws:
            msg = SetResponseOutputTargetMessage(target=target, ts=int(time.time() * 1000))
            await self._ws.send(msg.to_json())

    async def send_telemetry(
        self,
        battery: Optional[int] = None,
        charging: Optional[bool] = None,
        volume: Optional[int] = None,
    ) -> None:
        """Send device telemetry."""
        if self._ws:
            msg = TelemetryMessage(
                battery=battery,
                charging=charging,
                volume=volume,
                ts=int(time.time() * 1000),
            )
            await self._ws.send(msg.to_json())


async def main():
    """Example usage."""
    import os
    from dotenv import load_dotenv
    
    load_dotenv()
    
    config = JuanaConfig(
        worker_url=os.getenv("APOLLO_WORKER_URL", "wss://apollo.facupapollo.workers.dev"),
        device_shared_secret=os.getenv("DEVICE_SHARED_SECRET", ""),
    )
    
    client = JuanaClient(config)
    
    def on_state_change(state):
        print(f"State: {state.value}")
    
    def on_ui_state(ui):
        print(f"UI State: {ui.state}, Caption: {ui.caption}")
    
    def on_audio_start():
        print("Audio playback started")
    
    def on_audio_end():
        print("Audio playback ended")
    
    def on_turn_end(expects_reply):
        print(f"Turn ended, expects_reply: {expects_reply}")
    
    client.on_state_change = on_state_change
    client.on_ui_state = on_ui_state
    client.on_audio_start = on_audio_start
    client.on_audio_end = on_audio_end
    client.on_turn_end = on_turn_end
    
    try:
        await client.connect()
        print("Connected!")
        
        # Set output target to PC
        await client.set_response_output_target("pc")
        
        # Keep running
        while client.is_connected:
            await asyncio.sleep(1)
            
    except KeyboardInterrupt:
        print("Interrupted")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())