# Protocol Audit Report - Apollo Firmware Communication

## Comparative Analysis: A) Real Implemented vs B) Documented vs C) Future Android

### Legend
- **A) Real Implemented**: What the current Cloudflare Worker code actually does
- **B) Documented**: What `documentation/runtime/protocol.md` says
- **C) Future Android**: What the Samsung S5/LineageOS Android implementation should match

---

## Message Protocol Comparison Table

| Message | Direction | Schema (A Real) | Required Fields (A) | Optional Fields (A) | Handler (A Real) | Effect (A Real) |
|---------|-----------|-----------------|---------------------|--------------------|------------------|-----------------|
| **hello** | Device → Server | `deviceToServerMessageSchema.discriminatedUnion` | `type`=`'hello'`, `deviceId` (string min 1), `ts` (int >=0) | None | `onConnect` → `#pushUiState` | Sends initial UI state to new device |
| **hold_start** | Device → Server | `deviceToServerMessageSchema.discriminatedUnion` | `type`=`'hold_start'`, `ts` (int >=0) | None | `onMessage` → `#audioChunkList = []`, `#applyUiEvent('START_LISTEN')` | Starts audio capture, resets UI to listening |
| **hold_end** | Device → Server | `deviceToServerMessageSchema.discriminatedUnion` | `type`=`'hold_end'`, `ts` (int >=0) | None | `onMessage` → `#runTurnFromAudio(connection)` | Ends audio capture, runs turn from recorded audio |
| **wake** | Device → Server | `deviceToServerMessageSchema.discriminatedUnion` | `type`=`'wake'`, `ts` (int >=0) | None | `onMessage` → `#audioChunkList = []`, `#applyUiEvent('START_LISTEN')` | Wakes device without full hold gesture |
| **audio_end** | Device → Server | `deviceToServerMessageSchema.discriminatedUnion` | `type`=`'audio_end'`, `ts` (int >=0) | None | `onMessage` → `#runTurnFromAudio(connection)` | VAD-detected end of wake-word utterance |
| **listen_cancel** | Device → Server | `deviceToServerMessageSchema.discriminatedUnion` | `type`=`'listen_cancel'`, `ts` (int >=0) | None | `onMessage` → `#audioChunkList = []`, `#applyUiEvent('CANCEL')` | User cancelled open listen session, discard buffered audio |
| **gesture** | Device → Server | `deviceToServerMessageSchema.discriminatedUnion` | `type`=`'gesture'`, `gesture` (enum: tap/double_tap/swipe_left/swipe_right), `ts` | None | `onMessage` → `#handleGesture(connection, gesture)` | Server maps: tap→dashboard, swipe→speech mode, double_tap→no-op |
| **confirm** | Device → Server | `deviceToServerMessageSchema.discriminatedUnion` | `type`=`'confirm'`, `ok` (boolean), `ts` | None | `onMessage` → `#resolveConfirm(connection, ok)` | Resolves pending tool confirmation on device |
| **text_input** | Device → Server | `deviceToServerMessageSchema.discriminatedUnion` | `type`=`'text_input'`, `text` (string min 1), `ts` | None | `onMessage` → `#runTurnFromText(connection, text)` | Typed fallback input when STT fails |
| **abort** | Device → Server | `deviceToServerMessageSchema.discriminatedUnion` | `type`=`'abort'`, `ts` (int >=0) | None | `onMessage` → `#isSpeechAborted = true` | Sets abort flag; paced TTS loop checks between chunks |
| **telemetry** | Device → Server | `deviceToServerMessageSchema.discriminatedUnion` | `type`=`'telemetry'`, `ts` (int >=0) | `battery` (0-100 int), `charging` (bool), `volume` (int), `wifiRssi` (int), `firmwareVersion` (string) | None | Sends battery/charging/volume/WFi/firmware to keep system prompt fresh |
| **mcp** | Device → Server | `deviceToServerMessageSchema.discriminatedUnion` | `type`=`'mcp'`, `payload.jsonrpc`=`'2.0'`, `payload.id` (int), `payload.result`/`payload.error` (optional) | `payload.params` (record), `ts` | `#deviceMcpRequestRegistry.resolvePendingRequest` | Bridges JSON-RPC to firmware MCP server; integer ids only |
| **playback_ack** | Device → Server | `deviceToServerMessageSchema.discriminatedUnion` | `type`=`'playback_ack'`, `sequence` (int >=0), `playedMilliseconds` (int >=0), `ts` (int >=0) | None | `#lastPlaybackAck = {sequence, playedMilliseconds, receivedAtMilliseconds}` | Used by server to pace TTS streaming and estimate device backlog |

### Server → Device Messages

| Message | Direction | Schema (A Real) | Required Fields (A) | Optional Fields (A) | Handler (A Real) | Effect (A Real) |
|---------|-----------|-----------------|---------------------|--------------------|------------------|-----------------|
| **ui_state** | Server → Device | `serverToDeviceMessageSchema.discriminatedUnion` | `type`=`'ui_state'`, `state` (enum: idle/listening/thinking/confirm/speaking/focus/dashboard), `speechMode` (string min 1) | `caption`, `focusRemainingSec`, `focusStartedAt`, `emotion` (enum), `accentColor` (string) | `#pushUiState(connection)` | Updates device face emotion, speech mode color, focus timer |
| **confirm_request** | Server → Device | `serverToDeviceMessageSchema.discriminatedUnion` | `type`=`'confirm_request'`, `id` (string min 1), `summary` (string min 1), `expiresAt` (int >=0) | None | `#resolveConfirm` shows confirmation screen on device | Device shows approval screen for tool side effect |
| **confirm_close** | Server → Device | `serverToDeviceMessageSchema.discriminatedUnion` | `type`=`'confirm_close'`, `id` (string min 1), `reason` (enum: resolved/expired/orphaned) | None | `#closePendingConfirmation` | Device drops confirm screen; reason determines behavior |
| **tts_start** | Server → Device | `serverToDeviceMessageSchema.discriminatedUnion` | `type`=`'tts_start'`, `format` (enum: mp3/wav/pcm), `bytes` (int >=0) | `sequence`, `sampleRate` (int >0), `channels` (int >0) | Streams PCM audio chunks via `connection.send()` | Announces next speech clip; `bytes` tells device when to stop expecting more |
| **tts_end** | Server → Device | `serverToDeviceMessageSchema.discriminatedUnion` | `type`=`'tts_end'` | None | After TTS finishes streaming, sends `turn_end` with `expectsReply` | Marks end of TTS playback; device returns to idle or opens mic |
| **tts_aborted** | Server → Device | `serverToDeviceMessageSchema.discriminatedUnion` | `type`=`'tts_aborted'` | None | After abort flag set, signals cancellation | Device stops waiting for audio that was cancelled; wasAborted check in runtime |
| **timer** | Server → Device | `serverToDeviceMessageSchema.discriminatedUnion` | `type`=`'timer'`, `endsAt` (int >=0, epoch seconds) | `durationSeconds` (int >0) | Updates device focus arc display | Shows countdown timer on device face |
| **turn_end** | Server → Device | `serverToDeviceMessageSchema.discriminatedUnion` | `type`=`'turn_end'`, `expectsReply` (boolean) | None | `#isSpeechAborted` check + `expectsReply` value | Determines if device reopens mic after turn or returns to idle |
| **error** | Server → Device | `serverToDeviceMessageSchema.discriminatedUnion` | `type`=`'error'`, `code` (string min 1), `message` (string min 1) | None | Logs error, may speak spoken error | Device may announce error to user |
| **dashboard** | Server → Device | `serverToDeviceMessageSchema.discriminatedUnion` | `type`=`'dashboard'`, `clock` (timezone + isoNow), `weather` (locationLabel, tempC, conditionLabel, updatedAt) | None | `#pushDashboard(connection)` | Shows clock + weather snapshot on device dashboard |
| **background_result** | Server → Device | `serverToDeviceMessageSchema.discriminatedUnion` | `type`=`'background_result'`, `summary` (string min 1), `prompt` (string min 1), `documentKey` (string min 1) | None | Delivers non-interactive results to device | Silent card on device; may have accompanying chime sound effect |
| **reminder** | Server → Device | `serverToDeviceMessageSchema.discriminatedUnion` | `type`=`'reminder'`, `message` (string min 1) | None | `#broadcastDeskDeviceNotification` | Shows reminder card on device; accompanied by 'ding' earcon |
| **play_effect** | Server → Device | `serverToDeviceMessageSchema.discriminatedUnion` | `type`=`'play_effect'`, `name` (enum: ding/chime/error/low_battery) | None | `#broadcastPlayEffect(name)` | Plays pre-burnt sound effect on firmware; instant latency vs TTS |
| **mcp** | Server → Device | `serverToDeviceMessageSchema.discriminatedUnion` | `type`=`'mcp'`, `payload.jsonrpc`=`'2.0'`, `payload.id` (int), `payload.method` (string min 1), `payload.params` (record) | None | Routes to firmware's embedded `McpServer` | JSON-RPC calls to device tools (volume, brightness, get_status, etc.) |

---

## Audio Transmission Analysis

### 1. How a Recording Starts
- **Real (A)**: User performs hold gesture or says wake word → device sends `hold_start` or `wake` message via WebSocket
- **Documented (B)**: Same - `hold_start`/`hold_end` for push-to-talk, `wake` for wake-word
- **Future Android (C)**: Same mechanism - the Android app would send these same messages

**Code flow** (`apps/agent/src/agents/apollo.ts:626-634`):
```typescript
case 'hold_start':
case 'wake': {
  this.#audioChunkList = [];  // Clear previous audio chunks
  this.#applyUiEvent('START_LISTEN');  // Transition UI to listening state
  this.setState({ ...this.state, caption: null });  // Clear stale caption
  this.#pushUiState(connection);  // Send ui_state to device
  break;
}
```

### 2. How a Recording Ends
- **Real (A)**: Either `audio_end` (VAD detects silence/timeout) or `hold_end` (user lifts finger) → both call `#runTurnFromAudio(connection)`
- **Documented (B)**: Same - "A listen session ends with the event matching how it started: `hold_end` when a finger lifts, `audio_end` when a wake-word turn hits its VAD timeout"
- **Future Android (C)**: Same - the Android app's firmware would send either message

**Code flow** (`apps/agent/src/agents/apollo.ts:636-643`):
```typescript
case 'hold_end': {
  await this.#runTurnFromAudio(connection);
  break;
}
case 'audio_end': {
  await this.#runTurnFromAudio(connection);
  break;
}
```

### 3. How Audio is Sent (Device → Server)
- **Real (A)**: Raw PCM audio chunks sent as **binary WebSocket frames (ArrayBuffer)**, NOT JSON, NOT base64
- **Documented (B)**: "Binary audio rides alongside; control messages stay structured and small for the ESP32." (protocol.md line 3)
- **Future Android (C)**: Must use binary WebSocket frames matching the PCM format

**Code flow** (`apps/agent/src/agents/apollo.ts:587-598`):
```typescript
if (message instanceof ArrayBuffer) {
  this.#audioChunkList.push(message);
  return;
}
if (ArrayBuffer.isView(message)) {
  // Handle Uint8Array views
  const audioChunkBuffer = new ArrayBuffer(message.byteLength);
  new Uint8Array(audioChunkBuffer).set(
    new Uint8Array(message.buffer, message.byteOffset, message.byteLength),
  );
  this.#audioChunkList.push(audioChunkBuffer);
  return;
}
```

### 4. Audio Transport Mechanism
- **Is it JSON?** ❌ No. Control messages are JSON, but audio is binary
- **Is it base64?** ❌ No. The broadcast upload path uses base64 (separate feature), but live audio does not
- **Is it binary WebSocket frames?** ✅ Yes. Audio arrives as `ArrayBuffer` via WebSocket
- **Other mechanism?** ❌ No other mechanism for live audio

### 5. Exact Audio Format

#### Device Microphone → Server (STT)
- **Sample Rate**: 16 kHz
- **Bit Depth**: 16 bits per sample
- **Channels**: 1 (mono)
- **Encoding**: `s16le` (signed 16-bit little-endian)
- **Format**: Raw PCM (no WAV header in transit; WAV header added only if `wrapPcmAsWavBuffer` is called, which is for caching/embedding)

**Code evidence** (`apps/agent/src/voice/wav.ts:5-7`):
```typescript
export const DEVICE_MIC_PCM_SAMPLE_RATE_HZ = 16000;
export const DEVICE_MIC_PCM_CHANNEL_COUNT = 1;
export const DEVICE_MIC_PCM_BITS_PER_SAMPLE = 16;
```

#### Server → Device TTS
- **Sample Rate**: 24 kHz
- **Bit Depth**: 16 bits per sample
- **Channels**: 1 (mono)
- **Encoding**: `s16le` (signed 16-bit little-endian)
- **Format**: Raw PCM frames, no WAV header per chunk

**Code evidence** (`apps/agent/src/voice/elevenlabs.ts:5-6`):
```typescript
export const TTS_PCM_SAMPLE_RATE_HZ = 24000;
export const TTS_PCM_CHANNEL_COUNT = 1;
```

**Code evidence** (`apps/agent/src/voice/wav.ts:9-11`):
```typescript
// TTS is sent as a run of small binary frames instead of one blob so the device
// can start playing on the first frame: `tts_start.bytes` tells it when to stop
// expecting more. Roughly 170 ms of 24 kHz mono audio per frame.
export const TTS_STREAM_CHUNK_BYTE_LENGTH = 8192;
```

### 6. Chunk Sizes

#### TTS Streaming Chunks
- **Size**: 8192 bytes per chunk (from `wav.ts:12`)
- **Duration**: ~170 ms of 24 kHz mono 16-bit audio
- **Calculation**: `8192 bytes / (24000 samples/s × 2 bytes/sample × 1 channel) = 0.1707 seconds`

#### Device Microphone Chunks
- No fixed chunk size; chunks accumulate in `#audioChunkList` until `audio_end` or `hold_end`
- The only minimum is `MINIMUM_TURN_AUDIO_BYTE_LENGTH = 8000` quarters-of-second at 16 kHz (from `apollo.ts:241`)

### 7. Streaming Support
- **Real (A)**: ✅ Yes, full duplex streaming
- **Documented (B)**: ✅ Yes - "Binary audio rides alongside"
- **Future Android (C)**: ✅ Required

**TTS streaming flow** (`apps/agent/src/agents/runtime.ts:333-341`):
```typescript
await streamAudioChunksAtPlaybackPace({
  audioBuffer: currentAudioBuffer,
  sampleRateHz: TTS_PCM_SAMPLE_RATE_HZ,
  channelCount: TTS_PCM_CHANNEL_COUNT,
  send: (audioChunk) => {
    connection.send(audioChunk);  // Send binary frame via WebSocket
  },
  // ... pacing options
});
```

### 8. `audio_end` Message
- **What it indicates**: End of wake-word utterance (VAD-detected silence)
- **Where handled**: `apps/agent/src/agents/apollo.ts:640-643`
- **What happens**: Calls `#runTurnFromAudio(connection)` which processes accumulated audio chunks through STT
- **Relationship to `hold_end`**: Both end the listen session; the split allows server to diverge behavior (timeouts, continuity) without flashing firmware

### 9. What Happens with `abort`
- **Real (A)**: Device sends `abort` → agent sets `#isSpeechAborted = true` flag → paced TTS loop checks `shouldStop` between chunks → stops sending within one chunk → server sends `tts_aborted`
- **Documented (B)**: "Step 3 matters because `tts_start` promises a byte count and the device counts against it to know when a clip ends. After an abort that total never arrives, so without `tts_aborted` the device would wait forever for speech that was cancelled."
- **Future Android (C)**: Same abort flow - the Android app must handle `tts_aborted` after device `abort`

**Code flow** (`apps/agent/src/agents/apollo.ts:654-659`):
```typescript
case 'abort': {
  // Only a flag: the paced TTS loop is awaiting between chunks, so it
  // picks this up on its next turn and stops sending.
  this.#isSpeechAborted = true;
  break;
}
```

And in `runtime.ts:343-346`:
```typescript
if (dependencies.isSpeechAborted?.() === true) {
  wasAborted = true;
  break;
}
```

### 10. How TTS is Received (Device)
- **Real (A)**: Server sends `tts_start` message → device starts streaming binary PCM frames → `#streamAudioChunksAtPlaybackPace` paces delivery → `tts_end` or `tts_aborted` marks completion
- **Documented (B)**: "tts_start carries format (always pcm in production), bytes for the clip that follows, and optional sampleRate/channels — 24000 Hz mono, so the ESP32 needs no decoder. The binary frames that follow belong to the clip just announced."
- **Future Android (C)**: Must receive `tts_start` with format='pcm', then receive binary PCM frames at the specified rate

### 11. Exact TTS Format
- **Format**: Raw `s16le` (signed 16-bit little-endian) PCM
- **Sample Rate**: 24000 Hz
- **Channels**: 1 (mono)
- **Bit Depth**: 16 bits
- **Endian**: Little-endian
- **Header**: None per chunk - `tts_start.bytes` tells total length; firmware may wrap entire clip in RIFF-WAV

**Code evidence** (`apps/agent/src/voice/elevenlabs.ts:2`):
```typescript
// The desk device plays TTS straight out of I2S, so the server asks ElevenLabs
// for raw PCM instead of mp3: no decoder has to run on the ESP32. pcm_24000 is
// headerless s16le mono, exactly what the firmware expects.
```

**Code evidence** (`apps/agent/src/voice/wav.ts:3-4`):
```typescript
// The ESP32 streams raw little-endian PCM over the websocket: adding a RIFF
// header on the device would mean buffering the whole utterance before the
// first frame goes out, so the server wraps the concatenated chunks instead.
```

### 12. How `tts_start` is Indicated
- **Real (A)**: Server sends message `{ type: 'tts_start', format: 'pcm', bytes: <total>, sampleRate?, channels? }` → device starts streaming audio chunks
- **Documented (B)**: "`tts_start` carries `format` (always `pcm` in production), `bytes` for the clip that follows, and optional `sampleRate` / `channels` — 24 000 Hz mono, so the ESP32 needs no decoder. The binary frames that follow belong to the clip just announced."
- **Code** (`apps/agent/src/protocol/schema.ts:146-154`):
```typescript
z.object({
  type: z.literal('tts_start'),
  format: z.enum(['mp3', 'wav', 'pcm']),
  // Optional since tts_end closes runs; firmware before 2.7.0 treats a
  // missing total as an empty run, so keep sending it whenever it is known.
  bytes: z.number().int().nonnegative().optional(),
  sequence: z.number().int().nonnegative().optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
}),
```

### 13. How `tts_end` is Indicated
- **Real (A)**: Server sends `{ type: 'tts_end' }` → device stops audio playback → `turn_end` sent with `expectsReply` value
- **Documented (B)**: "`tts_end` — The turn's speech is fully sent; `expectsReply` says whether the device should reopen the mic after playback or return to idle"
- **Code** (`apps/agent/src/protocol/schema.ts:156-158`):
```typescript
z.object({
  type: z.literal('tts_end'),
}),
```

### 14. TTS Interruption
- **Real (A)**: 
  1. Device sends `abort` (e.g., tap while speaking)
  2. Agent sets `#isSpeechAborted = true` flag
  3. Paced TTS loop checks `shouldStop` between chunks → stops sending within one chunk
  4. Server sends `tts_aborted` → device knows total never arrived, stops waiting
- **Documented (B)**: "abort and tts_aborted are the two halves of barge-in: 1. The device sends abort (today: a tap while Apollo is speaking) 2. The server sets a flag; the paced TTS loop checks it between chunks and stops sending 3. The server sends tts_aborted. Step 3 matters because tts_start promised a byte count the device is counting against — without it the device waits forever for speech that was cancelled."
- **Consequences**: Abort ends the *whole* reply, not just current segment. New turn always clears the flag.

### 15. How `playback_ack` Works
- **Real (A)**: Device sends `{ type: 'playback_ack', sequence: number, playedMilliseconds: number, ts: number }` roughly once per second → server uses it to estimate backlog and pace TTS streaming
- **Documented (B)**: "Acks arrive about once a second; between them the estimate assumes playback kept running, capped at what was delivered so a stale ack can never claim more was played than was sent. With acks the backlog is measured instead of modeled; without them the open-loop pace factor stays in charge (firmware before 2.7.0 sends none)."
- **Code flow** (`apps/agent/src/agents/apollo.ts:676-682`):
```typescript
case 'playback_ack': {
  this.#lastPlaybackAck = {
    sequence: deviceMessage.sequence,
    playedMilliseconds: deviceMessage.playedMilliseconds,
    receivedAtMilliseconds: Date.now(),
  };
  break;
}
```

**Pacing algorithm** (`apps/agent/src/voice/stream.ts:103-123`):
```typescript
if (playbackAck !== null) {
  const backlogAfterSendMilliseconds =
    deliveredMilliseconds +
    chunkMilliseconds -
    estimatePlayedMilliseconds(playbackAck, deliveredMilliseconds, now());
  const waitMilliseconds =
    backlogAfterSendMilliseconds - TTS_STREAM_MAX_BACKLOG_MILLISECONDS;
  if (waitMilliseconds > 0) {
    await wait(waitMilliseconds);
  }
} else {
  // Open-loop pacing without acks
  const backlogAfterSendMilliseconds =
    deliveredMilliseconds + chunkMilliseconds - waitedMilliseconds;
  const waitMilliseconds = Math.max(
    chunkMilliseconds * TTS_STREAM_PACE_FACTOR,
    backlogAfterSendMilliseconds - TTS_STREAM_MAX_BACKLOG_MILLISECONDS,
  );
  await wait(waitMilliseconds);
  waitedMilliseconds += waitMilliseconds;
}
```

---

## PROTOCOL SOURCE OF TRUTH

### Determination

The **real source of truth** for the Apollo protocol is:

### `apps/agent/src/protocol/schema.ts`

**Why this file is the source of truth:**

1. **Zod-validated**: All protocol messages are defined using Zod discriminated unions, which provides:
   - Compile-time type safety
   - Runtime validation that throws on invalid messages
   - Serialization via `JSON.stringify` + `encodeServerToDeviceMessage`
   - Deserialization via `JSON.parse` + `parseDeviceToServerMessage`

2. **Single authoritative location**: Every message type (both Device → Server and Server → Device) is defined in ONE file with Zod schemas. No duplication between code and documentation.

3. **Used by all handlers**: The `onMessage` handler in `apollo.ts:602` uses:
   ```typescript
   deviceMessage = parseDeviceToServerMessage(message);
   ```
   And message sending uses:
   ```typescript
   connection.send(encodeServerToDeviceMessage(message));
   ```

4. **Tests validate the schema**: The `schema.spec.ts` tests confirm every message can be parsed and encoded correctly, proving the schema is the ground truth.

5. **Documentation references it**: `documentation/runtime/protocol.md` line 3 states: "Device and server speak a Zod-validated JSON protocol defined in `apps/agent/src/protocol/schema.ts`."

6. **No other file defines the protocol**: While documentation describes the protocol, the actual implementation lives in the schema.ts file. The docs are derived from the code, not the other way around.

### Comparison: Schema.ts vs Documentation

| Aspect | `schema.ts` (Source of Truth) | `protocol.md` (Documentation) |
|--------|------------------------------|-------------------------------|
| **Message definitions** | Zod schemas with exact types | Descriptive text, some fields omitted |
| **Validation** | Runtime `parse()` throws on invalid | Described as "discriminated unions keep parsing strict" |
| **Field details** | Exact Zod constraints (required/optional, enums, ranges) | Summary notes, some fields marked optional |
| **Audio format** | `wrapPcmAsWavBuffer`, `TTS_PCM_SAMPLE_RATE_HZ`, `DEVICE_MIC_PCM_*` constants in `wav.ts` | "24000 Hz mono, so the ESP32 needs no decoder" |
| **Chunk sizes** | `TTS_STREAM_CHUNK_BYTE_LENGTH = 8192` in `wav.ts` | Not specified |
| **Transport** | `ArrayBuffer` via WebSocket in `apollo.ts:onMessage` | "Binary audio rides alongside" |
| **Dependencies** | Imports from `voice/wav.ts`, `voice/elevenlabs.ts`, `voice/stream.ts` | High-level description only |

### Conclusion

`apps/agent/src/protocol/schema.ts` is the **definitive source of truth** for the Apollo protocol. It is the single file that:

1. Defines all message schemas using Zod
2. Provides `parseDeviceToServerMessage()` and `encodeServerToDeviceMessage()` functions
3. Is the reference point for all WebSocket message handling
4. Is validated by the test suite `schema.spec.ts`
5. Is referenced by the documentation handbook

The documentation in `documentation/runtime/protocol.md` is a **derived summary** written to help humans understand the protocol, but it references the code file and would drift if the code changed without updating the docs. The code is always the final arbiter.

---
*End of Protocol Audit Report*