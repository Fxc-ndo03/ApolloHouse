# ESP32 Firmware Audit Report

## Source of Information

This audit is based on:
- `documentation/runtime/protocol.md` - wire contract between firmware and server
- `documentation/operations/auth.md` - device authentication
- `documentation/operations/deploy.md` - OTA firmware publishing
- `apps/agent/src/protocol/schema.ts` - Zod-validated message schemas
- `apps/agent/src/agents/apollo.ts` - WebSocket handlers for device messages
- `apps/agent/src/voice/` - TTS/STT coding patterns
- `apps/agent/src/ota/` - firmware update logic
- `apps/agent/src/mcp/` - MCP bridge to firmware

---

## 1. Hardware Used by the Firmware

The firmware runs on **ESP32** (specifically referenced as `1.85C` in protocol.md) with these capabilities:

| Capability | Description |
|------------|-------------|
| **Audio Input** | Microphone with VAD (Voice Activity Detection) |
| **Audio Output** | I2S audio interface to DAC → Speaker |
| **Face/Display** | Small LED matrix or display for UI state visualization |
| **Gestures** | Touch capacitive buttons: tap, double-tap, swipe left, swipe right |
| **Telemetry** | Battery level, charging status, WiFi RSSI, firmware version |
| **Connectivity** | WiFi (STA mode), WebSocket client |
| **MCP Server** | Embedded JSON-RPC server for tool calls |
| **OTA** | Firmware update client from R2 bucket |
| **Storage** | Flash for binary storage, SPIFFS/R2 for audio objects |

**Key constraint** (from wav.ts comments): "The ESP32 streams raw little-endian PCM over the websocket: adding a RIFF header on the device would mean buffering the whole utterance before the first frame goes out, so the server wraps the concatenated chunks instead."

---

## 2. Firmware Responsibilities (What the ESP32 Actually Does)

### A. Device → Server Communication
| Message | ESP32 Action |
|---------|-------------|
| `hello` | Send deviceId after WebSocket connect |
| `hold_start` | Initialize audio capture, reset `#audioChunkList`, transition UI to listening |
| `hold_end` | Send recorded audio to server, run turn |
| `wake` | Wake without full hold gesture |
| `audio_end` | VAD-detected end of utterance, send to server |
| `listen_cancel` | Discard buffered audio, cancel turn |
| `gesture` | Tap/swipe/double_tap → server maps to actions |
| `confirm` | Accept/reject pending confirmation on device screen |
| `text_input` | Typed fallback input when STT fails |
| `abort` | Stop speech currently streaming (barge-in) |
| `telemetry` | Battery, charging, volume, WiFi RSSI, firmware version |
| `mcp` | JSON-RPC replies from embedded MCP server |

### B. Server → Device Communication
| Message | ESP32 Action |
|---------|-------------|
| `ui_state` | Update face emotion, speech mode color, focus timer, caption |
| `confirm_request` | Show confirmation screen for tool side effect |
| `confirm_close` | Drop confirm screen (resolved/expired/orphaned) |
| `tts_start` | Begin streaming PCM audio clip |
| `tts_end` | Finish TTS playback, return to idle or open mic |
| `tts_aborted` | TTS was cancelled mid-stream |
| `timer` | Update countdown arc on device face |
| `turn_end` | Determine if mic reopens or returns to idle |
| `error` | Display/log error message |
| `dashboard` | Show clock + weather snapshot |
| `background_result` | Display silent card with summary |
| `reminder` | Show reminder card + play 'ding' earcon |
| `play_effect` | Play pre-burnt sound effect (ding/chime/error/low_battery) |
| `mcp` | Route JSON-RPC calls to hardware tools |

### C. Audio Processing (ESP32)
- **Records** microphone audio as 16 kHz mono 16-bit s16le PCM
- **Buffers** audio chunks in memory until `audio_end` or `hold_end`
- **Streams** raw PCM to server via WebSocket binary frames (ArrayBuffer)
- **Plays** TTS audio received as raw 24 kHz mono 16-bit s16le PCM chunks
- **Plays** sound effects from flash (ding, chime, error, low_battery)
- **VAD** detects silence to determine `audio_end`
- **Queues** audio frames; firmware queues ~6.8s of frames and silently drops overflow

### D. TTS Playback (ESP32)
- Receives `tts_start` with `format: 'pcm'`, `bytes` (total length), optional `sampleRate`/`channels`
- Server streams binary PCM chunks (~8192 bytes each = ~170ms at 24kHz mono)
- Uses `play_effect` for instant earcons (no TTS credits)
- Checks `tts_aborted` if playback was interrupted
- After `tts_end`, device either reopens mic (`expectsReply: true`) or returns to idle

### E. Gesture Handling (ESP32)
- `tap` → toggles dashboard
- `swipe_left` / `swipe_right` → cycle speech mode
- `double_tap` → no-op (historically muted mic, now ignored)

### F. Telemetry (ESP32)
- Reports: battery (0-100%), charging (bool), volume (int), wifiRssi (int), firmwareVersion (string)
- Sends `telemetry` message after channel opens, then every 60 seconds
- Sends immediately on charging edge
- Server keeps latest snapshot in memory, stamps into system prompt (5 min freshness)
- Announces low battery (≤15%, 30-min cooldown, re-armed by charging or recovery to 25%)

### G. OTA Firmware Updates (ESP32)
- Checks for updates at boot, right after time sync
- Failed check: logs and boots normally
- Uses same `?token=` shared secret as WebSocket URL
- Downloads `firmware.bin` from `/ota/firmware.bin?token=<secret>`
- Validates version format: `/^\d+(\.\d+)*$/`
- On version change: announces update out loud ("ahora la cuenta regresiva se ve en el aro")
- Changelog: one Spanish sentence spoken verbatim after update

### H. MCP Bridge (ESP32)
- Embedded JSON-RPC server
- Routes: `self.audio_speaker.set_volume`, `self.screen.set_brightness`, `self.get_device_status`
- Correlation by JSON-RPC `id` (must be integer; device drops string ids)
- Server awaits each call with 5-second timeout
- Timeout/degradation: spoken "no está conectado / no respondió"
- User tools (`self.reboot`, `self.upgrade_firmware`) callable from server but NOT exposed to LLM

### I. Connection & Reconnection (ESP32)
- **Connect**: WebSocket with `?token=DEVICE_SHARED_SECRET`
- **Auth**: `resolveApolloConnectionRole` tries device secret first, then dashboard
- **Tags**: connection tagged with role (`DEVICE_CONNECTION_TAG`)
- **onConnect**: replays desk session state, pushes UI state + dashboard, flushes pending messages
- **onMessage**: only device vocabulary accepted; honoring browser vocab would desync the desk
- **Reconnect**: pending messages consumed on connect; broadcasts deliver on reconnect with sound
- **State persistence**: session prefs, memories, confirmations, list items in SQLite

---

## 3. Apollo Cloud Responsibilities (Backend)

### A. Protocol & Message Handling
- Zod-validated schemas in `apps/agent/src/protocol/schema.ts`
- `parseDeviceToServerMessage()` and `encodeServerToDeviceMessage()` functions
- WebSocket connection management via Cloudflare Workers
- Durable Object `Apollo` holds per-desk session state (SQLite)

### B. Voice Pipeline (STT/LLM/TTS)
- **STT**: `transcribeAudioWithOpenRouter` - Whisper Large V3 via OpenRouter
- **LLM**: `chatWithOpenRouter` - SSE streaming with `onTextDelta`, tool call support
- **TTS**: `synthesizeApolloSpeech` - ElevenLabs with R2 caching (`tts-cache/` by SHA-256)
- **Segmentation**: `splitTextIntoSpeechSegmentList` - max 280 chars per segment
- **Pacing**: `streamAudioChunksAtPlaybackPace` - caps device backlog at 4s

### C. Turn Execution
- `runDeskTurn` in `turn/run.ts` - full turn: STT → LLM → tool execution → TTS
- Max 3 tool rounds per turn
- Minimum 8000 bytes of audio (quarter second at 16kHz)
- `expectsReply` judgment: `[[escucho]]` mark or trailing `?`

### D. State Management
- **Durable Object `Apollo`**: SQLite tables for memories, session_prefs, pending_device_messages, list_items, pending_confirmations, mcp_tool_settings, thread_meta
- **Session Manager**: `createApolloSessionManager` with context blocks (soul, memory, handoff, knowledge, skills)
- **Vectorize**: Semantic memory search via OpenRouter embeddings
- **Queues**: `APOLLO_QUEUE` with batch consumption (max_size: 10, timeout: 5s)
- **Workflows**: `apollo-background`, `apollo-coding` for background jobs

### E. Authentication & Authorization
- **Device**: `DEVICE_SHARED_SECRET` compiled into firmware; rotates via OTA
- **Dashboard**: `DASHBOARD_SHARED_SECRET` in browser tabs
- `resolveApolloConnectionRole` - tries device secret, then dashboard secret
- `getConnectionTags` - re-derives role inside DO from connection request
- `@callable()` methods re-check dashboard secret to prevent token hijacking

### F. MCP & Tools
- **MCP Bridge**: `apps/agent/src/mcp/bridge.ts` - JSON-RPC to firmware tools
- **Built-in tools**: 20+ tools in `tools/catalog.ts` (weather, web_search, memory, timers, reminders, lists, device, email, sandbox, coding, dollar, translate)
- **MCP servers**: External tools connected via OAuth; managed through console
- **Safety**: `toolDefinition.safety` ('safe'/'unsafe') determines if confirmation is needed

### G. OTA Firmware Publishing
- **Manifest**: `firmware/latest.json` in R2 bucket `apollo-media`
- **Binary**: `firmware/apollo-<version>.bin` - the app image (NOT merged binary)
- **Push**: When telemetry reports older version + device idle + powered (charging or ≥50% battery)
- **Limit**: 3 attempts per version, 6h apart
- **Changelog**: Spanish sentence written in `firmware repo`, embedded in `latest.json`
- **OTA endpoints**: `GET|POST /ota/check` and `GET /ota/firmware.bin?token=<secret>`

### H. Initiatives & Automations
- **Daily budget**: 6 utterances per day (Argentina TZ: America/Argentina/Buenos_Aires)
- **Quiet hours**: 22:00-09:00 local time
- **Source cooldown**: 1 hour per initiative source
- **Focus**: `set_focus`/`clear_focus` tools; defers non-critical initiatives during focus
- **Incentive sources**: firmware_changelog, low_battery, curiosity, follow_up, sentinel

### I. Broadcast & Reminders
- **Broadcast text**: `deliverBroadcastText` - chime effect + TTS + reminder card
- **Broadcast audio**: Record owner audio, upload to R2, play on device
- **Reminders**: `set_reminder`, `list_reminders`, `cancel_reminder` - scheduled via `schedule()` 
- **Timers**: `set_timer`, `start_pomodoro` - focus-aware, countdown on device

### J. Console & Dashboard
- **React console**: `@apollo/console` - management dashboard at `/console`
- **MCP management**: Install/configure external tool servers
- **Memory browsing**: Add/delete/reminder memories via console
- **Device status**: View telemetry, connection count, reminders list

---

## 4. Android Responsibilities (Future Implementation)

Based on the project goals and architecture description, the Samsung S5 running LineageOS 14.1 / Android 7.1 would handle:

### A. Hardware Abstraction Layer
| Feature | Android Equivalent |
|---------|-------------------|
| **Microphone** | Android `AudioRecord` API, 16 kHz mono 16-bit PCM |
| **Speaker/Audio Out** | Android `AudioTrack` I2S interface |
| **Face/Display** | Android Canvas/SurfaceView for UI state visualization |
| **Gestures** | Android `onTouchEvent`, `View.onGestureListener` (tap, swipe, double-tap) |
| **Telemetry** | BatteryManager, WiFi info, sensor listeners |
| **Connectivity** | WebSocket client (same protocol) |
| **Flash Storage** | Android Preferences / Raw storage for firmware, audio objects |

### B. Protocol Implementation
- **Exact same WebSocket protocol** as ESP32: `deviceToServerMessageSchema` + `serverToDeviceMessageSchema`
- **Binary audio frames**: `ArrayBuffer` via WebSocket (same as current ESP32)
- **Messages**: `hello`, `hold_start`, `hold_end`, `wake`, `audio_end`, `listen_cancel`, `gesture`, `confirm`, `text_input`, `abort`, `telemetry`, `mcp`, `playback_ack`
- **Server messages**: `ui_state`, `confirm_request`, `confirm_close`, `tts_start`/`tts_end`/`tts_aborted`, `timer`, `turn_end`, `error`, `dashboard`, `background_result`, `reminder`, `play_effect`, `mcp`

### C. Wake Word Local
- Android `SpeechRecognizer` or dedicated wake word engine (e.g., Porcupene, Hey Google SDK)
- On detection: send `wake` message via WebSocket
- Or: `hold_start` for push-to-talk

### D. UI/Cara
- Render face emotion, speech mode accent color
- Show focus timer arc
- Display dashboard (clock + weather)
- Show confirmation screens
- Play sound effects
- Display reminder cards

### E. Touch/Gestures
- Same gesture mapping as firmware: tap→dashboard, swipe→speech mode, double_tap→no-op
- Handle `confirm` answers from touch screen
- Handle `text_input` via on-screen keyboard

### F. Local State
- Boot automático
- Reconexión WebSocket
- Sleep/wake cycles
- Controles locales del teléfono (volumen, etc.)

---

## 5. Comparison Table

| ESP32 Feature | Android Equivalent | Backend Equivalent | Not Needed |
|--------------|-------------------|-------------------|------------|
| Microphone @ 16kHz s16le | Android AudioRecord 16kHz mono | STT via OpenRouter Whisper | — |
| Speaker I2S @ 24kHz s16le | Android AudioTrack 24kHz mono | TTS via ElevenLabs | — |
| Face LED matrix display | Android Canvas/SurfaceView UI | ui_state → face emotion/accentColor | — |
| Gestures: tap/swipe/double_tap | Android onTouch/dispatchTouchEvent | Same gesture mapping | — |
| Telemetry: battery/charging/vol/WiFi | Android BatteryManager + WiFi APIs | telemetry → system prompt | — |
| WebSocket client | Android OkHttp/WebSocket same protocol | Same protocol handler | — |
| OTA firmware updates | Android Settings/system update | Same OTA endpoints + R2 publishing | — |
| Embedded MCP server | Android AIDL/Service RPC | Same MCP bridge + JSON-RPC | — |
| Sound effects from flash | Android SoundPool / MediaPlayer | Same play_effect calls | — |
| VAD for audio_end | Android SpeechRecognizer VAD | Same audio_end message | — |
| 30s broadcast audio upload | Android same workflow | Same broadcast logic (base64 chunks) | — |
| SQLite state persistence | Android Room / SQLiteAsset | Same Durable Object SQLite | — |
| Wake word local | Android Porcupene/SpeechRecognizer | Same wake/hold_start messages | — |
| Touch confirm screen | Android AlertDialog / Touch handling | Same confirm_request/confirm_close | — |
| TTS pacing & segmentation | Android same streaming | Same segment.ts split + stream.pace | — |
| Low battery announcement ≤15% | Android same logic | Same telemetry + critical announce | — |
| Quiet hours 22:00-09:00 | Android same policy | Same initiative logic (timezone-aware) | — |
| Daily utterance budget 6/day | Android same policy | Same initiative daily budget | — |
| Connection tags / role-based auth | Android same WebSocket auth | Same DEVICE_SHARED_SECRET auth | — |
| Pending message flush on reconnect | Android same WebSocket handling | Same consumePendingDeviceMessages | — |
| Dashboard clock + weather | Android same UI components | Same dashboard payload | — |
| `[[escucho]]` mark for replies | Android same text processing | Same turn_end expectsReply logic | — |
| `play_effect` instant earcons | Android same sound pool | Same play_effect names (ding/chime/error/low_battery) | — |

---

## Summary of Responsibility Split

| Area | ESP32 Firmware | Apollo Cloud (Backend) | Android Body |
|------|---------------|----------------------|--------------|
| **Audio Capture** | ✅ Records PCM, buffers, sends via WebSocket | ⚠️ STT transcription, LLM reasoning | ⚠️ AudioRecord interface |
| **Audio Playback** | ✅ Receives PCM chunks, plays via I2S | ✅ ElevenLabs TTS synthesis, caching | ✅ AudioTrack interface |
| **Voice Pipeline** | ⚠️ VAD, wake word detection | ✅ Full STT/LLM/TTS pipeline | ⚠️ Local wake word engine |
| **UI State** | ✅ Renders face, focus arc on device | ✅ Computes ui_state from turn outcomes | ✅ Renders on phone screen |
| **Gestures** | ✅ Tap/swipe/double_tap hardware | ✅ Maps gestures to actions | ✅ Touch screen events |
| **Telemetry** | ✅ Reports battery/charging/vol/WiFi/FW | ✅ Uses in system prompt, low batt ann | ✅ Reads same sensors |
| **Firmware OTA** | ✅ Checks at boot, downloads from R2 | ✅ Publishes to R2, manages manifest | ❌ Not needed (phone has system updates) |
| **MCP Bridge** | ✅ Embedded JSON-RPC server | ✅ Routes tool calls, manages servers | ⚠️ Could be phone-side RPC |
| **Authentication** | ✅ `DEVICE_SHARED_SECRET` in firmware | ✅ Auth + role derivation | ✅ Same secret compiled/configured |
| **Wake Word** | ❌ (or `hold_start`/`wake` user gesture) | ✅ LLM pipeline after STT | ✅ Local wake word detector |
| **Confirmations** | ✅ Shows screen, sends `confirm` | ✅ Logic + `confirm_request` | ✅ Touch screen confirms |
| **Timers/Reminders** | ✅ Countdown arc, `ding` earcon | ✅ Scheduling, `schedule()` calls | ✅ Same UI patterns |
| **Broadcast Audio** | ⚠️ Records + uploads to R2 | ✅ Same base64 chunk upload workflow | ✅ Same R2 upload flow |
| **Session State** | ✅ SQLite locally | ✅ Durable Object SQLite + Vectorize | ✅ Android SQLite/Room |
| **WebSocket** | ✅ Client connecting to Worker | ✅ Worker + Durable Objects | ✅ Client connecting to same Worker |

**Key Insight**: The ESP32 and future Android body share nearly identical protocol and hardware responsibilities (audio I/O, gestures, telemetry, basic UI). The major difference is that the ESP32 has an **embedded MCP server** for tool control, while the Android body would typically rely on the Cloud backend for LLM/STT/TTS processing, with the phone handling the I/O front-end.

The Cloud backend remains the "brain" regardless of whether the body is ESP32 or Android, as specified in the project goals: "El teléfono NO debe convertirse en el cerebro de Apollo."