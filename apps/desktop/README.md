# Apollo Desktop - Aplicación de Escritorio Nativa

Aplicación de escritorio para Windows (Tauri + React + Three.js) que actúa como compañero de Apollo en la PC principal.

## Características

- **Orbe visual de partículas** con Three.js + post-processing (Bloom)
- **Wake word "Juana"/"Hey Juana"** via Vosk (offline, reusa juana-client Python)
- **Chat de texto** para enviar comandos y ver respuestas
- **Control de PC nativo**: abrir/enfocar/cerrar apps, Spotify, bloquear pantalla
- **System tray** - minimiza a bandeja, sigue escuchando
- **Settings** - configuración de conexión, wake word, salida de audio

## Stack

- **Tauri 2** (Rust + WebView2) - binario ligero (~5-10 MB)
- **React 18 + TypeScript + Vite** para el frontend
- **Three.js + postprocessing** para el orbe con Bloom real
- **Python sidecar** (juana-client) para audio + WebSocket + Vosk
- **Zustand** para estado global
- **tauri-plugin-store** para persistencia de settings

## Estructura

```
apps/desktop/
├── src-tauri/           # Backend Rust (Tauri)
│   ├── src/
│   │   ├── main.rs      # Entry point, ventanas, tray
│   │   ├── lib.rs       # Library root
│   │   ├── commands.rs  # Tauri commands (PC control, sidecar, settings)
│   │   ├── sidecar.rs   # Gestión del proceso Python juana-client
│   │   └── state.rs     # Estado compartido (settings, conexión, orbe)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── icons/
├── ui/                  # Frontend React
│   ├── src/
│   │   ├── main.tsx           # Ventana Orbe
│   │   ├── chat-main.tsx      # Ventana Chat
│   │   ├── settings-main.tsx  # Ventana Settings
│   │   ├── OrbWindow.tsx      # Componente principal del orbe
│   │   ├── components/
│   │   │   ├── Orb/Orb.tsx    # Orbe Three.js con partículas + Bloom
│   │   │   ├── Chat/ChatWindow.tsx
│   │   │   └── Settings/SettingsWindow.tsx
│   │   ├── hooks/useTauri.ts  # Comandos Tauri + listeners de eventos
│   │   └── store/index.ts     # Zustand store (orb, chat, settings, conexión)
│   ├── index.html         # Orbe window
│   ├── chat.html          # Chat window
│   ├── settings.html      # Settings window
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
```

## Desarrollo

### Prerrequisitos

- **Rust** (via `rustup`)
- **Bun** (ya en el monorepo)
- **Python 3.10+** con `pyaudio`, `vosk`, `numpy`, `websockets`, `python-dotenv`
- **WebView2** (incluido en Windows 10/11)

### Instalación

```bash
cd apps/desktop

# Frontend deps
cd ui && bun install

# Rust deps (se descargan al compilar)
cd ../src-tauri && cargo build
```

### Modo desarrollo

```bash
# Desde la raíz del monorepo
cd apps/desktop/ui && bun run dev
# En otra terminal:
cd apps/desktop/src-tauri && cargo tauri dev
```

O usar el script combinado:

```bash
cd apps/desktop/ui && bun run tauri dev
```

Esto abre:
- Ventana Orbe (360x360, always-on-top, transparente)
- Ventana Chat (oculta inicialmente, Ctrl+Shift+A)
- Ventana Settings (oculta inicialmente, Ctrl+Shift+S)
- Icono en bandeja del sistema

### Variables de entorno (.env en ui/ o raíz)

```env
APOLLO_WORKER_URL=wss://apollo.facupapollo.workers.dev/agents/apollo/default
DEVICE_SHARED_SECRET=tu-secret-aqui
WAKE_WORDS=juana,hey juana
USE_VOSK_WAKE=true
WAKE_MODEL_DIR=juana_client/models
```

### Modelo Vosk

Descarga el modelo español pequeño (~42 MB):

```bash
mkdir -p juana_client/models
cd juana_client/models
wget https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip
unzip vosk-model-small-es-0.42.zip
```

## Build de producción

```bash
cd apps/desktop/ui && bun run tauri build
```

Genera en `src-tauri/target/release/bundle/`:
- `msi` - Instalador Windows
- `exe` - Ejecutable standalone
- `appx` - Paquete MS Store (opcional)

## Flujo de datos

```
Usuario dice "Juana"
    ↓
Python sidecar (juana-client) detecta wake word via Vosk
    ↓
Sidecar envía "wake" via WebSocket al Apollo Worker
    ↓
Worker responde con ui_state: listening
    ↓
Tauri app recibe via sidecar → emite evento "orb-state-change"
    ↓
Orbe React cambia a estado "listening" (partículas azules, pulso rápido)
    ↓
Usuario habla → audio capturado por sidecar → WebSocket → Worker
    ↓
Worker procesa (STT → LLM → TTS) → envía tts_start + audio PCM
    ↓
Sidecar reproduce audio local (si responseOutputTarget=pc)
    ↓
Tauri app muestra caption en orbe + chat
```

## Comandos de PC disponibles (via tools en Apollo)

| Tool | Descripción |
|------|-------------|
| `open_pc_app` | Abre app (chrome, spotify, code, notepad, explorer, etc.) |
| `focus_pc_app` | Trae app al frente |
| `close_pc_app` | Cierra app |
| `lock_pc_screen` | Bloquea pantalla (Win+L) |
| `list_pc_apps` | Lista procesos |
| `spotify_play/pause/next/previous/get_state` | Control Spotify |

## Atajos de teclado

| Tecla | Acción |
|-------|--------|
| Ctrl+Shift+A | Abrir Chat |
| Ctrl+Shift+S | Abrir Settings |
| Escape | Ocultar Orbe |
| Click en tray | Toggle Orbe |

## Diferencias con juana-client standalone

| Característica | juana-client (Python) | Apollo Desktop (Tauri) |
|----------------|----------------------|------------------------|
| UI | Solo logs CLI | Orbe visual + Chat + Settings |
| PC Control | Via PcBridge (remoto) | **Nativo** (PowerShell directo) |
| System Tray | No | Sí |
| Persistencia settings | .env manual | Store automático |
| Distribución | Script Python | Instalador MSI/EXE |

## Próximos pasos

- [ ] Implementar `list_pc_apps` nativo
- [ ] Implementar controles Spotify nativos
- [ ] Auto-update via Tauri updater
- [ ] Notificaciones nativas (toast)
- [ ] Global hotkey para wake word manual
- [ ] Métricas de rendimiento del orbe