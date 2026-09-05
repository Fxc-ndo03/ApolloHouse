# Juana Client

Python client for **Apollo (Juana)** - a personal AI agent with a physical body. This client connects to the Apollo Cloudflare Worker via WebSocket for real-time voice interaction.

## Features

- **WebSocket Connection**: Connects to Apollo Durable Object via WebSocket with token authentication
- **Audio Capture**: Captures microphone audio at 16kHz mono (16-bit PCM)
- **Audio Playback**: Plays TTS audio from server at 24kHz mono (16-bit PCM)
- **Press-and-Hold**: Implements the hold_start/hold_end protocol for voice input
- **Wake Word Detection**: Offline wake word detection using Vosk (no external account, no internet required)
- **Text Input**: Alternative text-based interaction
- **Response Routing**: Can route TTS audio to PC (this client) or server (device)
- **Telemetry**: Sends battery, charging, volume status
- **Async/Await**: Fully async using `websockets` and `asyncio`

## Installation

```bash
cd juana-client
pip install -r requirements.txt
# Or with pipx/uv:
pip install -e .
```

### System Dependencies

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get install portaudio19-dev python3-pyaudio
```

**macOS:**
```bash
brew install portaudio
```

**Windows:**
```bash
# Usually works out of the box with pip
pip install pyaudio
```

### Wake Word Models (Vosk)

For wake word detection, you need a Vosk model. Download one of these small models (~40-50 MB):

- **Spanish (recommended for Juana):** `vosk-model-small-es-0.42` 
- **English:** `vosk-model-small-en-us-0.15`

Place the extracted model folder in `juana_client/models/` or set `wake_model_dir` in config.

```bash
# Example: Download Spanish model
mkdir -p juana_client/models
cd juana_client/models
wget https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip
unzip vosk-model-small-es-0.42.zip
```

The client will auto-detect available models, preferring Spanish then English.

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required environment variables:
- `APOLLO_WORKER_URL` - WebSocket URL of your Apollo worker (e.g., `wss://apollo.your-domain.workers.dev`)
- `DEVICE_SHARED_SECRET` - The `DEVICE_SHARED_SECRET` from your Cloudflare Worker secrets

Optional wake word settings (can also be passed to `JuanaConfig`):
- `WAKE_WORDS` - Comma-separated wake words (default: "juana,hey juana")
- `WAKE_MODEL_DIR` - Directory containing Vosk models
- `USE_VOSK_WAKE` - Set to "false" to disable Vosk and use manual fallback

## Usage

### Basic Example with Wake Word

```python
import asyncio
from juana_client import JuanaClient, JuanaConfig

config = JuanaConfig(
    worker_url="wss://apollo.your-domain.workers.dev",
    device_shared_secret="your-secret-here",
    wake_words=["juana", "hey juana"],
    use_vosk_wake=True,
)

client = JuanaClient(config)

# Set up callbacks
client.on_ui_state = lambda ui: print(f"UI: {ui.state} - {ui.caption}")
client.on_audio_start = lambda: print("🔊 Audio started")
client.on_audio_end = lambda: print("🔇 Audio ended")
client.on_turn_end = lambda expects_reply: print(f"Turn ended, expects reply: {expects_reply}")
client.on_wake_detected = lambda word: print(f"🎯 Wake word detected: {word}")

async def main():
    await client.connect()
    
    # Route TTS audio to this PC client
    await client.set_response_output_target("pc")
    
    # Wake word detection runs automatically in background
    # Say "Juana" to start listening
    
    # Keep running
    while client.is_connected:
        await asyncio.sleep(1)
        
    await client.disconnect()

asyncio.run(main())
```

### Manual Wake Word Trigger (Fallback)

```python
import asyncio
from juana_client import JuanaClient, JuanaConfig, ManualWakeWordDetector

config = JuanaConfig(
    worker_url="wss://apollo.your-domain.workers.dev",
    device_shared_secret="your-secret-here",
    use_vosk_wake=False,  # Disable Vosk, use manual
)

client = JuanaClient(config)
# ... callbacks ...

await client.connect()
await client.set_response_output_target("pc")

# Manually trigger wake word (e.g., from a hotkey)
client._wake_detector.trigger("juana")  # Starts listening

await asyncio.sleep(5)
await client.disconnect()
```

### Keyboard-Controlled Example

```python
import asyncio
import sys
import termios
import tty
from juana_client import JuanaClient, JuanaConfig

async def keyboard_control():
    config = JuanaConfig.from_env()
    client = JuanaClient(config)
    
    client.on_ui_state = lambda ui: print(f"\rUI: {ui.state} - {ui.caption or ''}", end="", flush=True)
    client.on_audio_start = lambda: print("\n🔊 Speaking...")
    client.on_audio_end = lambda: print("🔇 Done")
    
    await client.connect()
    await client.set_response_output_target("pc")
    
    print("Press and hold SPACE to talk, 'q' to quit")
    
    # Raw keyboard input
    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        while True:
            ch = sys.stdin.read(1)
            if ch == ' ':
                client.start_listening()
            elif ch == '\x03' or ch == 'q':  # Ctrl-C or q
                break
            else:
                client.stop_listening()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
        await client.disconnect()

asyncio.run(keyboard_control())
```

## Protocol Messages

### Client → Server

| Message | Description |
|---------|-------------|
| `hello` | Initial connection with hostname |
| `hold_start` | Start press-and-hold audio capture |
| `hold_end` | End press-and-hold audio capture |
| `audio_end` | Alternative to hold_end |
| `text_input` | Text-based input |
| `abort` | Abort current turn |
| `confirm` | Confirm/deny tool confirmation |
| `set_response_output_target` | Route TTS to "pc" or "server" |
| `telemetry` | Battery, charging, volume status |
| `playback_ack` | Acknowledge received audio bytes |

### Server → Client

| Message | Description |
|---------|-------------|
| `ui_state` | UI state updates (idle, listening, thinking, speaking, etc.) |
| `tts_start` | TTS stream starting (with byte count, sample rate) |
| `tts_end` | TTS stream ended |
| `tts_aborted` | TTS stream aborted |
| `turn_end` | Turn completed |
| `confirm_request` | Tool confirmation needed |
| `error` | Error from server |
| `play_effect` | Play sound effect (ding, chime, error) |
| `timer` | Timer countdown |
| `alarm_ring` | Alarm ringing |

## Audio Format

- **Capture**: 16kHz, 16-bit PCM, mono, little-endian
- **Playback**: 24kHz, 16-bit PCM, mono, little-endian

## Wake Word Detection (Vosk)

The wake word detector uses **Vosk** (offline speech recognition) with small models (~40 MB):

- **No external account required** - runs entirely offline
- **No API keys** - no Picovoice/Porcupine AccessKey needed
- **Low CPU** - small models run comfortably on x86 netbooks
- **Spanish + English** - supports both languages

### Why Vosk over alternatives?

| Option | Offline | No Account | CPU Usage | Model Size |
|--------|---------|------------|-----------|------------|
| **Vosk** | ✅ | ✅ | Low | ~40 MB |
| openWakeWord | ✅ | ✅ | Medium | ~20 MB |
| Porcupine | ✅ | ❌ (needs key) | Low | ~1 MB |
| Vosk (large) | ✅ | ✅ | High | ~1.5 GB |

Vosk small models provide the best balance for a netbook: they run at ~0.1-0.3x real-time on modern x86 CPUs, which is plenty for wake word spotting.

### Configuration

```python
config = JuanaConfig(
    wake_words=["juana", "hey juana"],  # Words to detect
    wake_model_dir="/path/to/models",   # Optional custom model directory
    use_vosk_wake=True,                 # Enable/disable Vosk
)
```

### Manual Fallback

If Vosk fails to load (no model found), the client automatically falls back to `ManualWakeWordDetector`. You can trigger it programmatically:

```python
# Trigger wake word manually (e.g., from a global hotkey)
client._wake_detector.trigger("juana")
```

## Architecture

```
┌─────────────┐     WebSocket      ┌──────────────────┐
│ Juana Client│◄──────────────────►│ Apollo Worker    │
│ (Python)    │  Audio + Messages  │ (Cloudflare DO)  │
└─────────────┘                    └────────┬─────────┘
                                             │
                                     ┌───────▼───────┐
                                     │ Gemini 3.6    │
                                     │ STT/LLM/TTS   │
                                     └───────────────┘
```

## License

MIT