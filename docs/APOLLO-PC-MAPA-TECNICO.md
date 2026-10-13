# Apollo en la PC — Mapa técnico verificado

**Fecha:** 2026-10-12 · **Alcance:** investigación de solo lectura. Cero archivos modificados.

> **Niveles de evidencia** — no los mezclo:
> **[T]** demostrado por test ejecutado en esta sesión · **[L]** leído en el código ·
> **[B]** build ejecutado · **[R]** requiere producción o hardware, **no verificado**

---

## 1. Resumen ejecutivo

Apollo en la PC es un **cliente thin de un asistente en la nube**. La PC aporta tres cosas: interfaz, audio y ejecución local de acciones. **No hay inferencia de IA en la PC.**

El hallazgo más importante de la auditoría:

> **Apollo no llama a la IA para la mayoría de las órdenes.** Un *router determinista* corre **antes** del modelo, en el Worker, y resuelve de forma local horas, fechas, apps, Spotify, foco, pantalla, memoria y las seis intenciones de móvil. Sólo lo que no reconoce llega a Gemini. [L] `runtime.ts:137-184`

Esto tiene tres consecuencias:
1. **Coste:** la mayoría de las órdenes no cuestan tokens.
2. **Latencia:** se evita el viaje completo al modelo.
3. **Riesgo:** un patrón mal escrito ejecuta una acción sin que el modelo la valide.

Estado verificado: **1320 tests del Worker pasan, 0 fallan** [T], desglosados en la §11.

---

## 2. Inventario de funciones y estado real

| # | Función | Activación | Implementación | IA | Estado | Evidencia |
|---|---|---|---|---|---|---|
| 1 | **Hora / fecha** | texto o voz | `router.ts` `TIME_PATTERN`/`DATE_PATTERN` | **No** | **Operativa** | [T] 36 tests |
| 2 | **Abrir app** | texto o voz | `OPEN_APP_PATTERN` → `commands.rs:131` | No | **Operativa** | [T] router |
| 3 | **Cerrar app** | texto o voz | `CLOSE_APP_PATTERN` → `commands.rs:474` | No | **Operativa** | [T] |
| 4 | **Focar app** | texto o voz | `FOCUS_APP_PATTERN` → `commands.rs:423` | No | **Operativa** | [T] |
| 5 | **Bloquear pantalla** | texto o voz | `LOCK_SCREEN_PATTERN` → `commands.rs:505` | No | **Operativa** | [T] |
| 6 | **Spotify** (play/pause/next/prev) | texto o voz | 4 patterns → `commands.rs:551-566` | No | **Operativa** | [T] |
| 7 | **Listar apps** | texto o voz | `desktop.list_apps` → `commands.rs:546` | No | **Operativa** | [T] |
| 8 | **Recordar memoria** | texto o voz | `MEMORY_WRITE_PATTERN` → `memories` | No | **Operativa** | [T] |
| 9 | **Notificar teléfono** | texto o voz | `MOBILE_NOTIFICATION_PATTERN` → MobileBridge | No | **Operativa** | [T] 509 devices |
| 10 | **Alarma / calendario / media / volumen / abrir app móvil** | "en el teléfono…" | 5 patterns `mobile-intent.ts` | No | **Operativa** | [T] |
| 11 | **Conversación general** | texto o voz | `runtime.ts` → Gemini | **Sí** | **Operativa [R]** | sin E2E |
| 12 | **TTS (voz de respuesta)** | automático | `voice/gemini.ts` → Gemini TTS | Sí | **Operativa [R]** | sin E2E |
| 13 | **TTS fallback** | si Gemini falla | `voice/fallback.ts` → `@cf/myshell-ai/melotts` | Sí | **Implementada [L]** | `isWorkersAiTtsAvailable` |
| 14 | **STT (voz → texto)** | hablar | `voice/gemini.ts` STT | Sí | **Operativa [R]** | sin E2E |
| 15 | **Wake word / Vosk** | hablar | `sidecar.rs` → `juana-client` | No | **Operativa si `autostart_enabled`** | [L] |
| 16 | **Subtítulos / captions** | automático | `caption` en `ui_state` | No | **Operativa** | [L] |
| 17 | **Confirmaciones** | acción sensible | `pendingConfirmId` + `confirm` | No | **Operativa** | [T] `confirmation.spec.ts` |
| 18 | **Telemetría / batería** | automático | `telemetry` → `ota/` | No | **Operativa** | [T] 47 |
| 19 | **Foco / temporizador** | texto o voz | `applyFocusMinutes`, `startDeskFocus` | No | **Operativa** | [L] |
| 20 | **Recordatorios programados** | texto | `scheduleReminder` → `this.schedule()` | No | **Operativa** | [L] |
| 21 | **Iniciativa proactiva** | automática | `initiativeState` | Parcial | **Experimental** | [L] |
| 22 | **Búsqueda Brave** | texto | `desktop.brave_search` | Sí | **Operativa [R]** | clave externa |
| 23 | **Memoria semántica** | "recuerda…" | Vectorize `apollo-memory` | Sí | **Operativa [R]** | sin E2E |
| 24 | **MCP** | por herramienta | `mcp/` (16 archivos) | Sí | **Operativa** | [T] 67 |
| 25 | **OTA / firmware** | automático | `ota/lifecycle.ts` | No | **Operativa** | [T] 47 |
| 26 | **Android ↔ PC** | texto | MobileBridge DO | No | **Operativa [R]** | sin E2E |
| 27 | **Acceso a archivos** | texto | `desktop.files` | Sí | **Operativa [R]** | — |

**12 capacidades desktop.*** declaradas en `capability.ts`: `brave_search`, `brightness`, `close_app`, `files`, `focus_app`, `list_apps`, `lock`, `notifications`, `open_app`, `spotify`, `system_status`, `volume` [L]

---

## 3. Flujo completo de inicio y funcionamiento

### 3.1 Arranque [L]

```
main.rs → apollo_desktop::run() → lib.rs setup()
  ├─ AppSettings::load()              ← JSON en app_config_dir()
  ├─ autostart (si autostart_enabled)
  ├─ create_tray()                    ← icono en bandeja
  ├─ SidecarManager::start()          ← Python: wake word + STT + TTS playback
  │     └─ solo si settings.autostart_enabled
  ├─ PcBridgeManager::start()         ← conexión de CAPACIDADES
  └─ CloudCoreManager::start()        ← conexión de CONVERSACIÓN
```

**Dos conexiones WebSocket independientes y una local (sidecar).** [L] `lib.rs:63-130`

### 3.2 Texto → respuesta [L]

```
UI (ui/src/components/Chat)
  └─ invoke("send_text_to_cloud_core")        commands.rs:896
       └─ cloudcore.send_text()               cloudcore.rs:324
            └─ WS → wss://<worker>/agents/apollo/default?token=<secreto>
                 └─ Worker: apollo.ts onMessage → case 'text_input'   apollo.ts:1033
                      └─ #runTurnFromText()    apollo.ts:2726
                           └─ #executeTurn()   apollo.ts:2799
                                └─ runtime.ts
                                     ├─ routeDeterministic()   ← SIN IA
                                     │    └─ si kind !== 'ai_needed' → FIN
                                     └─ si ai_needed → Gemini + memoria + MCP + tools
```

### 3.3 Voz → texto → misma ruta [L]

```
Hablas → sidecar (Vosk o Gemini STT)
  └─ sidecar.rs:349 → cc.send_text()
       └─ IDÉNTICO CAMINO que el texto desde aquí
```

`sidecar.rs:282`: *"voice_transcript: forward to CloudCoreManager.send_text()"* — la voz **no tiene camino propio**. [L]

### 3.4 Respuesta → reproducción [L]

```
Worker envía caption / tts_start / audio binario
  └─ cloudcore.rs recibe → emite a la UI
       ├─ texto → Chat / subtítulo
       └─ audio → TTS playback vía sidecar
```

### 3.5 Sin Internet [L]

`cloudcore.rs:511` — timeout de conexión de **25 s**. `run_reconnect_loop` con backoff **2 s → 60 s** (`cloudcore.rs:47`). El sidecar Python **sigue vivo** pero sin turno: no llama al Worker (`sidecar.rs:4`). Comandos deterministas que no requieren IA **también fallan**, porque viven en el Worker, no en la PC.

---

## 4. Arquitectura: local, nube e IA

```
╔═══════════════ PC (Windows) ═══════════════╗
║  Tauri (Rust)                               ║
║   main → lib → setup                       ║
║    ├─ CloudCoreManager ──┐                  ║
║    └─ PcBridgeManager ──┤  2× WSS           ║
║                          │                  ║
║  ui/src (React) ─ Chat, Assistant, Orb     ║
║                          │                  ║
║  sidecar.rs ─ juana-client (Python)         ║
║   wake word · STT · TTS playback            ║
║   ❌ NO hace inferencia                     ║
║                          │                  ║
║  commands.rs ─ acciones Windows            ║
╚══════════════════════════╪══════════════════╝
                           │ WSS
╔══════════════════════════▼══════════════════╗
║  CLOUDFLARE                                 ║
║   Worker index.ts                           ║
║   ┌─ DO Apollo/default ─ conversational    ║
║   │   router determinista → runtime         ║
║   │   Gemini · Vectorize · MCP · memoria    ║
║   ├─ DO MobileBridge ─ capacidades móviles  ║
║   ├─ DO PcBridge ─── capacidades PC        ║
║   ├─ DO Sandbox / Background / Coding      ║
║   └─ Vectorize "apollo-memory" (GLOBAL)    ║
╚══════════════════════════╪══════════════════╝
                           │ HTTPS
╔══════════════════════════▼══════════════════╗
║  GEMINI (generativelanguage.googleapis.com)║
║   gemini-3.6-flash      conversación + STT  ║
║   gemini-3.1-flash-tts-preview   TTS        ║
║   text-embedding-004    embeddings          ║
║   ── fallback Workers AI ──                ║
║   @cf/myshell-ai/melotts  TTS alternativo   ║
╚═════════════════════════════════════════════╝
```

---

## 5. Proveedor de IA — verificado por ejecución, no por nombre [L]

**Pregunta clave:** ¿Workers AI (`env.AI.run()`) o Gemini?

**Respuesta: Gemini para todo el ciclo conversacional. Workers AI sólo como fallback de TTS.**

| Función | Proveedor | Modelo | Evidencia |
|---|---|---|---|
Conversación | **Gemini API** | `gemini-3.6-flash` | `runtime.ts:204,480,646,853` pasan `geminiApiKey` al SDK `agents` |
STT | **Gemini API** | `gemini-3.6-flash` | `GEMINI_STT_MODEL` |
TTS | **Gemini API** | `gemini-3.1-flash-tts-preview` | `GEMINI_TTS_MODEL` |
Voz live | **Gemini API** | `gemini-3.1-flash-live-preview` | `GEMINI_LIVE_MODEL` |
Embeddings | **Gemini API** | `text-embedding-004` | `geminiEmbeddings.ts` |
**TTS fallback** | **Workers AI** | `@cf/myshell-ai/melotts` | `fallback.ts:5` + `isWorkersAiTtsAvailable` |

**Distinción importante que la auditoría.previous no hacía:**
- El binding `AI` **existe** en `wrangler.jsonc`.
- `env.AI.run()` para inferencia conversacional: **no encontré uso**. [L]
- `env.AI` **sí** se usa para el fallback TTS: `isWorkersAiTtsAvailable(environment)` lee `environment.AI !== undefined`. [L]

**Si falta `GEMINI_API_KEY`:** `apollo.ts:2999-3001` lanza `new Error('GEMINI_API_KEY no configurado')` al listar modelos. En conversación, el SDK recibe `?? ''` y falla en la llamada. **No hay proveedor alternativo para conversar.** [L]

---

## 6. Juana Client — estado real

**No es el motor de IA. No lo proposes volver a local.**

| Pregunta | Respuesta verificada |
|---|---|
¿Hace inferencia? | **No.** `sidecar.rs:4`: *"Python does NOT connect to the Worker directly"* [L] |
¿Qué hace? | Wake word, STT, TTS playback (`sidecar.rs:3`) [L] |
Quién lo invoca? | `lib.rs:65` → `SidecarManager::start()`, **solo si `autostart_enabled`** [L] |
¿Tiene tests? | **Sí, 9 archivos** en `juana_client/tests/` [T] |
¿Qué se perdería al retirarlo? | Wake word y TTS playback. **STT tiene fallback**: Gemini STT vía `GEMINI_STT_MODEL` [L] |

**Consecuencia para el objetivo de nube:** retirar `juana-client` **no** elimina la voz. Gemini cubre STT y TTS en la nube. Se pierde wake word (que no tiene equivalente cloud) y la reproducción local.

---

## 7. Memoria, conversaciones y configuración

| Dato | Dónde | Ámbito |
|---|---|---|
`memories` | DO Apollo, tabla SQL | **Conversacional** |
Vectores | Vectorize `apollo-memory` | **Semántico, GLOBAL** [L] |
`thread_meta`, `threadMeta` | DO Apollo | Rotación de hilos |
`speechMode`, `weatherLocation`, `publicOrigin` | `session_prefs` | Preferencias |
`activeThreadSessionId` | `session_prefs` | Efímero |
`workerUrl`, `deviceSharedSecret`, `wakeWords` | **JSON en `app_config_dir()`** | Local [L] `state.rs:266` |

**El secreto del dispositivo está en JSON plano.** [L] `state.rs:261-269` — `tokio::fs::write` sin cifrar. Riesgo señalado en §9.

---

## 8. Seguridad e identidad

| Aspecto | Estado real |
|---|---|
Identidad de la PC | **`deviceId` NO se persiste** [L] `cloudcore.rs:225` → `unwrap_or("desktop")`. Dos PCs colisionarían |
Autenticación | `?token=<DEVICE_SHARED_SECRET>` en la URL [L] `cloudcore.rs:507` — **el secreto viaja en la query string** |
Almacenamiento del secreto | JSON plano, sin cifrar [L] |
Transporte | WSS en producción; `tokio-tungstenite` con `rustls-tls-webpki-roots` [L] |
Acciones sin confirmación | Las deterministas (abrir/cerrar app, Spotify, **bloquear pantalla**) [L] |
Acciones con confirmación | Las que el modelo marca `safety: 'dangerous'` → `pendingConfirmId` [T] |
Validación de entrada | `schema.ts` con zod, `strict()` [T] |
Aislamiento de usuarios | **No existe.** `accountId` no aparece en 69 492 líneas [L] |

---

## 9. Riesgos y código obsoleto

| # | Riesgo | Evidencia |
|---|---|---|
R1 | `deviceId` no persistido → dos PCs con la misma identidad | `cloudcore.rs:225` |
R2 | Secreto en query string → aparece en access logs | `cloudcore.rs:507` |
R3 | Secreto en JSON plano | `state.rs:261` |
R4 | **12 patrones deterministas ejecutan sin validación de IA** | `router.ts` |
R5 | Vectorize global: dos usuarios comparten memoria | `wrangler.jsonc` |
R6 | Sin `GEMINI_API_KEY` no hay conversación | `apollo.ts:3001` |
R7 | 8 archivos UI desktop borrados (confirmado sin referencias) | commit `6993bd2` vs actual |
R8 | `APOLLO_ANDROID_SOURCE_OF_TRUTH.md` sin trackear | `git status` |

**R4 merece atención:** un patrón como `LOCK_SCREEN_PATTERN` bloquea la pantalla **sin pasar por el modelo**. Es intencional (velocidad y coste) pero significa que un falso positivo en un patrón ejecuta una acción local sin que nada la evalúe.

---

## 10. Dependencias que no deben eliminarse sin migración

| Dependencia | Para qué | Riesgo si se quita |
|---|---|---|
`sidecar.rs` + `juana-client` | Wake word, TTS playback | Se pierde wake word |
`tokio-tungstenite` + `rustls` | WSS | Se pierde toda la conexión |
`@google/genai` (vía SDK `agents`) | Conversación, STT, TTS, embeddings | **Aparece el asistente** |
`@cf/myshell-ai/melotts` | TTS fallback | Se pierde redundancia de voz |
`@modelcontextprotocol/sdk` | Herramientas externas | Se pierden integraciones |
Zod + `schema.ts` | Validación de todo el protocolo | Se rompe la seguridad |
`cloudflare:sandbox` | Ejecución aislada | Se pierde codificación |

---

## 11. Pruebas ejecutadas en esta sesión [T]

```
Worker completo       1320 pass   0 fail
  ├─ voice              152 pass  0 fail   (incluye router: 36)
  ├─ devices            509 pass  0 fail
  ├─ tools              157 pass  0 fail
  ├─ mcp                 67 pass  0 fail
  ├─ ota                 47 pass  0 fail
  ├─ memory              44 pass  0 fail
  └─ agents              39 pass  0 fail
```

**Lo que NO verifiqué:**
- **[R]** Cualquier conversación real con Gemini — requiere `GEMINI_API_KEY` válida y salida a Internet.
- **[R]** Reproducción de TTS real.
- **[R]** Flujo completo de una acción de Windows vía el modelo.
- **[R]** MobileBridge ↔ PC en producción.
- **[P]** Wake word y STT en hardware.

**Tipocheck:** 10 errores, **preexistentes**, en `runtime.ts`, `testing.ts`, `dollar.ts`, `gemini.spec.ts`, `workersai.ts`. Ninguno en el camino de la conversación. [T]

---

## 12. Tabla de trazabilidad

| Capacidad | Archivo:función | Patrón | Tests | Estado |
|---|---|---|---|---|
Hora | `router.ts:routeDeterministic` | `TIME_PATTERN` | `router.spec.ts` | **Operativa** [T] |
Abrir app | `commands.rs:131` | `OPEN_APP_PATTERN` | `router.spec.ts` | **Operativa** [T] |
Spotify | `commands.rs:551-566` | 4 patterns | `router.spec.ts` | **Operativa** [T] |
Bloquear pantalla | `commands.rs:505` | `LOCK_SCREEN_PATTERN` | `router.spec.ts` | **Operativa** [T] |
Notificar móvil | `mobile-intent.ts` | `MOBILE_NOTIFICATION_PATTERN` | `router.spec.ts` | **Operativa** [T] |
Memoria | `tools/memory.ts:rememberFactTool` | `MEMORY_WRITE_PATTERN` | `memory` 44 | **Operativa** [T] |
Conversación | `runtime.ts` → Gemini | — | sin E2E | **[R]** |
TTS | `voice/gemini.ts` | — | `voice` 152 | **[R]** |
Wake word | `sidecar.rs` → `juana-client` | — | 9 python | **[R]** |
Confirmaciones | `apollo.ts:#resolveConfirm` | — | `confirmation.spec.ts` | **Operativa** [T] |
Telemetría | `ota/lifecycle.ts` | — | `ota` 47 | **Operativa** [T] |

---

## 13. Recomendaciones priorizadas

| Prio | Acción | Por qué |
|---|---|---|
**1** | **Persistir `deviceId` del PC** | R1: hoy dos PCs son el mismo dispositivo |
**2** | **Mover el secreto fuera de la query string** | R2: está en logs del servidor |
**3** | **Cifrar el secreto en disco** | R3: JSON plano |
**4** | **Auditar los 12 patrones deterministas** | R4: ejecutan sin validación de IA |
**5** | Documentar que el fallback de TTS usa Workers AI | Evidencia de que `AI` sí se usa |

---

## Acciones NO ejecutadas

- ❌ No modifiqué ningún archivo
- ❌ No refactoricé, no borré, no moví
- ❌ No cambié proveedor, credenciales ni bindings
- ❌ No hice deploy ni migraciones
- ❌ No expuse endpoints de diagnóstico
- ❌ No mostré valores de secretos

**Todas las afirmaciones sin [T] ni [L] están marcadas [R]: no verificadas contra producción.**
