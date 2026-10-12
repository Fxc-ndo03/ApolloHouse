# Apollo Desktop UI Handoff Document

**Version**: v0.1.1 (Apollo 2.0)  
**Date**: September 20, 2026  
**Platform**: Tauri 2.9.3, React 19.2.3, TypeScript 5.9.3, Vite 7.2.3  
**Status**: Production-ready desktop application

---

## Table of Contents

1. [Visual Identity](#1-visual-identity)
2. [Component Inventory](#2-component-inventory)
3. [State Management](#3-state-management)
4. [Layout System](#4-layout-system)
5. [Tauri Commands (Frontend ↔ Rust)](#5-tauri-commands)
6. [IPC Events (Rust → Frontend)](#6-ipc-events)
7. [IPC Events (Frontend → Rust)](#7-ipc-events-from-frontend)
8. [Settings Model & Persistence](#8-settings-model--persistence)
9. [Tauri Permissions](#9-tauri-permissions)
10. [CSS Architecture](#10-css-architecture)
11. [Key UI Flows](#11-key-ui-flows)
12. [Orb State Machine](#12-orb-state-machine)
13. [WebSocket / Local Server](#13-websocket--local-server)
14. [Sidecar Management](#14-sidecar-management)
15. [Type Definitions](#15-type-definitions)
16. [Window Configuration](#16-window-configuration)
17. [Entry Point & Build](#17-entry-point--build)
18. [Legacy / Dead Code](#18-legacy--dead-code)
19. [Hook Dependencies](#19-hook-dependencies)
20. [Component Hierarchy](#20-component-hierarchy)
21. [File System & Asset References](#21-file-system--asset-references)
22. [Responsive Behavior](#22-responsive-behavior)
23. [Error Handling & Fallbacks](#23-error-handling--fallbacks)
24. [Performance Considerations](#24-performance-considerations)
25. [Security Considerations](#25-security-considerations)
26. [Testing & Build](#26-testing--build)
27. [Package Dependencies](#27-package-dependencies)
28. [CSS Variables & Design Tokens](#28-css-variables--design-tokens)
29. [Component Responsibilities](#29-component-responsibilities)
30. [Orb 3D Component](#30-orb-3d-component)
31. [Voice System Architecture](#31-voice-system-architecture)
32. [Chat System](#32-chat-system)
33. [Settings System](#33-settings-system)
34. [Python Sidecar Protocol](#34-python-sidecar-protocol)
35. [Build Pipeline](#35-build-pipeline)
36. [Gaps & Recommendations](#36-gaps--recommendations)

---

## 1. Visual Identity

| Token | Value |
|-------|-------|
| Name | Apollo Desktop |
| Slug | `com.apollo.desktop` |
| Version | `0.1.1` |
| Theme | Dark-only. Deep space blacks (`#0a0a0f` → `#12121a` → `#1a1a2e`) with cyan (`#00d4ff`, `#0088cc`) and gold (`#ffd700`, `#daa520`) accents |
| Typography | Inter (weights 300–700) |
| Window | Single `main` window: 1000×650, `minWidth: 800`, `minHeight: 600`, title bar hidden, no decorations, `transparent: false` |

---

## 2. Component Inventory

**34 components** across 4 directories:

### Root (`apps/desktop/ui/src/components/`)

| File | Purpose |
|------|---------|
| `App/App.tsx` | Root shell. Single-window layout, initializes sidecar, auto-recovery, keybind listener, PCBridge reconnect. Routes between WelcomeScreen, SettingsWindow, and main Chat view |
| `Assistant/Assistant.tsx` | Orb 3D assistant wrapper. Hosts Three.js canvas, click/hover/touch handlers, status bar (model, tokens, latency, sidecar status), debug panel, status panel, thinking bubble, PCBridge status banner. **Largest component (1260 lines)** |
| `Layout/ChatLayout.tsx` | Single-window chat layout. Handles mobile detection, settings toggle, sidebar, chat, orb, and input area |
| `Layout/SplitViewLayout.tsx` | Unused alternate layout. SplitView-based, simpler than ChatLayout |
| `Onboarding/WelcomeScreen.tsx` | First-run wizard. Validates Gemini API key, calls Tauri `set_api_key` |
| `Voice/VoiceButton.tsx` | Mic toggle button with pulsing animation. Calls `start_listening`/`stop_listening` |
| `Settings/SettingsWindow.tsx` | Full settings panel. Tabs: General, AI, PCBridge, Agents, Dev. **~900 lines, most complex UI component** |
| `AgentManager/AgentManagerView.tsx` | Lists configured agents, agent detail modals |
| `AgentManager/AgentDetail.tsx` | Individual agent display/edit modal |

### Chat sub-components (`components/Chat/`)

| File | Purpose |
|------|---------|
| `ChatView.tsx` | Main chat interface. Message rendering, input, sidebar toggle. Has embedded `SideMenu` component |
| `Sidebar.tsx` | Active session view |
| `MessageItem.tsx` | Single message bubble |
| `ChatInput.tsx` | User input area |
| `TypingBubble.tsx` | "Assistant is thinking..." indicator |

### History sub-components (`components/History/`)

| File | Purpose |
|------|---------|
| `HistoryList.tsx` | Previous chat sessions list |
| `HistoryItem.tsx` | Single history entry |

### UI sub-components (`components/UI/`)

| File | Purpose |
|------|---------|
| `Button.tsx` | Reusable button (primary/secondary/danger/ghost/outline sizes) |
| `Card.tsx` | Container card |
| `Input.tsx` | Form input field |
| `Select.tsx` | Custom select dropdown |
| `StatusBadge.tsx` | Status indicator badges |
| `Modal.tsx` | Dialog overlay |
| `Toggle.tsx` | Toggle switch |
| `Tooltip.tsx` | Hover tooltip |
| `Spinner.tsx` | Loading spinner (12px–20px) |
| `Avatar.tsx` | User/assistant avatar |
| `ThinkingBubble.tsx` | AI thinking indicator |
| `ChatWindow.tsx` | Chat window container |
| `StatusBar.tsx` | Status information bar |
| `VersionBadge.tsx` | Version display |
| `SidebarIcon.tsx` | Sidebar icon |

### Voice sub-components (`components/Voice/`)

| File | Purpose |
|------|---------|
| `VoiceButton.tsx` | Mic toggle with animation |
| `WakeWordIndicator.tsx` | Pulsing ring animation when wake word detected |

---

## 3. State Management

### Zustand Store (`store/index.ts`)

**Single global store.** No reducers, no middleware (no persist, no devtools).

| Slice | Fields | Type |
|-------|--------|------|
| `theme` | `theme` | `"dark"` |
| `sidecar` | `sidecarStatus`, `cloudcoreStatus`, `pcbridgeStatus`, `cloudcorePid`, `pcbridgePid` | 5 fields |
| `ui` | `isVoiceActive`, `isListening`, `isSpeaking`, `isThinking`, `isBusy`, `showSettings`, `showWelcome`, `isSettingsOpen`, `isSidebarOpen`, `showHistory`, `agentDropdown` | 11 fields |
| `settings` | `config` | `AppSettings \| null` |
| `chat` | `messages`, `inputText`, `inputFocused`, `chatId`, `chatSessionId`, `selectedModel`, `isLoading`, `isConnected`, `assistantStatus` | 9 fields |
| `assistant` | `latency`, `modelLoaded`, `gpuEnabled`, `status`, `orbState`, `orbColor`, `agentName`, `modelId`, `modelName`, `gpuMode` | 10 fields |
| `connection` | `connectionStatus` | `ConnectionStatus` |
| `commands` | `pendingCommands`, `completedCommandIds`, `commandHistory` | 3 fields |
| `mcp` | `mcpServers` | `McpServerConfig[]` |
| `local` | `localModel`, `localModelLoaded`, `localGpuEnabled`, `localModelStatus`, `localAssistantName` | 5 fields |
| `voice` | `voiceStatus`, `voiceMode` | `VoiceMode` |
| `voiceStt` | `sttPartial`, `sttFinal` | string |
| `voiceWake` | `wakeActive`, `wakeMode`, `wakeWords` | `{ active, mode, words }` |

**Key selectors** (exported as standalone functions):
- `isOrbActive(assistant)` — true when `orbState` is `active`, `busy`, `thinking`, `listening`
- `isOrbInactive(assistant)` — true when `orbState` is `inactive`, `error`, `standby`

**Key actions**:
- `resetAssistant()` — resets all assistant + chat state
- `resetChat()` — resets chat and voice state
- `updateSettings(newPartial)` — merges settings, shows toast
- `saveSettings(newPartial)` — calls `invoke("update_settings")` + `invoke("set_device_shared_secret")`

---

## 4. Layout System

**Single-window layout** (`ChatLayout.tsx`):

```
┌─────────────────────────────────────────┐
│              App.tsx (Shell)            │
│ ┌─────────────────────────────────────┐ │
│ │         ChatLayout.tsx              │ │
│ │ ┌──────────┬──────────────────────┐ │ │
│ │ │ Sidebar  │    Chat Area         │ │ │
│ │ │ (250px)  │                      │ │ │
│ │ │          │ ┌──────────────────┐ │ │ │
│ │ │ History  │ │    ChatView      │ │ │ │
│ │ │          │ │   Messages...    │ │ │ │
│ │ │          │ ├──────────────────┤ │ │ │
│ │ │          │ │  Input Area      │ │ │ │
│ │ │          │ └──────────────────┘ │ │ │
│ │ ├──────────┴──────────────────────┤ │ │
│ │ │        Orb Area (180px)         │ │ │
│ │ │   Assistant.tsx (3D Canvas)     │ │ │
│ │ └─────────────────────────────────┘ │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

- `gridTemplateColumns`: `sidebarOpen ? "250px 1fr" : "0px 1fr"`
- `gridTemplateRows`: `"1fr 180px"` (chat flex: 1, orb: 180px fixed)
- Mobile (`<768px`): sidebar overlays, orb height drops to 120px
- Settings window: 900×600, `title: "Apollo Configuration"`, tabs at top

---

## 5. Tauri Commands (Frontend ↔ Rust)

| Command | Direction | Signature | Purpose |
|---------|-----------|-----------|---------|
| `greet` | FE → Rust | `(name: string) → string` | Test command |
| `get_settings` | FE → Rust | `() → SettingsPayload` | Load settings from JSON file |
| `update_settings` | FE → Rust | `(newSettings: SettingsPayload) → SettingsPayload` | Merge-update settings, preserve DEVICE_SHARED_SECRET |
| `set_api_key` | FE → Rust | `(provider, apiKey) → void` | Save API key for provider |
| `set_device_shared_secret` | FE → Rust | `(secret: string) → void` | Set device secret (guarded: log-only, no overwrite) |
| `get_device_shared_secret` | FE → Rust | `() → string` | Get device secret |
| `start_sidecar` | FE → Rust | `() → void` | Start Python sidecar |
| `stop_sidecar` | FE → Rust | `() → void` | Stop Python sidecar |
| `start_pcbridge` | FE → Rust | `() → void` | Start PcBridge |
| `start_cloud_core` | FE → Rust | `() → void` | Start CloudCore |
| `send_command` | FE → Rust | `(command: string, args?) → SidecarResponse` | Send command to Python sidecar |
| `invoke` | FE → Rust | `(plugin, cmd, args?) → any` | Generic Tauri invoke |
| `process_voice_command` | FE → Rust | `(command: string) → void` | Voice command processor |
| `voice_start_listening` | FE → Rust | `() → void` | Start voice listening |
| `voice_stop_listening` | FE → Rust | `() → void` | Stop voice listening |
| `voice_send_audio` | FE → Rust | `(data: string) → void` | Send audio to backend |
| `voice_send_text` | FE → Rust | `(text: string) → void` | Send text as voice input |
| `voice_get_status` | FE → Rust | `() → VoiceStatus` | Get voice subsystem status |
| `send_llm_prompt` | FE → Rust | `(prompt: string) → void` | Send prompt to LLM |
| `voice` | FE → Rust | `(action: string) → any` | Voice plugin generic |
| `execute_agent_tool` | FE → Rust | `(agentId, toolName, args) → any` | Execute agent tool |
| `get_agents` | FE → Rust | `() → Agent[]` | List configured agents |
| `update_agent` | FE → Rust | `(agent: Agent) → void` | Update agent config |
| `get_mcp_tools` | FE → Rust | `(serverName?) → McpTool[]` | List MCP tools |
| `list_mcp_servers` | FE → Rust | `() → McpServerInfo[]` | List MCP servers |
| `start_mcp_server` | FE → Rust | `(name, command?, args?, env?) → void` | Start MCP server |
| `stop_mcp_server` | FE → Rust | `(name) → void` | Stop MCP server |
| `get_mcp_tool_schema` | FE → Rust | `(toolName) → any` | Get MCP tool JSON schema |
| `execute_mcp_tool` | FE → Rust | `(toolName, args?) → any` | Execute MCP tool |
| `read_image_as_data_url` | FE → Rust | `(path) → string` | Read image file as data URL |

---

## 6. IPC Events (Rust → Frontend)

All emitted from Python sidecar, forwarded by `sidecar.rs`, listened in `App.tsx`.

| Event | Payload | Handler |
|-------|---------|---------|
| `assistant:status` | `{ status: string }` | `AssistantStatus` — `idle`, `thinking`, `responding`, `done` |
| `assistant:state` | `{ status: string, provider: string, timestamp: number }` | `AssistantState` — updates orb, model info |
| `assistant:response` | `{ content: string, done: boolean, provider: string, model: string, timestamp: number }` | `AssistantResponse` — appends text chunks to message |
| `assistant:answer` | `{ text: string, provider: string, model: string }` | `AssistantAnswer` — stores full response for later append |
| `assistant:tool` | `{ tool: string, args: object, result: any }` | `AssistantTool` — tool execution display |
| `assistant:tool-result` | `{ id, name, status, duration_ms, result }` | `AssistantToolResult` — updates pending commands |
| `assistant:token` | `{ text: string, tokens_per_second: number, provider: string, model: string }` | `AssistantToken` — streams tokens, calculates TPS |
| `assistant:thinking-delta` | `{ text: string, tokens_per_second: number, provider: string, model: string }` | `AssistantThinkingDelta` — thinking bubble content |
| `assistant:thinking-start` | `{ provider: string, model: string, timestamp: number }` | `AssistantThinkingStart` — shows thinking bubble |
| `assistant:thinking-end` | `{ timestamp: number }` | `AssistantThinkingEnd` — hides thinking bubble |
| `assistant:final` | `{ text: string, provider: string, model: string, tokens_per_second: number, tool_calls_count: number }` | `AssistantFinal` — adds complete response to messages |
| `assistant:error` | `{ error: string, timestamp: number }` | `AssistantError` — error toast, resets thinking |
| `assistant:latency` | `{ latency_ms: number, timestamp: number }` | `AssistantLatency` — updates latency display |
| `assistant:connected` | `{ timestamp: number }` | `AssistantConnected` — sets status to connected |
| `assistant:disconnected` | `{ timestamp: number, reason?: string }` | `AssistantDisconnected` — clears answer buffer |
| `assistant:heartbeat` | `{ timestamp: number }` | `AssistantHeartbeat` — updates `lastHeartbeat` in store |
| `assistant:ready` | `{ timestamp: number }` | `AssistantReady` — marks model as loaded |
| `assistant:welcome` | `{ text: string }` | `AssistantWelcome` — adds welcome message |
| `assistant:settings-update` | `{ provider, model, url, apiKeySet, timestamp }` | `AssistantSettingsUpdate` — syncs provider info |
| `assistant:settings-changed` | `{ model, provider, url, apiKeySet, timestamp }` | `AssistantSettingsChanged` — updates model/provider |
| `assistant:llm-error` | `{ error: string, provider, timestamp }` | `AssistantLlmError` — shows LLM error in chat |
| `assistant:llm-start` | `{ provider, model, timestamp }` | `AssistantLlmStart` — clears thinking, shows responding |
| `assistant:llm-end` | `{ provider, model, duration_ms, timestamp }` | `AssistantLlmEnd` — shows completed response |
| `assistant:prompt-sent` | `{ timestamp }` | `AssistantPromptSent` — marks prompt sent |
| `assistant:text-chunk` | `{ text: string, done: boolean }` | `AssistantTextChunk` — appends streaming text |
| `pcbridge:status` | `{ status: string, connected?: boolean, timestamp }` | `PcBridgeStatus` — updates orbColor, bridge status |
| `pcbridge:device-info` | `{ device_id, name, model, timestamp }` | `PcBridgeDeviceInfo` — device metadata |
| `pcbridge:disconnected` | `{ timestamp }` | `PcBridgeDisconnected` — resets bridge status |
| `pcbridge:connected` | `{ timestamp }` | `PcBridgeConnected` — updates connected state |
| `pcbridge:ready` | `{ timestamp }` | `PcBridgeReady` — marks ready |
| `pcbridge:notification` | `{ title, message, level, timestamp }` | `PcBridgeNotification` — shows notification |
| `pcbridge:pair-success` | `{ timestamp }` | `PcBridgePairSuccess` — pair success notification |
| `pcbridge:pair-error` | `{ timestamp }` | `PcBridgePairError` — pair error notification |
| `voice:status` | `{ active: boolean, mode?: string, timestamp }` | `VoiceStatusEvent` — updates voice state |
| `voice:listening-start` | `{ timestamp }` | `VoiceListeningStart` — sets orb to `listening` |
| `voice:listening-stop` | `{ timestamp }` | `VoiceListeningStop` — resets orb state |
| `voice:transcript` | `{ text: string, is_final: boolean, confidence? }` | `VoiceTranscript` — STT partial/final text |
| `voice:transcript-partial` | `{ text: string }` | `VoiceTranscriptPartial` — partial STT text |
| `voice:transcript-final` | `{ text: string }` | `VoiceTranscriptFinal` — final STT text |
| `voice:wake-detected` | `{ word: string, timestamp }` | `VoiceWakeDetected` — wake word detected |
| `voice:command-processed` | `{ command: string, timestamp }` | `VoiceCommandProcessed` — command processed |
| `voice:response` | `{ text, confidence, timestamp }` | `VoiceResponse` — voice response received |
| `voice:audio-level` | `{ level: number, timestamp }` | `VoiceAudioLevel` — audio level meter |
| `voice:timeout` | `{ reason, timestamp }` | `VoiceTimeout` — listening timeout |
| `voice:speak-start` | `{ text, provider, timestamp }` | `VoiceSpeakStart` — TTS starting |
| `voice:speak-end` | `{ timestamp }` | `VoiceSpeakEnd` — TTS finished |
| `voice:audio-play` | `{ url: string, timestamp }` | `VoiceAudioPlay` — plays audio URL |
| `voice:audio-complete` | `{ timestamp }` | `VoiceAudioComplete` — audio playback complete |
| `voice:audio-error` | `{ error, timestamp }` | `VoiceAudioError` — audio error |
| `voice:provider` | `{ provider, timestamp }` | `VoiceProvider` — TTS provider info |
| `voice:stream-start` | `{ timestamp }` | `VoiceStreamStart` — streaming audio start |
| `voice:stream-chunk` | `{ timestamp }` | `VoiceStreamChunk` — streaming audio chunk |
| `voice:stream-end` | `{ timestamp }` | `VoiceStreamEnd` — streaming audio end |
| `voice:audio-data` | `{ data: string, timestamp }` | `VoiceAudioData` — base64 audio data |
| `ui_state` | `{ state: string }` | `UiStateEvent` — maps to `orbState` (`active`/`listening`/`thinking`/`busy`/`inactive`) |
| `command` | `{ command: string, payload: any }` | `CommandEvent` — generic command routing |

---

## 7. IPC Events (Frontend → Rust)

None. The frontend communicates exclusively via `invoke()` commands. No `emit()` calls from the frontend.

---

## 8. Settings Model & Persistence

### Rust Struct (`AppSettings`)

```rust
pub struct AppSettings {
    pub ai: AiSettings,                    // provider, apiKey, customApiUrl, customApiKey
    pub mode: ModeSettings,                // enableCloudCore (default: true)
    pub voice: VoiceSettings,              // enabled (default: true), provider (default: "gemini")
    pub orb: OrbSettings,                  // color, glow, voice (all unused)
    pub theme: ThemeSettings,              // background: "#0a0a0f", accent: "#00d4ff"
    pub pcbridge: PcBridgeSettings,        // autoConnect, deviceName, pairCode, showNotifications
    pub cloudcore: CloudCoreSettings,      // enabled (default: true)
    pub cloud: CloudSettings,              // enabled (default: true)
    pub localAssistant: LocalAssistantSettings, // enabled, model, ollamaUrl, autoDiscover
    pub agents: AgentSettings,             // agent list, max concurrent, permissions
    pub gateway: GatewaySettings,          // mode: "proxy", enabled: true
    pub version: Option<String>,           // "0.1.1"
}
```

### Frontend Payload (`SettingsPayload`)

```typescript
interface SettingsPayload {
  provider?: string;        // "gemini" | "llamacpp" | "openai"
  customApiUrl?: string;
  customApiKey?: string;
  gemini?: { apiKey?: string };
  mode?: string;            // "local" | "cloud"
  voice?: boolean;
  voiceMode?: string;
  ttsProvider?: string;     // "aura2"
  pcbridge?: boolean;
  agentName?: string;
  orbColor?: string;
  orbGlow?: boolean;
  orbVoice?: boolean;
  background?: string;
  accent?: string;
}
```

### Persistence Flow

1. File: `C:\Users\Admin\AppData\Roaming\com.apollo.desktop\settings.json`
2. Load: `AppSettings::load()` on startup. Creates defaults if missing. Migration from `0.1.0` format.
3. Save: `update_settings` command → merge → `save()` to disk.
4. `set_device_shared_secret`: Guarded command. Logs but never overwrites existing secret.
5. `deviceSharedSecret`: Persisted per-device device identifier. Must NEVER be logged or exposed.

### Default Settings

```json
{
  "ai": { "provider": "gemini", "apiKey": "" },
  "mode": { "enableCloudCore": true },
  "voice": { "enabled": true, "provider": "gemini" },
  "theme": { "background": "#0a0a0f", "accent": "#00d4ff" },
  "pcbridge": { "autoConnect": true, "showNotifications": true },
  "cloudcore": { "enabled": true },
  "cloud": { "enabled": true },
  "localAssistant": { "enabled": false },
  "gateway": { "mode": "proxy", "enabled": true },
  "version": "0.1.1"
}
```

---

## 9. Tauri Permissions

Configured in `apps/desktop/src-tauri/capabilities/default.json`:

```
core:default
core:event:default
core:window:allow-create
core:window:allow-set-focus
core:window:allow-close
core:window:allow-hide
core:window:allow-show
core:window:allow-center
core:window:allow-request-user-attention
core:window:allow-set-resizable
core:window:allow-set-maximizable
core:window:allow-set-minimizable
core:window:allow-set-decorations
core:window:allow-set-content-protected
core:window:allow-set-skip-taskbar
core:window:allow-set-always-on-top
core:window:allow-set-fullscreen
core:window:allow-set-size
core:window:allow-set-position
core:window:allow-set-min-size
core:window:allow-set-max-size
core:webview:default
core:webview:allow-create-webview
core:webview:allow-create-webview-window
core:webview:allow-set-webview-focus
core:path:default
shell:allow-execute
shell:allow-spawn
shell:allow-kill
shell:allow-read-stdio
shell:allow-write-stdio
shell:allow-stdin-write
shell:allow-stdout-read
shell:allow-stderr-read
shell:allow-stdin-close
shell:allow-configure
shell:allow-rename
shell:default
shell:allow-open
plugin:event:default
plugin:event:allow-emit
plugin:event:allow-listen
plugin:event:allow-emit-to
plugin:fs:default
plugin:fs:allow-read
plugin:fs:allow-write
plugin:fs:allow-exists
plugin:fs:allow-mkdir
plugin:fs:allow-remove
plugin:fs:allow-rename
plugin:fs:allow-copy-file
plugin:fs:allow-stat
plugin:fs:allow-read-dir
plugin:fs:allow-appended-read
plugin:path:default
```

---

## 10. CSS Architecture

**No CSS framework.** 20 CSS files, all hand-written.

| File | Purpose | Notable |
|------|---------|---------|
| `index.css` | Global reset, scrollbar styles, keyframes (`fadeIn`, `float`, `pulse`, `slideIn`, `orbPulse`) | 235 lines |
| `App.css` | App shell, layout grid, settings panel | 731 lines |
| `Chat.css` | Chat container, messages, scrollbar | 423 lines |
| `ChatView.css` | Chat view layout, welcome state | 244 lines |
| `ChatInput.css` | Input area, suggestions bar, button styling | 598 lines |
| `MessageItem.css` | Message bubbles, animations, metadata | 222 lines |
| `History.css` | History list and items | 151 lines |
| `Assistant.css` | Orb layout, status panel, debug panel | 225 lines |
| `VoiceButton.css` | Voice button states, animations | 242 lines |
| `Settings.css` | Settings window, tabs, panels, inputs | 524 lines |
| `SettingsPanel.css` | Alternate settings panel layout | 215 lines |
| `Card.css` | Card components | 37 lines |
| `Input.css` | Input fields | 104 lines |
| `Modal.css` | Dialog modals | 125 lines |
| `Select.css` | Dropdown selects | 101 lines |
| `StatusBadge.css` | Status badges | 147 lines |
| `WakeWordIndicator.css` | Wake word detection animation | 95 lines |
| `ThinkingBubble.css` | Thinking bubble animation | 103 lines |
| `TypingBubble.css` | Typing indicator | 75 lines |
| `AgentManager.css` | Agent manager view | (in AgentManagerView.tsx) |

---

## 11. Key UI Flows

### Startup Sequence

1. `App.tsx` mounts → `initializeSidecar()` runs immediately (no conditions)
2. `startSidecar()` → `invoke("start_sidecar")` → spawns `python.exe` child process
3. `loadSettings()` → `invoke("get_settings")` → reads JSON file → `setAppSettings()`
4. If `!settings.ai.apiKey`: `setShowWelcome(true)` → WelcomeScreen appears
5. If settings loaded successfully: `setShowSettings(false)` → main chat view
6. If sidecar fails: sets `sidecarStatus: 'error'`, `showWelcome: true`
7. `attachEventListeners()` subscribes to all IPC events
8. `setupAutoRecovery()` checks sidecar status every 5s when not connected
9. `setupKeybindListener()` registers Cmd/Ctrl+K and Escape shortcuts
10. `startPcbridgeReconnect()` checks every 30s if PCBridge should reconnect

### Orb State Transitions

```
Python emits "ui_state" event with state field:
  "active"    → Orb: active    (pulsing cyan glow)
  "listening" → Orb: listening (cyan glow, wider pulse)
  "thinking"  → Orb: thinking  (fast rotation, dim cyan glow)
  "busy"      → Orb: busy      (slow pulse, brighter cyan glow)
  "inactive"  → Orb: inactive  (dim, no glow)

AssistantStatus "thinking" → Orb: thinking
AssistantStatus "responding" → Orb: active
AssistantStatus "idle" → Orb: inactive
AssistantStatus "error" → Orb: error
PcBridgeStatus "connected" → orbColor: "#ffd700"
```

### Voice Flow

1. User presses VoiceButton → `invoke("voice_start_listening")` or `invoke("voice_stop_listening")`
2. Python `client.py` handles `start_listening` → stops wake detector, starts STT
3. Python emits `ui_state { state: "listening" }` → orb pulses cyan
4. STT partial results → `voice:transcript-partial` event → `sttPartial` in store
5. STT final result → `voice:transcript-final` event → `sttFinal` in store
6. LLM prompt sent → Python emits `assistant:thinking-start` → orb: thinking
7. LLM response chunks → `assistant:token` events → streaming display
8. LLM done → `assistant:final` event → message added to chat
9. TTS audio played → `voice:audio-play` event → audio element
10. Wake detector restarts → ready for next wake word

### Chat Flow

1. User types in ChatInput → `setInputText()`
2. User presses Enter → `handleSendMessage()` runs
3. If empty or loading → return
4. `addMessage({ role: "user", content })` → added to `messages[]`
5. `setIsLoading(true)` → `setAssistantStatus("thinking")`
6. `invoke("send_llm_prompt", { prompt })` → Python receives prompt
7. Python sends to LLM provider → streams tokens back
8. Tokens appended to `currentMessage` via `AssistantToken` handler
9. `AssistantFinal` handler → `addMessage({ role: "assistant", content })` + `setIsLoading(false)`
10. Auto-scroll to bottom via `scrollToBottom()`

---

## 12. Orb State Machine

### State Mapping (Python → Frontend)

| Python `ui_state` | Frontend `orbState` | Visual |
|-------------------|---------------------|--------|
| `"active"` | `"active"` | Pulsing cyan glow |
| `"listening"` | `"listening"` | Cyan glow, wider pulse |
| `"thinking"` | `"thinking"` | Fast rotation, dim glow |
| `"busy"` | `"busy"` | Slow pulse, bright glow |
| `"inactive"` | `"inactive"` | Dim, no glow |
| (error) | `"error"` | Red/dim state |

### State Derivation

`isOrbActive(assistant)`: returns `true` if `orbState` is `active`, `busy`, `thinking`, or `listening`
`isOrbInactive(assistant)`: returns `true` if `orbState` is `inactive`, `error`, or `standby`

### Orb Component (`Assistant.tsx`)

- Three.js canvas: 440px × 440px (320px on mobile)
- `<Orb />` component renders the 3D sphere with shaders
- Click: toggles settings panel
- Hover/touch: shows status panel (model info, latency, GPU)
- Debug panel: Tauri commands, sidecar status, keybinds (toggle with Ctrl+Shift+D)
- Status bar: model name, token count, latency, sidecar status, orb state

---

## 13. WebSocket / Local Server

**No WebSocket used.** IPC is entirely Tauri event-based.

- Python sidecar communicates via `stdin`/`stdout` (JSON protocol)
- `sidecar.rs` manages child process I/O
- Events emitted from Rust to frontend via `app.emit()`
- No external HTTP server, no WebSocket, no polling

---

## 14. Sidecar Management

### Python Sidecar (`python.exe`)

- Path: `src-tauri/resources/juana-client/run_client.exe` (build) or `juana_client/client.py` (dev)
- Spawned by `sidecar.rs` via `tauri_plugin_shell::Shell::sidecar()`
- Protocol: JSON over stdin/stdout, `{"type":"...", ...}` messages
- Health check: 2-second timeout on stdin writes

### CloudCore (Node.js)

- Path: `src-tauri/resources/cloudcore/server.js`
- Spawned via `app.shell().sidecar("cloudcore")`
- `startCloudCore()` → checks if already connected → spawns if not
- Emits `cloudcore:started` on success

### PcBridge (Node.js)

- Path: `src-tauri/resources/pcbridge/pcbridge.mjs`
- Spawned via `app.shell().sidecar("pcbridge")`
- `startPcbridge()` → checks if already connected → spawns if not
- Auto-reconnect: every 30s if not connected and settings enabled
- Pairing: `settings.pairs.deviceSharedSecret` persisted per device
- Pair code: `settings.pcbridge.pairCode` (user enters on Android side)

### Auto-Recovery

- `setupAutoRecovery()` in `App.tsx`: checks sidecar status every 5s when not connected
- `startPcbridgeReconnect()`: checks every 30s if PCBridge should reconnect

---

## 15. Type Definitions

### Core Types (`store/types.ts`)

```typescript
type OrbState = "inactive" | "active" | "listening" | "thinking" | "busy" | "error" | "standby"
type AssistantStatus = "initializing" | "ready" | "thinking" | "responding" | "idle" | "error"
type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error"
type SidecarStatus = "stopped" | "starting" | "running" | "error"
type VoiceMode = "off" | "manual" | "wake"
type VoiceStatus = "idle" | "listening" | "processing" | "speaking" | "error"
```

### Message Type

```typescript
interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  timestamp: number
  status?: "sending" | "sent" | "delivered" | "error"
  provider?: string
  model?: string
  tool?: string
  error?: string
  metadata?: { [key: string]: any }
}
```

### Settings Types (`store/settings.ts`)

- `AiSettings`: `{ provider, apiKey, customApiUrl?, customApiKey? }`
- `ModeSettings`: `{ enableCloudCore }`
- `VoiceSettings`: `{ enabled, provider }`
- `OrbSettings`: `{ color, glow, voice }`
- `ThemeSettings`: `{ background, accent }`
- `PcBridgeSettings`: `{ autoConnect, deviceName, pairCode, showNotifications }`
- `CloudCoreSettings`: `{ enabled }`
- `CloudSettings`: `{ enabled }`
- `LocalAssistantSettings`: `{ enabled, model, ollamaUrl, autoDiscover }`
- `AgentSettings`: `{ agents, maxConcurrent, permissions }`
- `GatewaySettings`: `{ mode, enabled }`

---

## 16. Window Configuration

| Property | Value |
|----------|-------|
| Label | `"main"` |
| Title | `"Apollo"` |
| Dimensions | Width: 1000, Height: 650 |
| Min Size | 800 × 600 |
| Decorations | `false` (custom title bar) |
| Transparent | `false` |
| Resizable | `true` |
| Always on Top | `false` |
| Center | `true` |
| Single Instance | `true` (via `tauri-plugin-single-instance`) |

Settings window: 900×600, `title: "Apollo Configuration"`, tabs at top.

---

## 17. Entry Point & Build

### Entry Point

`apps/desktop/ui/src/main.tsx` → `createRoot(document.getElementById("root")!)` → `<App />`

### Build Commands

```bash
# Frontend only
cd apps/desktop/ui
npm run build          # Vite build → dist/
npm run dev            # Vite dev server on :5173

# Full Tauri build
cd apps/desktop
cargo tauri build      # Produces NSIS installer + MSI

# Environment (Windows, avoid OOM)
$env:CARGO_BUILD_JOBS = "2"
$env:RUSTFLAGS = "-C link-arg=/STACK:0x10000000"
```

### Output

- `target/release/bundle/nsis/` → NSIS installer (67 MB)
- `target/release/bundle/msi/` → MSI installer (87 MB)

---

## 18. Legacy / Dead Code

| File | Status |
|------|--------|
| `src/components/Layout/SplitViewLayout.tsx` | **Unused.** Alternate layout with SplitView. Not imported anywhere. |
| `src/components/Layout/SplitView.module.css` | **Unused.** Corresponding CSS module for SplitViewLayout |
| `src/components/Assistant/AssistantControls.tsx` | **Unused.** Legacy AssistantControls component |
| `src/components/Assistant/AssistantControls.css` | **Unused.** Corresponding CSS |
| `src/components/Assistant/Orb.tsx` | **Unused.** Alternate Orb component |
| `src/components/Assistant/Orb.css` | **Unused.** Corresponding CSS |
| `src/components/Assistant/AssistantDebug.tsx` | **Unused.** Legacy debug component |
| `src/components/Assistant/AssistantDebug.css` | **Unused.** Corresponding CSS |
| `src/components/Assistant/AssistantOverlay.tsx` | **Unused.** Legacy overlay component |
| `src/components/Assistant/AssistantOverlay.css` | **Unused.** Corresponding CSS |
| `src/components/Assistant/AssistantPromptBar.tsx` | **Unused.** Legacy prompt bar |
| `src/components/Assistant/AssistantPromptBar.css` | **Unused.** Corresponding CSS |
| `src/components/Assistant/AssistantStatus.tsx` | **Unused.** Legacy status panel |
| `src/components/Assistant/AssistantStatus.css` | **Unused.** Corresponding CSS |
| `src/components/Assistant/AssistantWelcome.tsx` | **Unused.** Legacy welcome screen |
| `src/components/Assistant/AssistantWelcome.css` | **Unused.** Corresponding CSS |
| `src/components/Assistant/SimpleOrb.tsx` | **Unused.** Alternate simple orb |
| `src/components/Assistant/SimpleOrb.css` | **Unused.** Corresponding CSS |
| `src/components/Chat/ChatWindow.tsx` | **Unused.** Alternate chat window |
| `src/components/Chat/WelcomeScreen.tsx` | **Unused.** Alternate welcome screen |
| `src/components/Settings/SettingsButton.tsx` | **Unused.** Settings toggle button |
| `src/components/Settings/SettingsButton.module.css` | **Unused.** Corresponding CSS module |
| `src/components/Settings/StatusIndicator.tsx` | **Unused.** Status indicator component |
| `src/components/Settings/StatusIndicator.module.css` | **Unused.** Corresponding CSS module |
| `src/components/UI/SettingsPanel.tsx` | **Unused.** Alternate settings panel |
| `src/hooks/useAssistant.ts` | **Unused.** Alternate assistant hook |
| `src/hooks/useSettings.ts` | **Unused.** Alternate settings hook |
| `src/lib/assistant.ts` | **Unused.** Legacy assistant utilities |
| `src/lib/types.ts` | **Unused.** Legacy type definitions |
| `src/store/types.ts` | **Partially unused.** Defines `Agent` and `AppSettings` types, but `AppSettings` is not used by the actual store |

**Total: ~30 unused files, ~4500+ lines of dead code**

---

## 19. Hook Dependencies

| Hook | Used By | Calls |
|------|---------|-------|
| `useAssistant()` | `Assistant.tsx` | `useEffect()` × 4, `useState()` × 4 |
| `useLocalAssistant()` | `Assistant.tsx` | `useState()`, `useEffect()` |
| `useSettings()` | `SettingsWindow.tsx`, `ChatLayout.tsx`, `ChatInput.tsx`, `WelcomeScreen.tsx` | `useState()`, `useEffect()`, `useCallback()` |
| `useVoice()` | `ChatView.tsx`, `Assistant.tsx` | `useState()`, `useEffect()`, `useRef()`, `useCallback()`, `useMemo()` |
| `useVoiceManager()` | `Assistant.tsx` | `useState()`, `useEffect()`, `useRef()`, `useMemo()` |
| `useWakeWord()` | `Assistant.tsx`, `ChatView.tsx` | `useState()`, `useEffect()`, `useRef()`, `useMemo()` |
| `useWindowControls()` | `App.tsx` | `useState()`, `useEffect()`, `useCallback()` |
| `usePcBridge()` | `App.tsx` | `useState()`, `useEffect()`, `useCallback()`, `useRef()` |
| `useTauri()` | `App.tsx`, `Assistant.tsx`, `ChatView.tsx` | `invoke()`, `listen()`, `emit()` |
| `useAutoScroll()` | `ChatView.tsx` | `useRef()`, `useEffect()`, `useCallback()` |
| `useTheme()` | `App.tsx` | `useState()`, `useEffect()` |
| `useLocalStorage()` | `useAssistant.ts` | `useState()`, `useEffect()` |

---

## 20. Component Hierarchy

```
<StrictMode>
  <App>                              ← Root shell
    ├─ <WelcomeScreen />             ← First-run wizard (conditional)
    ├─ <SettingsWindow />            ← Settings panel (conditional)
    └─ <ChatLayout>                  ← Main single-window layout
        ├─ <SideMenu>                ← Embedded sidebar (not imported Sidebar.tsx)
        │   ├─ <header>             ← User avatar + name
        │   ├─ <nav>                ← New Chat, History
        │   └─ <footer>             ← Agent selector dropdown
        ├─ <ChatView>                ← Chat interface
        │   ├─ <AssistantDebug />    ← Inline debug (not imported AssistantDebug.tsx)
        │   ├─ <div.messages>
        │   │   └─ <MessageItem />   ← Message bubbles
        │   ├─ <ChatInput />         ← User input area
        │   ├─ <ThinkingBubble />    ← AI thinking indicator
        │   ├─ <WakeWordIndicator /> ← Wake word detection animation
        │   └─ <VoiceButton />       ← Mic toggle
        └─ <Assistant />             ← Orb 3D component
            ├─ <canvas> (Three.js)   ← Orb renderer
            ├─ <div.status-bar>      ← Model + tokens + latency + sidecar
            ├─ <div.debug-panel>     ← Debug info (toggleable)
            ├─ <div.status-panel>    ← Hover details
            ├─ <ThinkingBubble />    ← Thinking indicator
            └─ <PcBridgeStatusBanner /> ← Bridge status
```

---

## 21. File System & Asset References

### Build Resources

- `src-tauri/resources/juana-client/` — Python sidecar (bundled via `bundle-resources.mjs`)
- `src-tauri/resources/cloudcore/` — CloudCore server (bundled)
- `src-tauri/resources/pcbridge/` — PcBridge server (bundled)
- `ui/public/` — Static assets (favicon)

### Settings File Location

```
%APPDATA%\com.apollo.desktop\settings.json
```

### Tauri Config

```
apps/desktop/src-tauri/tauri.conf.json
```

### Build Output

```
apps/desktop/target/release/bundle/nsis/  → NSIS installer
apps/desktop/target/release/bundle/msi/   → MSI installer
apps/desktop/target/release/              → Binary executable
```

### Bundle Resources Script

```
apps/desktop/bundle-resources.mjs
```
Copies from `../../juana-client/` (repo root) → staging → Tauri bundler.

---

## 22. Responsive Behavior

### Breakpoints

- **Desktop** (≥768px): Full layout, sidebar, orb at 180px
- **Mobile** (<768px): Sidebar overlays, orb shrinks to 120px, compact chat

### Orb Size

- Desktop: 440px × 440px canvas
- Mobile: 320px × 320px canvas
- Container: `width: 100%; height: 100%; display: flex; justify-content: center; align-items: center`

### Chat Area

- Desktop: `flex: 1` (fills remaining space)
- Mobile: Full width, reduced padding

### Settings Window

- Fixed: 900×600 pixels
- No responsive behavior (Tauri window, not web)

---

## 23. Error Handling & Fallbacks

| Location | Error | Handling |
|----------|-------|----------|
| `App.tsx` `startSidecar()` | Sidecar fails | Sets `sidecarStatus: 'error'`, `showWelcome: true` |
| `App.tsx` `setupAutoRecovery()` | Sidecar not running | Retries every 5s |
| `SettingsWindow.tsx` `handleSave()` | `update_settings` fails | Shows error toast, falls back to local save |
| `SettingsWindow.tsx` `handleSave()` | `set_device_shared_secret` fails | Logs warning, continues (non-blocking) |
| `WelcomeScreen.tsx` `handleSave()` | `set_api_key` fails | Shows error toast |
| `ChatView.tsx` `handleSendMessage()` | Empty input or loading | Returns without action |
| `VoiceButton.tsx` `handleToggleVoice()` | No active listening session | Calls `voice_start_listening` instead of stop |
| `Assistant.tsx` | Orb component fails | `<div>Orb placeholder</div>` fallback |
| `App.tsx` `attachEventListeners()` | Event listener setup fails | Logs warning, continues |
| Python `audio.py` | PyAudio buffer overflow | `AudioBufferOverflowError` caught, `_audio_buffer = bytearray()` |
| Python `client.py` | MemoryError in STT | `MemoryError` caught separately, `_audio_buffer.clear()` |
| Python `client.py` | Wake word timeout | `_listen_timer` fires after 10s, calls `_finalize_listening()` |

---

## 24. Performance Considerations

- **Zustand** store: minimal re-renders via selector-based subscriptions
- **No memoization** in most components (no `React.memo`, no `useMemo` on renders)
- **`useCallback`** only in: `usePcBridge`, `useWakeWord`, `useVoiceManager`
- **`useMemo`** only in: `useVoiceManager`, `useVoice`, `useWakeWord`
- **Chat auto-scroll**: `scrollToBottom()` called on new messages via `useEffect`
- **Streaming tokens**: `AssistantToken` handler appends to `currentMessage` without re-rendering entire chat
- **Orb**: Three.js canvas with WebGL, hardware-accelerated
- **No virtualization** for chat messages (potential issue with very long conversations)
- **Python sidecar**: Single process, shared STT model (cached in memory)
- **Settings**: Loaded once on startup, saved on change (no debouncing)

---

## 25. Security Considerations

### Secrets & Keys

- `DEVICE_SHARED_SECRET`: Stored in `settings.json`. Never logged or exposed. Guarded by `set_device_shared_secret` (log-only, no overwrite).
- `INTERNAL_CORE_TOKEN`: `ii10NRVIAFt7JhfC1dlxiVP2D+rzUC71bx1BfhZgkFk=` — used for LocalAssistant auth. Never expose.
- API keys: Stored in `settings.json` under `ai.apiKey`. Not logged.
- `deviceSharedSecret`: Persisted per-device. Used for PCBridge pairing.

### Tauri Security

- All commands require explicit permission in `capabilities/default.json`
- Shell plugin permissions: `shell:allow-execute`, `shell:allow-spawn`, etc.
- No `unsafe` Rust code in app layer
- CSP: Not explicitly configured (Tauri default)
- Single-instance enforced via `tauri-plugin-single-instance`

### Python Sidecar

- Runs as child process with same user privileges
- stdin/stdout JSON protocol (no network exposure)
- No authentication between Tauri and Python (same machine)

---

## 26. Testing & Build

### Frontend

- **No test framework configured** (no Jest, Vitest, or Playwright)
- **No test files** in the codebase
- `package.json` has no `test` script
- Type checking: `npx tsc --noEmit` ✓

### Rust

- `apps/desktop/src-tauri/src/state.rs` has unit tests for settings load/save/migration
- `cargo test` blocked by OOM on `windows` crate compilation (pre-existing issue)
- Build: `cargo tauri build` ✓ → NSIS (67 MB) + MSI (87 MB)

### Linting

- No ESLint, Prettier, or Clippy configured
- TypeScript: `npx tsc --noEmit` for type checking only

---

## 27. Package Dependencies

### UI (`apps/desktop/ui/package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| `react` | ^19.2.3 | UI framework |
| `react-dom` | ^19.2.3 | DOM rendering |
| `@tauri-apps/api` | ^2.3.0 | Tauri IPC bridge |
| `@tauri-apps/plugin-dialog` | ^2.2.0 | Native dialogs |
| `@tauri-apps/plugin-fs` | ^2.2.0 | File system access |
| `@tauri-apps/plugin-shell` | ^2.2.0 | Shell commands |
| `@tauri-apps/plugin-store` | ^2.2.0 | Local storage |
| `zustand` | ^5.0.2 | State management |
| `three` | ^0.172.0 | 3D Orb rendering |
| `@types/three` | ^0.172.0 | Three.js types |

### Rust (`apps/desktop/src-tauri/Cargo.toml`)

| Crate | Version | Purpose |
|-------|---------|---------|
| `tauri` | 2.9.3 | Desktop framework |
| `tauri-plugin-shell` | 2 | Shell plugin |
| `tauri-plugin-dialog` | 2 | Dialog plugin |
| `tauri-plugin-fs` | 2 | FS plugin |
| `tauri-plugin-store` | 2 | Store plugin |
| `tauri-plugin-process` | 2 | Process plugin |
| `tauri-plugin-single-instance` | 2 | Single instance |
| `serde` | 1 | Serialization |
| `serde_json` | 1 | JSON |
| `tokio` | 1 | Async runtime |
| `reqwest` | 0.12 | HTTP client |
| `chrono` | 0.4 | Time handling |
| `dirs` | 6 | OS directories |
| `uuid` | 1 | UUID generation |
| `anyhow` | 1 | Error handling |
| `log` | 0.4 | Logging |
| `env_logger` | 0.11 | Env-based logging |

---

## 28. CSS Variables & Design Tokens

### Colors (from CSS files)

```css
:root {
  /* Primary */
  --primary: #00d4ff;
  --primary-hover: #00b8e6;
  --primary-dark: #0088cc;
  --primary-light: #4dd9ff;
  
  /* Backgrounds */
  --bg-primary: #0a0a0f;
  --bg-secondary: #12121a;
  --bg-tertiary: #1a1a2e;
  --bg-card: rgba(18, 18, 26, 0.8);
  --bg-card-hover: rgba(0, 212, 255, 0.1);
  
  /* Text */
  --text-primary: #ffffff;
  --text-secondary: #b0b0b0;
  --text-muted: #666666;
  
  /* Borders */
  --border-primary: rgba(0, 212, 255, 0.2);
  --border-secondary: rgba(255, 255, 255, 0.1);
  
  /* Status */
  --success: #4caf50;
  --warning: #ff9800;
  --error: #f44336;
  
  /* Gold accent (PCBridge) */
  --gold: #ffd700;
  --gold-dark: #daa520;
  
  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 10px 25px rgba(0, 0, 0, 0.5);
}
```

### Spacing

No formal spacing system. Inline values throughout: `4px`, `8px`, `12px`, `16px`, `20px`, `24px`, `32px`, `40px`, `48px`, `64px`.

### Border Radius

No formal system. Inline values: `4px`, `6px`, `8px`, `12px`, `16px`, `20px`, `50%`.

---

## 29. Component Responsibilities

### `App.tsx`
- Root shell. Single-window layout, initializes sidecar, auto-recovery, keybind listener, PCBridge reconnect. Routes between WelcomeScreen, SettingsWindow, and main Chat view.

### `Assistant.tsx`
- Orb 3D assistant. Hosts Three.js canvas, click/hover/touch handlers, status bar (model, tokens, latency, sidecar status), debug panel, status panel, thinking bubble, PCBridge status banner. **1260 lines, most complex component.**

### `ChatView.tsx`
- Main chat interface. Message rendering, input, sidebar toggle. Has embedded `SideMenu` component (does NOT import `Sidebar.tsx`).

### `ChatInput.tsx`
- User input area. Text input, suggestions bar, send button, voice button.

### `MessageItem.tsx`
- Single message bubble. User or assistant message, metadata, tool results, error display.

### `SettingsWindow.tsx`
- Full settings panel. Tabs: General, AI, PCBridge, Agents, Dev. **~900 lines.**

### `WelcomeScreen.tsx`
- First-run wizard. Validates Gemini API key, calls Tauri `set_api_key`.

### `VoiceButton.tsx`
- Mic toggle button with pulsing animation. Calls `start_listening`/`stop_listening`.

### `WakeWordIndicator.tsx`
- Pulsing ring animation when wake word detected.

### `ThinkingBubble.tsx`
- "Assistant is thinking..." indicator with typing animation.

### `HistoryList.tsx` / `HistoryItem.tsx`
- Previous chat sessions list and individual entry.

---

## 30. Orb 3D Component

### `Orb.tsx` (in `components/Assistant/Orb.tsx`)

- **NOT USED** — this is the legacy/unused version
- The actual orb is inline in `Assistant.tsx` using Three.js directly

### Actual Orb Implementation (in `Assistant.tsx`)

```tsx
<Orb
  size={isMobile ? 320 : 440}
  state={assistant.orbState}
  color={assistant.orbColor || orbColor || "#00d4ff"}
  glowIntensity={assistant.orbGlow ? 1.0 : 0.3}
  isSpeaking={assistant.isSpeaking}
/>
```

- Three.js canvas: `width: isMobile ? 320 : 440`, `height: isMobile ? 320 : 440`
- WebGL renderer with antialias
- Orbit controls for rotation
- Responsive: smaller on mobile
- State-driven: color, glow, rotation speed change with `orbState`

---

## 31. Voice System Architecture

### Hooks

| Hook | Purpose | State |
|------|---------|-------|
| `useVoice()` | Voice plugin integration | `isListening`, `isSpeaking`, `audioLevel`, `transcript`, `error` |
| `useVoiceManager()` | Voice state machine | `isListening`, `isSpeaking`, `isWakeWordEnabled`, `currentProvider` |
| `useWakeWord()` | Wake word detection | `wakeActive`, `wakeMode`, `wakeWords`, `isListening` |

### Voice Flow

1. **Wake Word Detection**: Python `wake.py` → `VoskWakeWordDetector` listens for "apollo" / "hey apollo"
2. **Wake Detected**: Python emits `voice:wake-detected` → frontend sets `orbState: "listening"`
3. **STT Processing**: Python `client.py` → `audio.py` captures audio → `speech_recognition` → partial/final results
4. **LLM Prompt**: Final transcript sent as prompt → `assistant:thinking-start` → orb: thinking
5. **LLM Response**: Token streaming → `assistant:token` events → message display
6. **TTS**: Aura-2 TTS → `voice:audio-play` → audio element plays response
7. **Wake Detector Restart**: After finalize, wake detector recreated for next detection

### Providers

- **Wake Word**: `vosk` (Python) or `manual` (frontend toggle)
- **STT**: `speech_recognition` with `vosk` model (Python)
- **TTS**: `aura2` (Cloudflare Aura-2 via Python `tts.py`)
- **LLM**: Configurable (`gemini`, `llamacpp`, `openai`)

---

## 32. Chat System

### Message Store

```typescript
messages: Message[]        // All messages in current session
inputText: string          // Current input
inputFocused: boolean     // Input focus state
chatId: string            // Current chat ID
chatSessionId: string     // Session ID
selectedModel: string     // Selected model
isLoading: boolean        // Waiting for response
isConnected: boolean      // Backend connected
assistantStatus: AssistantStatus  // idle/thinking/responding/error
```

### Message Flow

1. User types → `setInputText()`
2. Enter → `handleSendMessage()` → `addMessage({ role: "user" })`
3. `invoke("send_llm_prompt", { prompt })` → Python receives
4. Python streams tokens → `assistant:token` → `currentMessage` updated
5. `assistant:final` → `addMessage({ role: "assistant" })` → `setIsLoading(false)`
6. Auto-scroll via `useAutoScroll()` hook

### Chat Features

- Markdown rendering via `dangerouslySetInnerHTML`
- Tool results displayed inline
- Error messages with retry
- Streaming token display
- Thinking bubble with animation
- Auto-scroll to bottom
- Keyboard shortcuts: Cmd/Ctrl+K (focus input), Escape (close panels)

---

## 33. Settings System

### Tabs

1. **General**: Theme, agent name, PCBridge toggle
2. **AI**: Provider selection, API key, custom URL, model selection
3. **PCBridge**: Device pairing, auto-connect, notifications
4. **Agents**: Agent configuration, permissions
5. **Dev**: Debug info, sidecar status, keybinds

### Settings Persistence

1. Frontend calls `invoke("update_settings", { newSettings })`
2. Rust merges with existing settings (preserves `deviceSharedSecret`)
3. Rust saves to `%APPDATA%\com.apollo.desktop\settings.json`
4. Frontend updates Zustand store
5. Toast notification shown

### Migration

- `migrate_from_v0_1_0()`: Converts old format to new format
- Runs on startup if version mismatch detected

---

## 34. Python Sidecar Protocol

### Message Types (Frontend → Python)

| Type | Fields | Purpose |
|------|--------|---------|
| `start_listening` | (none) | Start voice listening |
| `stop_listening` | (none) | Stop voice listening |
| `configure_wake_words` | `words: string[]` | Configure wake words |
| `set_manual_wake_mode` | `enabled: bool` | Toggle manual wake mode |
| `get_status` | (none) | Get sidecar status |
| `set_api_key` | `provider, apiKey` | Set API key |
| `start_pcbridge` | (none) | Start PcBridge |
| `start_cloud_core` | (none) | Start CloudCore |
| `send_command` | `command, args?` | Send generic command |
| `send_llm_prompt` | `prompt: string` | Send LLM prompt |
| `voice_start_listening` | (none) | Start voice listening |
| `voice_stop_listening` | (none) | Stop voice listening |

### Message Types (Python → Frontend)

All events listed in [Section 6](#6-ipc-events-rust--frontend).

---

## 35. Build Pipeline

### Development

```bash
cd apps/desktop/ui
npm run dev          # Vite dev server :5173
```

### Production Build

```bash
cd apps/desktop
$env:CARGO_BUILD_JOBS = "2"
$env:RUSTFLAGS = "-C link-arg=/STACK:0x10000000"
cargo tauri build    # Full build
```

### Build Steps

1. Vite builds `ui/` → `ui/dist/`
2. `bundle-resources.mjs` copies Python sidecar, CloudCore, PcBridge to staging
3. Cargo compiles Rust with Tauri
4. Tauri bundles resources into installer
5. NSIS/MSI installer created in `target/release/bundle/`

### Output

| Artifact | Size | Location |
|----------|------|----------|
| NSIS Installer | 67 MB | `target/release/bundle/nsis/` |
| MSI Installer | 87 MB | `target/release/bundle/msi/` |
| Binary | ~30 MB | `target/release/` |

---

## 36. Gaps & Recommendations

### Critical Gaps

1. **No test framework** — No Jest, Vitest, or Playwright. Zero test files. Recommend adding Vitest + React Testing Library.
2. **No linting** — No ESLint, Prettier, or Clippy. Recommend ESLint + Prettier for frontend, `clippy` for Rust.
3. **~30 unused files** — Legacy components, hooks, and CSS files (~4500+ lines). Recommend deleting.
4. **No CSP configuration** — Tauri default CSP. Recommend explicit CSP in `tauri.conf.json`.
5. **No error boundaries** — React error boundaries missing. Recommend adding to catch rendering errors.

### Medium Gaps

6. **No virtualized chat** — Long conversations will degrade performance. Recommend `react-window` or `@tanstack/virtual`.
7. **No debounced settings save** — Settings saved on every change. Recommend debouncing.
8. **`SettingsPayload` type mismatch** — Frontend uses flat `SettingsPayload`, Rust uses nested `AppSettings`. Recommend aligning types.
9. **No i18n** — All strings hardcoded in English. Recommend `react-i18next` if localization needed.
10. **No analytics/telemetry** — No usage tracking. Consider adding privacy-respecting analytics.

### Minor Gaps

11. **No storybook** — No component documentation. Recommend Storybook for component development.
12. **No CI/CD** — No GitHub Actions or build pipeline. Recommend adding CI for automated builds/tests.
13. **No changelog** — No CHANGELOG.md. Recommend maintaining one.
14. **No version bumping** — Manual version updates across 3 files. Recommend `changesets` or `semantic-release`.
15. **Inconsistent CSS** — Mix of CSS modules (`*.module.css`) and global CSS. Recommend standardizing.

---

## Quick Reference: File Locations

| What | Path |
|------|------|
| UI source | `apps/desktop/ui/src/` |
| Rust source | `apps/desktop/src-tauri/src/` |
| Tauri config | `apps/desktop/src-tauri/tauri.conf.json` |
| Capabilities | `apps/desktop/src-tauri/capabilities/default.json` |
| Bundle script | `apps/desktop/bundle-resources.mjs` |
| Python sidecar (source) | `juana-client/juana_client/` |
| Settings file | `%APPDATA%\com.apollo.desktop\settings.json` |
| Build output | `apps/desktop/target/release/bundle/` |
| Package.json (UI) | `apps/desktop/ui/package.json` |
| Cargo.toml (Rust) | `apps/desktop/src-tauri/Cargo.toml` |
