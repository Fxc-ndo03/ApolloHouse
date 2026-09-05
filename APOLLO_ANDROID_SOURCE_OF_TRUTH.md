# APOLLO_ANDROID_SOURCE_OF_TRUTH

## Fuente de verdad para la implementación del cuerpo Android de Apollo

**Repositorio base**: Apollo Cloudflare Worker (repositorio original GitHub)
**Dispositivo objetivo**: Samsung Galaxy S5 SM-G900H / LineageOS 14.1 / Android 7.1 (API 25)
**Arquitectura**: Android = cuerpo físico (I/O, UI, wake word local), Cloudflare = cerebro (STT, LLM, TTS, memory, tools, MCP, smart home)

---

## 1. Repository State

| Item | Valor |
|------|-------|
| **Branch** | `master` |
| **Commit actual** | Sin commits (repositorio recién clonado) |
| **Working tree** | Untracked files: `.agents/`, `.claude/`, `.editorconfig`, `.gitattributes`, `.github/`, `.gitignore`, `.gitleaksignore`, `.gitmodules`, `.oxfmtrc.json`, `.oxlintrc.json`, `.vscode/`, `CLAUDE.md`, `CONTRIBUTING.md`, `LICENSE`, `README.md`, `android-compatibility-audit.md`, `apps/`, `audit-protocol-report.md`, `branding/`, `bun.lock`, `commitlint.config.ts`, `documentation/`, `firmware-audit-report.md`, `greptile.json`, `lefthook.yml`, `package.json`, `packages/`, `smart-home-audit-report.md`, `turbo.json` |
| **Submodules** | `apps/firmware/apollo-firmware` → `https://github.com/galfrevn/apollo-firmware.git` (no inicializado localmente) |
| **Cambios locales** | Ninguno (repositorio limpio, solo untracked) |

---

## 2. WebSocket Contract

### Endpoint Real
- **URL**: `wss://<worker-host>/agents/apollo/<instance-name>?token=<DEVICE_SHARED_SECRET>`
- **Instancia por convención**: `desk`
- **Origen**: Documentación console `apps/console/src/docs/content/protocol.md:10` + código `apps/agent/src/index.ts:57-60`

### Autenticación
- **Token**: `DEVICE_SHARED_SECRET` como query parameter `?token=`
- **Extracción**: `readDeviceTokenFromRequestUrl()` en `apps/agent/src/auth/token.ts:40-42`
- **Validación**: `isDeviceSharedSecretValid()` en `apps/agent/src/auth/token.ts:21-38`
- **Comparación**: Timing-safe byte comparison (`areByteArraysEqualTimingSafe` en `token.ts:5-18`)

### Roles
- **device**: `DEVICE_SHARED_SECRET` válido → role `'device'`
- **dashboard**: `DASHBOARD_SHARED_SECRET` válido → role `'dashboard'`
- **Resolución**: `resolveApolloConnectionRole()` en `apps/agent/src/auth/role.ts:11-24`

### Flujo de Conexión
1. Device conecta con `?token=DEVICE_SHARED_SECRET`
2. `onBeforeConnect` → `authorizeApolloConnection()` → `resolveApolloConnectionRole()`
3. Si válido → tag `'device'` via `getConnectionTags()` en `apollo.ts:518-527`
4. **Inmediatamente después**: `onConnect()` → `#pushUiState()` + `#pushDashboard()` + `#flushPendingDeviceMessages()` (`apollo.ts:571-573`)

### Mensajes
**Primer mensaje del dispositivo**: `hello` (requiere `deviceId` + `ts`)
**Primer mensaje del servidor**: `ui_state` (replay en `onConnect`)

### Mensajes Device → Server (schema.ts:41-116)
| Type | Required | Optional | Handler |
|------|----------|----------|---------|
| `hello` | `deviceId`, `ts` | - | `apollo.ts:622-624` |
| `hold_start` | `ts` | - | `apollo.ts:626-634` |
| `hold_end` | `ts` | - | `apollo.ts:636-638` |
| `wake` | `ts` | - | `apollo.ts:626-634` |
| `audio_end` | `ts` | - | `apollo.ts:640-642` |
| `listen_cancel` | `ts` | - | `apollo.ts:644-648` |
| `gesture` | `gesture`, `ts` | - | `apollo.ts:664-666` |
| `confirm` | `ok`, `ts` | - | `apollo.ts:660-662` |
| `text_input` | `text`, `ts` | - | `apollo.ts:650-652` |
| `abort` | `ts` | - | `apollo.ts:654-658` |
| `telemetry` | `ts` | `battery`, `charging`, `volume`, `wifiRssi`, `firmwareVersion` | `apollo.ts:668-670` |
| `mcp` | `payload{jsonrpc, id, result?, error?}`, `ts` | - | `apollo.ts:672-674` |
| `playback_ack` | `sequence`, `playedMilliseconds`, `ts` | - | `apollo.ts:676-681` |

### Mensajes Server → Device (schema.ts:120-214)
| Type | Required | Optional | Handler |
|------|----------|----------|---------|
| `ui_state` | `state`, `speechMode` | `caption`, `focusRemainingSec`, `focusStartedAt`, `focusEndsAt`, `emotion`, `accentColor` | `apollo.ts:571` |
| `confirm_request` | `id`, `summary`, `expiresAt` | - | `runtime.ts:254-263` |
| `confirm_close` | `id`, `reason` | - | `apollo.ts:1205-1227` |
| `tts_start` | `format`, `bytes?`, `sequence?`, `sampleRate?`, `channels?` | - | `runtime.ts:305-315` |
| `tts_end` | - | - | `runtime.ts:347` |
| `tts_aborted` | - | - | `runtime.ts:354` |
| `timer` | - | `endsAt`, `durationSeconds` | `apollo.ts:2107-2114` |
| `turn_end` | `expectsReply` | - | `runtime.ts:360-365` |
| `error` | `code`, `message` | - | `apollo.ts:611-617` |
| `dashboard` | `clock{timezone,isoNow}`, `weather{locationLabel,temperatureC,conditionLabel,updatedAt}` | - | `apollo.ts:572` |
| `background_result` | `summary`, `prompt` | `documentKey` | `broadcast/deliver.ts` |
| `reminder` | `message` | - | `notify.ts` |
| `play_effect` | `name` | - | `apollo.ts:1233` |
| `mcp` | `payload{jsonrpc, id, method, params?}` | - | `apollo.ts:1016` |

### Audio Binario
- **Detección**: `message instanceof ArrayBuffer` o `ArrayBuffer.isView(message)` (`apollo.ts:587-598`)
- **Almacenamiento**: `#audioChunkList.push(message)` → concatenado en `#runTurnFromAudio()`

### Mensajes Desconocidos / Malformed
- JSON malformed: `parseDeviceToServerMessage()` lanza → `error` con `code: 'invalid_message'` (`apollo.ts:600-618`)
- Tipo desconocido: Zod discriminatedUnion rechaza → `error` response

---

## 3. Authentication Contract

| Secret | Existe | Dónde se Lee | Dónde se Valida | Comparación |
|--------|--------|--------------|-----------------|-------------|
| `DEVICE_SHARED_SECRET` | ✅ Sí | `environment.DEVICE_SHARED_SECRET` | `isDeviceSharedSecretValid()` | Timing-safe byte comparison |
| `DASHBOARD_SHARED_SECRET` | ✅ Sí | `environment.DASHBOARD_SHARED_SECRET` | `isDeviceSharedSecretValid()` | Timing-safe byte comparison |
| `MOBILE_SHARED_SECRET` | ❌ **NO EXISTE** | N/A | N/A | N/A |

**Timing-safe**: Sí, `areByteArraysEqualTimingSafe()` en `token.ts:5-18` compara byte a byte con XOR acumulado.

**Separación mobile/device**: **NO EXISTE**. Solo `device` y `dashboard`. Agregar mobile requeriría modificar `resolveApolloConnectionRole()` en `role.ts:11-24` para agregar tercera verificación.

---

## 4. Protocol Contract

### Device → Server (JSON)
Ver tabla completa en sección 2.

### Server → Device (JSON)
Ver tabla completa en sección 2.

### Audio Binario
- **Device → Server**: `ArrayBuffer` raw PCM 16kHz mono s16le (sin header WAV)
- **Server → Device**: `ArrayBuffer` raw PCM 24kHz mono s16le, chunked 8192 bytes

### Detección Audio
```typescript
// apollo.ts:587-598
if (message instanceof ArrayBuffer) { ... }
if (ArrayBuffer.isView(message)) { ... }
```

### Audio Recibido
- Se acumula en `#audioChunkList: ArrayBuffer[]`
- Procesado en `#runTurnFromAudio()` → `concatenateArrayBufferList()` → `wrapPcmAsWavBuffer()` → STT

### Mensajes Desconocidos
- `parseDeviceToServerMessage()` lanza ZodError → `error` response con `code: 'invalid_message'`

---

## 5. Audio Input Contract

| Parámetro | Valor | Fuente |
|-----------|-------|--------|
| **Sample rate** | 16000 Hz | `wav.ts:5` `DEVICE_MIC_PCM_SAMPLE_RATE_HZ` |
| **Bit depth** | 16 bits | `wav.ts:7` `DEVICE_MIC_PCM_BITS_PER_SAMPLE` |
| **Channels** | 1 (mono) | `wav.ts:6` `DEVICE_MIC_PCM_CHANNEL_COUNT` |
| **Signed/Unsigned** | Signed (s16le) | `wav.ts:1-3` "little-endian PCM" |
| **Endianness** | Little-endian | `wav.ts:1-3` |
| **Formato** | Raw PCM (sin header WAV en wire) | `wav.ts:1-3` |
| **Frame size** | Variable (chunks acumulados en `#audioChunkList`) | `apollo.ts:587-598` |
| **Metadata en frame** | No (solo raw PCM) | `wav.ts:1-3` |

### Inicio de Grabación
- Mensaje: `hold_start` (push-to-talk) o `wake` (wake word)
- Handler: `apollo.ts:626-634` → `#audioChunkList = []` + `START_LISTEN` UI event

### Fin de Grabación
- Mensaje: `hold_end` (suelta botón) o `audio_end` (VAD timeout)
- Handler: `apollo.ts:636-642` → `#runTurnFromAudio()`

### Diferencia Input vs Output
| | **Input (Mic)** | **Output (TTS)** |
|---|-----------------|------------------|
| Sample rate | 16000 Hz | 24000 Hz |
| Channels | 1 | 1 |
| Bits | 16 | 16 |
| Endian | LE | LE |
| En wire | Raw PCM chunks | Raw PCM chunks + `tts_start` metadata |

---

## 6. Audio Output / TTS Contract

| Parámetro | Valor | Fuente |
|-----------|-------|--------|
| **Sample rate** | 24000 Hz | `elevenlabs.ts:5` `TTS_PCM_SAMPLE_RATE_HZ` |
| **Channels** | 1 (mono) | `elevenlabs.ts:6` `TTS_PCM_CHANNEL_COUNT` |
| **Bit depth** | 16 bits (s16le) | `elevenlabs.ts:2-3` "headerless s16le mono" |
| **Formato ElevenLabs** | `pcm_24000` | `elevenlabs.ts:17` |
| **Chunk size** | 8192 bytes | `wav.ts:12` `TTS_STREAM_CHUNK_BYTE_LENGTH` (~170ms @ 24kHz) |
| **Prebuffer** | 2000 ms | `stream.ts:7` `TTS_STREAM_PREBUFFER_MILLISECONDS` |
| **Pace factor** | 0.85 | `stream.ts:10` `TTS_STREAM_PACE_FACTOR` |
| **Max backlog** | 4000 ms | `stream.ts:18` `TTS_STREAM_MAX_BACKLOG_MILLISECONDS` |

### Secuencia TTS
1. `tts_start` con `format: 'pcm'`, `bytes`, `sampleRate: 24000`, `channels: 1`, `sequence` (`runtime.ts:305-315`)
2. **Chunks binarios** 8192 bytes cada uno via `connection.send(audioChunk)` (`runtime.ts:337-338`)
3. `tts_end` al finalizar segmento (`runtime.ts:347`)
4. Si abort: `tts_aborted` (`runtime.ts:354`)

### Playback ACK
- **Frecuencia**: ~1/s
- **Payload**: `sequence`, `playedMilliseconds`, `ts`
- **Uso server**: `estimatePlayedMilliseconds()` + backlog pacing (`stream.ts:49-57`, `stream.ts:103-123`)

### Android Debe
| Acción | Cuándo |
|--------|--------|
| Crear `AudioTrack` 24kHz mono s16le | Al recibir `tts_start` |
| Escribir chunks | Al recibir frames binarios tras `tts_start` |
| Enviar `playback_ack` | ~1/s durante playback (`sequence`, `playedMilliseconds`) |
| Detener `AudioTrack` | Al recibir `tts_end` o `tts_aborted` |
| Reabrir mic | Si `turn_end.expectsReply === true` |

---

## 7. UI State Contract

### Estados (machine.ts:3-11, schema.ts:3-11)
```
idle → listening → thinking → confirm → speaking → idle/focus/dashboard
         ↑           ↑            ↓
         └───────────┴────────────┘ (CANCEL)
```

### Transiciones (machine.ts:27-102)
| Evento | Desde | Hacia | Mensaje WebSocket |
|--------|-------|-------|-------------------|
| `START_LISTEN` | idle/focus/dashboard | listening | `ui_state {state: 'listening'}` |
| `START_THINK` | listening | thinking | `ui_state {state: 'thinking', caption}` |
| `NEED_CONFIRM` | thinking | confirm | `confirm_request` + `ui_state {state: 'confirm'}` |
| `START_SPEAK` | thinking/confirm | speaking | `ui_state {state: 'speaking'}` |
| `SPEAK_DONE` | speaking | returnAfterSpeakState | `turn_end {expectsReply}` |
| `OPEN_DASHBOARD` | idle | dashboard | `dashboard` + `ui_state {state: 'dashboard'}` |
| `CLOSE_DASHBOARD` | dashboard | idle | `ui_state {state: 'idle'}` |
| `ENTER_FOCUS` | idle/dashboard | focus | `ui_state {state: 'focus', focusRemainingSec}` |
| `EXIT_FOCUS` | focus | idle | `ui_state {state: 'idle'}` |
| `CANCEL` | listening/thinking/confirm/speaking | returnAfterSpeakState | `ui_state` + `tts_aborted` si speaking |

### Payload por Estado
| Estado | Data Adicional en `ui_state` |
|--------|------------------------------|
| `idle` | `speechMode` |
| `listening` | `speechMode` |
| `thinking` | `caption`, `emotion`, `accentColor`, `focusRemainingSec?` |
| `confirm` | `speechMode`, `caption` |
| `speaking` | `emotion`, `accentColor`, `focusRemainingSec?` |
| `focus` | `focusRemainingSec`, `focusStartedAt`, `focusEndsAt`, `emotion`, `accentColor` |
| `dashboard` | mensaje `dashboard` separado con `clock` + `weather` |

### Confirm
- Trigger: tool con `safety: 'unsafe'` → `NEED_CONFIRM` event
- Mensaje: `confirm_request {id, summary, expiresAt}`
- Respuesta device: `confirm {ok: boolean}` → `#resolveConfirm()`

### Dashboard
- Abrir: gesture `tap` → `OPEN_DASHBOARD` → `dashboard` message
- Cerrar: `CLOSE_DASHBOARD` o timeout
- Refresh: cada 30 min si UI en `dashboard` y device conectado (`dashboard.ts`)

---

## 8. Telemetry Contract

| Field | Type | Units | Required | Fuente |
|-------|------|-------|----------|--------|
| `battery` | int 0-100 | % | No | `schema.ts:88` |
| `charging` | boolean | - | No | `schema.ts:89` |
| `volume` | int 0-100 | % | No | `schema.ts:90` |
| `wifiRssi` | int | dBm | No | `schema.ts:91` |
| `firmwareVersion` | string | - | No | `schema.ts:92` |
| `ts` | int | epoch ms | Sí | `schema.ts:93` |

### Frecuencia
- Inmediato tras connect
- Cada 60 segundos
- En charging edge (`didChargingEdgeOccur` en `apollo.ts:1915-1918`)

### Uso en System Prompt
- Snapshot guardado en `TELEMETRY_SNAPSHOT_PREFERENCE_KEY` (`apollo.ts:1923-1927`)
- Inyectado en prompt mientras fresco (< 5 min) (`telemetry/logic.ts`)
- Low battery ≤15% → anuncio `critical` (rompe focus) (`telemetry/logic.ts`)

---

## 9. Device MCP Contract

### Existe Actualmente
✅ **Sí**, MCP bridge implementado en `mcp/bridge.ts`

### Protocolo
- **JSON-RPC 2.0** over WebSocket
- **Request**: `{jsonrpc: '2.0', id: number, method: 'tools/call', params: {name, arguments}}`
- **Response**: `{jsonrpc: '2.0', id: number, result?, error?}`
- **ID**: **Debe ser integer** (device descarta string IDs) (`bridge.ts:207-208`)

### Tools Device Existentes (device.ts)
| Tool | Descripción | Handler |
|------|-------------|---------|
| `self.audio_speaker.set_volume` | `volume: 0-100` | `device.ts:17-43` |
| `self.screen.set_brightness` | `brightness: 0-100` | `device.ts:45-71` |
| `self.get_device_status` | Sin args | `device.ts:88-110` |

### Timeout
- `DEVICE_TOOL_CALL_TIMEOUT_MILLISECONDS = 5000` (`bridge.ts:4`)

### Flujo LLM → Device
1. LLM llama tool `self.*` → `mcp/bridge.ts:85-95` crea payload
2. Server envía `mcp` message con `tools/call`
3. Device ejecuta en su MCP server embebido
4. Device responde `mcp` con `result` o `error`
5. Server resuelve via `#deviceMcpRequestRegistry.resolvePendingRequest()` (`apollo.ts:673`)

### Android
- **NO** herramientas de smart home actualmente
- Solo 3 tools locales del device (volumen, brillo, status)

---

## 10. Boot / Reconnect Contract

### Boot ESP32 (actual)
1. `BOOT_COMPLETED` → time sync → OTA check (`/ota/check?token=`) (`ota/lifecycle.ts`)
2. WebSocket connect con `?token=DEVICE_SHARED_SECRET`
3. `hello` con `deviceId` + `ts`
4. Server: `onConnect` → `ui_state` + `dashboard` + `flushPendingDeviceMessages()`

### Reconnect (diseño Android)
| Intento | Delay |
|---------|-------|
| 1 | 1s |
| 2 | 2s |
| 3 | 4s |
| 4 | 8s |
| 5 | 16s |
| 6+ | 30s (max) |

### Persistencia tras Reconnect
| Dato | Sobrevive | Dónde |
|------|-----------|-------|
| `deviceId` | Sí | Durable Object name |
| `DEVICE_SHARED_SECRET` | Sí | Firmware/prefs |
| `publicOrigin` | Sí | SQLite `PUBLIC_ORIGIN_PREFERENCE_KEY` |
| Pending messages | Sí | SQLite `pending_device_messages` |
| Session prefs | Sí | SQLite `session_prefs` |
| Telemetry | Sí | SQLite `TELEMETRY_SNAPSHOT_PREFERENCE_KEY` |

---

## 11. Firmware Relationship

### Partes ESP32-Específicas
| Componente | ESP32-Specific | Reutilizable Android |
|-----------|----------------|---------------------|
| Audio I2S | Sí (hardware I2S) | No (AudioRecord/AudioTrack) |
| Wake word | Sí (hardware VAD) | Parcial (local wake word engine) |
| Touch gestures | Sí (capacitive) | Sí (touch screen) |
| Face LED matrix | Sí | No (Canvas UI) |
| OTA binary | Sí (`xiaozhi.bin`) | No (Android system updates) |
| MCP server embebido | Sí | Parcial (AIDL/Service) |
| Boot time sync | Sí | Sí (Android time) |
| Flash storage | Sí | No (Android storage) |

### Protocolo Compartido
✅ **Mismo schema.ts** - Android debe implementar exactamente el mismo protocolo

### OTA
- ESP32: `/ota/check` + `/ota/firmware.bin` con `?token=`
- Android: No aplica (system updates)

---

## 12. Tools Catalog (26 Tools)

### Backend Tools (Cloud)
| Tool | File | Category | Confirm | External |
|------|------|----------|---------|----------|
| `weather_now` | `weather.ts` | Weather | No | Open-Meteo |
| `set_weather_location` | `location.ts` | Weather | No | Open-Meteo |
| `remember_fact` | `memory.ts` | Memory | No | SQLite + Vectorize |
| `set_focus` | `focus.ts` | Focus | No | Local |
| `clear_focus` | `focus.ts` | Focus | No | Local |
| `web_search` | `web.ts` | Web | No | Tavily |
| `start_research` | `research.ts` | Web | No | Perplexity via OpenRouter |
| `recall_memory` | `memory.ts` | Memory | No | SQLite + Vectorize |
| `recall_conversation` | `history.ts` | Memory | No | Session |
| `resume_conversation` | `history.ts` | Memory | No | Session |
| `translate` | `translate.ts` | Web | No | OpenRouter |
| `set_reminder` | `reminder.ts` | Reminders | No | Schedules |
| `list_reminders` | `reminder.ts` | Reminders | No | Schedules |
| `cancel_reminder` | `reminder.ts` | Reminders | No | Schedules |
| `set_timer` | `timer.ts` | Timers | No | Schedules |
| `start_pomodoro` | `timer.ts` | Timers | No | Schedules + Focus |
| `add_to_list` | `list.ts` | Lists | No | SQLite |
| `read_list` | `list.ts` | Lists | No | SQLite |
| `remove_from_list` | `list.ts` | Lists | No | SQLite |
| `dollar_rate` | `dollar.ts` | Rates | No | BCRA API |
| `send_email` | `email.ts` | Email | No | Resend |
| `sandbox_run_code` | `sandbox.ts` | Sandbox | No | Sandbox DO |
| `sandbox_exec` | `sandbox.ts` | Sandbox | No | Sandbox DO |
| `list_coding_repositories` | `coding.ts` | Coding | No | GitHub |
| `start_coding_task` | `coding.ts` | Coding | No | GitHub + Sandbox |

### Device-Local Tools (3)
| Tool | File | Confirm | Local/Cloud |
|------|------|---------|-------------|
| `set_volume` | `device.ts` | No | Device |
| `set_brightness` | `device.ts` | No | Device |
| `device_status` | `device.ts` | No | Device |

**Android hereda automáticamente**: Todos los 26 backend tools via Cloud. Solo debe implementar 3 device tools locales.

---

## 13. Memory Architecture

| Componente | Storage | Scope | Sobrevive Reconnect | Sobrevive Reboot Android |
|-----------|---------|-------|---------------------|-------------------------|
| Memories (facts) | SQLite `memories` + Vectorize | Device (`deviceId` namespace) | ✅ | ✅ (en Cloud) |
| Session prefs | SQLite `session_prefs` | Device | ✅ | ✅ |
| Thread meta | SQLite `thread_meta` | Device | ✅ | ✅ |
| Pending messages | SQLite `pending_device_messages` | Device | ✅ | ✅ |
| List items | SQLite `list_items` | Device | ✅ | ✅ |
| Pending confirmations | SQLite `pending_confirmations` | Device | ✅ | ✅ |
| MCP tool settings | SQLite `mcp_tool_settings` | Device | ✅ | ✅ |
| Session context (soul, memory, handoff, knowledge, skills) | SessionManager (SDK) | Per thread | ✅ | ✅ |
| Vectorize embeddings | Vectorize index | Device namespace | ✅ | ✅ |

**Scope por device**: `deviceId` = Durable Object name = `desk` por convención
**DeviceId**: `this.name ?? 'default'` en `apollo.ts:1036, 1240, 1334, etc.`

---

## 14. Smart Home Status

| Feature | Existe | Archivo | Implementación Real | Dependencias |
|---------|--------|---------|---------------------|--------------|
| Google Home | ❌ No | N/A | N/A | N/A |
| Google Assistant | ❌ No | N/A | N/A | N/A |
| Home Assistant | ❌ No | Solo mención en roadmap `console/src/docs/roadmap/catalog.ts:162-167` | N/A | N/A |
| Lights | ❌ No | N/A | N/A | N/A |
| Switches | ❌ No | N/A | N/A | N/A |
| Plugs | ❌ No | N/A | N/A | N/A |
| Thermostat | ❌ No | N/A | N/A | N/A |
| Device control | ❌ No | Solo 3 device tools locales | N/A | N/A |
| Automation | ❌ No | N/A | N/A | N/A |
| Scenes | ❌ No | N/A | N/A | N/A |
| OAuth/API integration | ❌ No | N/A | N/A | N/A |
| MCP smart home | ❌ No | Solo MCP bridge para device tools | N/A | N/A |

**CONCLUSIÓN**: `SMART HOME STATUS: NOT IMPLEMENTED`

Solo mención en roadmap console como "exploring" (`console/src/docs/roadmap/catalog.ts:162-167`)

---

## 15. Console Status

| Aspecto | Detalle |
|---------|---------|
| **Auth** | `DASHBOARD_SHARED_SECRET` via `?token=` en WebSocket |
| **Endpoint** | Mismo worker, WebSocket `/agents/apollo/desk` con dashboard token |
| **Auth HTTP** | `authorizeApolloHttpRequest()` valida dashboard token (`http.ts:6-18`) |
| **401 causes** | Token inválido, faltante, o endpoint `/callback` sin auth |
| **Endpoint compartido** | Sí, mismo worker. Diferencia: token (device vs dashboard) |
| **Separación roles** | ✅ Real: `hasDeviceConnectionTag()` filtra mensajes device en `onMessage` (`apollo.ts:583-584`) |

---

## 16. Cloudflare Bindings

| Binding | Tipo | Uso | Archivo | Necesario Android |
|---------|------|-----|---------|-------------------|
| `Apollo` | Durable Object | Agent principal, SQLite state | `wrangler.jsonc:33-36` | No (Cloud) |
| `Sandbox` | Durable Object (Container) | Coding sandbox | `wrangler.jsonc:37-40` | No (Cloud) |
| `MEDIA` | R2 Bucket | TTS cache, firmware, broadcasts | `wrangler.jsonc:54-58` | No (Cloud) |
| `VECTORIZE` | Vectorize Index | Memory embeddings | `wrangler.jsonc:60-64` | No (Cloud) |
| `APOLLO_QUEUE` | Queue | Background jobs | `wrangler.jsonc:66-79` | No (Cloud) |
| `BACKGROUND` | Workflow | Deep research | `wrangler.jsonc:81-86` | No (Cloud) |
| `CODING` | Workflow | Coding tasks | `wrangler.jsonc:87-91` | No (Cloud) |
| `Sandbox` | Container | Code execution | `wrangler.jsonc:23-29` | No (Cloud) |

**Ningún binding es necesario en Android** — todos son server-side.

---

## 17. Contradictions

### Contradicción 1: WebSocket Endpoint
| | |
|---|---|
| **DOCUMENTO DICE** | `wss://<worker-host>/agents/apollo/<instance-name>?token=<DEVICE_SHARED_SECRET>` (`console/src/docs/content/protocol.md:10`) |
| **CÓDIGO DICE** | `routeAgentRequest` maneja todo; no hay endpoint explícito en código. El SDK Agents usa patrón `/agents/apollo/:name` | `index.ts:57-60` |
| **FUENTE DE VERDAD** | Código + documentación console (coinciden en patrón) |
| **IMPACTO ANDROID** | Usar `wss://<host>/agents/apollo/desk?token=SECRET` |

### Contradicción 2: TTS Chunk Size
| | |
|---|---|
| **DOCUMENTO DICE** | "Roughly 170 ms of 24 kHz mono audio per frame" (`wav.ts:10-12`) |
| **CÓDIGO DICE** | 8192 bytes = 170.67ms exacto @ 24kHz mono s16le (8192 / (24000*2) = 0.17067s) | `wav.ts:12`, `stream.ts:75` |
| **FUENTE DE VERDAD** | Código (8192 bytes exacto) |
| **IMPACTO ANDROID** | Usar 8192 bytes/chunk para `AudioTrack.write()` |

### Contradicción 3: TTS Format in tts_start
| | |
|---|---|
| **DOCUMENTO DICE** | `format: 'pcm'` always in production (`protocol.md:62-63`) |
| **CÓDIGO DICE** | `format: z.enum(['mp3', 'wav', 'pcm'])` opcional en schema; runtime hardcodea `'pcm'` | `schema.ts:147`, `runtime.ts:307` |
| **FUENTE DE VERDAD** | Código (runtime hardcodea 'pcm') |
| **IMPACTO ANDROID** | Esperar `format: 'pcm'` siempre; validar pero no depender de otros |

### Contradicción 4: MOBILE_SHARED_SECRET
| | |
|---|---|
| **DOCUMENTO DICE (auditorías previas)** | Propuso `MOBILE_SHARED_SECRET` para Android |
| **CÓDIGO DICE** | Solo `DEVICE_SHARED_SECRET` y `DASHBOARD_SHARED_SECRET` existen | `role.ts:14-23` |
| **FUENTE DE VERDAD** | Código (no existe) |
| **IMPACTO ANDROID** | Android debe usar `DEVICE_SHARED_SECRET` existente o agregar secreto nuevo (requiere backend change) |

### Contradicción 5: Smart Home
| | |
|---|---|
| **DOCUMENTO DICE (roadmap)** | "Home Assistant", "Philips Hue" como brands exploring (`console/src/docs/roadmap/catalog.ts:162-167`) |
| **CÓDIGO DICE** | Cero implementación, cero tools, cero MCP, cero auth | Búsqueda exhaustiva |
| **FUENTE DE VERDAD** | Código (no existe) |
| **IMPACTO ANDROID** | Android NO implementa smart home; futuro requiere backend changes |

---

## 18. Android Constraints (API 25)

| API | Disponible API 25 | Notas |
|-----|-------------------|-------|
| `AudioRecord` | ✅ | `minBufferSize` check required |
| `AudioTrack` | ✅ | Streaming mode `MODE_STREAM` |
| `WebSocket` | ✅ | OkHttp 3.14+ o `javax.net.ssl` nativo |
| `TLS/WSS` | ✅ | Android 7.1 soporta TLS 1.2 |
| `ForegroundService` | ✅ | Requiere notification visible |
| `BootReceiver` | ✅ | `BOOT_COMPLETED` + `RECEIVE_BOOT_COMPLETED` |
| `WakeLock` | ✅ | `FULL_WAKE_LOCK` + `ACQUIRE_CAUSES_WAKEUP` |
| `Canvas` / `SurfaceView` | ✅ | Fullscreen UI |
| `WindowManager` fullscreen | ✅ | `FLAG_FULLSCREEN` |
| `LockTaskMode` (kiosk) | ⚠️ Parcial | API 23+ disponible, pero limitado |
| `AudioManager` | ✅ | Volume/brightness control |
| `BatteryManager` | ✅ | Telemetry |
| `WifiManager` | ✅ | Telemetry RSSI |
| Local wake word | ✅ | Porcupene, PocketSphinx, o custom TFLite |
| Background execution | ⚠️ Limitado | Doze mode API 23+; ForegroundService mitiga |

**NO usar**: Jetpack Compose (min API 21 pero requiere Kotlin 1.5+), librerías modernas incompatibles.

---

## 19. Things Android MUST Implement

1. **WebSocket Client**: OkHttp 3.14+ WSS con `?token=DEVICE_SHARED_SECRET`
2. **AudioRecord**: 16kHz mono s16le → `ArrayBuffer` chunks → WSS
3. **AudioTrack**: 24kHz mono s16le streaming desde WSS binary frames
4. **Wake Word Local**: Interface `start()/stop()/onWake()` → envía `wake` message
5. **Protocol Parser**: Zod-equivalent para todos los mensajes D2S/S2D
6. **UI State Renderer**: Canvas fullscreen, 7 estados, animaciones
7. **Telemetry Collector**: Battery, charging, volume, WiFi, FW version → `telemetry` msg
8. **MCP Client**: JSON-RPC 2.0 over WSS para `self.*` tools
9. **ForegroundService**: Persistent, wake lock, notification
10. **BootReceiver**: `BOOT_COMPLETED` → auto-start service
11. **WakeLock**: `FULL_WAKE_LOCK` durante interacción; release en idle
12. **Reconnect Logic**: Exponential backoff 1s→30s max
12. **Local MCP Tools**: `set_volume`, `set_brightness`, `get_device_status`
13. **Gesture Handling**: tap/swipe/double_tap → protocol messages
14. **Abort Handling**: Tap durante TTS → `abort` message
15. **Playback ACK**: Enviar ~1/s con `sequence`, `playedMilliseconds`

---

## 20. Things Android MUST NOT Implement

1. ❌ **STT** (Whisper/OpenRouter) — Cloud
2. ❌ **LLM** (OpenRouter) — Cloud
3. ❌ **TTS** (ElevenLabs) — Cloud
3. ❌ **Memory/Vectorize** — Cloud
4. ❌ **Tools backend** (weather, web_search, research, reminders, etc.) — Cloud
5. ❌ **Smart Home logic** — Cloud (future)
6. ❌ **Reminders/Timers scheduling** — Cloud (schedules)
7. ❌ **Memory consolidation** — Cloud (nightly cron)
8. ❌ **OAuth/MCP server management** — Cloud + Console
9. ❌ **Sandbox/Code execution** — Cloud (Sandbox DO)
10. ❌ **Firmware OTA** — Cloud (device solo recibe push via MCP)
11. ❌ **Protocol schema definition** — Fuente de verdad es `schema.ts` en Cloud
12. ❌ **Auth secrets management** — Cloud (wrangler secrets)

---

## 21. Things Requiring Backend Changes

| Cambio | Archivos Afectados | Prioridad |
|--------|-------------------|-----------|
| Agregar `MOBILE_SHARED_SECRET` | `wrangler.jsonc`, `role.ts`, `token.ts`, `auth tests` | Alta (si Android usa secreto separado) |
| Permitir `instance-name` ≠ `desk` | `apollo.ts` deviceId logic | Media |
| Versionar protocolo (para compatibilidad) | `schema.ts`, `protocol.md` | Baja |
| Exponer endpoint device info | Nuevo endpoint HTTP | Baja |

---

## 22. Open Questions

1. **¿Android usa `DEVICE_SHARED_SECRET` existente o nuevo `MOBILE_SHARED_SECRET`?**
   - Impacta: auth flow, rotation, OTA, firmware compatibility

2. **¿Wake word engine: Porcupene, PocketSphinx, o TFLite custom?**
   - Impacta: binary size, accuracy, latency, licensing

3. **¿Cómo manejar Doze mode / battery optimizations en Android 7.1?**
   - ForegroundService + WakeLock + `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`?

4. **¿AudioTrack buffer underrun handling en red inestable?**
   - Buffer sizing, jitter buffer, reconnect grace period

5. **¿Migración firmware existente (ESP32) → Android sin romper OTA?**
   - Compartir `deviceId` namespace? Separar instancias?

---

## 23. Recommended Implementation Order

| Phase | Entregable | Criterio de Éxito |
|-------|------------|-------------------|
| **A** | Android Studio project + Gradle 4.6 + AGP 3.3 + Kotlin 1.3.x + minSdk=25 targetSdk=25 | Build limpio |
| **B** | `ApolloWebSocket` + Auth + `hello`/`ui_state` roundtrip | Conecta, autentica, recibe `ui_state` idle |
| **C** | Protocol parser/generator (Kotlin data classes + serialization) | Todos los 24 mensajes parse/encode OK |
| **D** | `ApolloAudioRecorder` 16kHz mono s16le → WSS binary | Captura audio, envía chunks, server recibe |
| **E** | `ApolloAudioPlayer` 24kHz mono s16le + `tts_start`/chunks/`tts_end` | Reproduce TTS completo con pacing |
| **F** | `ApolloFaceView` Canvas + 7 estados + animaciones | Renderiza todos los estados de `ui_state` |
| **G** | `ApolloBootReceiver` + `ApolloService` + Reconnect backoff | Sobrevive reboot, reconecta automáticamente |
| **H** | WakeLock + Sleep mode (pantalla off, CPU on para wake word) | Dispositivo duerme, wake word funciona |
| **I** | `ManualWakeWordDetector` (button) → `wake` message | Pipeline validado end-to-end |
| **J** | `LocalWakeWordDetector` (Porcupene/TFLite) | Wake word real local, sin audio a Cloud |
| **K** | Smart Home tools (backend only) | Cloud changes only |
| **L** | Production hardening: logs, metrics, OTA, error handling | Listo para deploy en S5 |

---

## Resumen Final

```
CAMBIOS REALIZADOS: 0
ARCHIVOS EXISTENTES MODIFICADOS: 0
ARCHIVOS NUEVOS: APOLLO_ANDROID_SOURCE_OF_TRUTH.md
```

### 5 Decisiones Críticas Antes de Implementar

1. **Secreto Android**: ¿`DEVICE_SHARED_SECRET` compartido con ESP32 o `MOBILE_SHARED_SECRET` nuevo? (Impacta rotación, OTA, fleet management)

2. **Wake Word Engine**: ¿Porcupene (C++, Apache 2.0), PocketSphinx (GStreamer, BSD), o modelo TFLite custom? (Impacta tamaño, latencia, precisión, mantenimiento)

3. **Doze Mode Strategy**: ¿`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` + ForegroundService + `PARTIAL_WAKE_LOCK` persistente? (Android 7.1 agresivo con background)

4. **Instance Identity**: ¿Android usa mismo `deviceId: 'desk'` que ESP32 o instancia separada? (Impacta memory namespace, OTA, concurrent connections)

5. **Protocol Versioning**: ¿Agregar `protocol_version` en `hello`/`ui_state` para future-proofing? (Requiere backend change coordinado)

---

**Fin del reporte. Sin modificaciones al repositorio.**