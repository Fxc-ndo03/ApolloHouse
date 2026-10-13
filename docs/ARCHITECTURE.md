# Apollo — ARQUITECTURE

## Diagrama general

```mermaid
graph TB
    subgraph PC["🖥️ PC · Windows"]
        UI["ui/ · React<br/>Chat · Assistant · Orb"]
        TAURI["lib.rs · Tauri"]
        CC["CloudCoreManager<br/>conversación"]
        PB["PcBridgeManager<br/>capacidades"]
        SC["sidecar.rs → juana-client<br/>wake word · STT · TTS playback"]
        CMD["commands.rs<br/>acciones Windows"]
        SS["secret_store.rs<br/>Credential Manager"]
        CFG["state.rs<br/>preferencias · installation_id"]

        UI --> TAURI
        TAURI --> CC
        TAURI --> PB
        TAURI --> SC
        TAURI --> CMD
        CFG --> SS
    end

    subgraph CLOUDFLARE["☁️ Cloudflare"]
        W["Worker index.ts<br/>routing · auth"]
        DOA["DO Apollo/default<br/>memoria · hilos · preferencias"]
        MOB["DO MobileBridge<br/>presencia · capacidades móviles"]
        PCB["DO PcBridge<br/>capacidades desktop"]
        OTH["DO Sandbox · Background · Coding"]
        RT["routeDeterministic<br/>SIN IA"]
        RT2["runtime<br/>Gemini · tools · MCP"]
        VEC[("Vectorize<br/>apollo-memory")]
    end

    subgraph GEMINI["🤖 Gemini API"]
        CHAT["gemini-3.6-flash"]
        STT["STT"]
        TTS["TTS flash"]
        EMB["text-embedding-004"]
    end

    subgraph WAI["Workers AI"]
        FTTS["@cf/myshell-ai/melotts<br/>TTS fallback"]
    end

    subgraph ANDROID["📱 Android"]
        APP["Apollo Mobile<br/>FGS + Keystore"]
        CHATUI["ConversationActivity"]
    end

    CC -->|"WSS + X-Apollo-Device-Secret"| W
    PB -->|"WSS + X-Apollo-Device-Secret"| W
    APP -->|"WSS + Authorization: Bearer"| W
    W --> DOA
    W --> MOB
    W --> PCB
    W --> OTH
    DOA --> RT
    DOA --> RT2
    DOA --> VEC
    RT2 --> CHAT
    RT2 --> EMB
    RT --> STT
    RT --> TTS
    TTS -.->|"si falla"| FTTS
```

## Separación por capas

### Capa 1 · Núcleo en la nube

| Responsabilidad | Dónde |
|---|---|
API y routing | `index.ts` |
Identidad y auth | `auth/role.ts`, `auth/token.ts` |
Estado conversacional | DO Apollo (7 tablas SQL) |
Memoria semántica | Vectorize |
Herramientas | `tools/` (58 archivos) |
Integraciones | `mcp/` (16), `ota/`, `weather/`, `github/` |
Estado global | `initiativeState`, `firmware*`, `mcp_tool_settings` |

### Capa 2 · Agentes de dispositivo

| | PC | Android |
|---|---|---|
Conexión | WSS, dos sockets | WSS, uno |
Identidad | `desktop:<uuid>` persistido | `mobile:<uuid>` en Keystore |
Credencial | `X-Apollo-Device-Secret` | `Authorization: Bearer` |
Segundo plano | proceso Tauri | Foreground Service |
Ejecución | `commands.rs` | `command/dispatcher.kt` |
Confirmación | `safety: unsafe` | allowlist de comandos |

### Capa 3 · Contratos compartidos

`apps/agent/src/protocol/schema.ts` es la fuente de verdad. El cliente Kotlin replica las constantes en `contract/contract.kt`, y `apps/mobile/__tests__/contract.spec.ts` ata ambas direcciones: un cambio en un lado sin el otro **falla el build**.

## Flujo: un turno de texto

```mermaid
sequenceDiagram
    participant U as Usuario
    participant UI
    participant CC as CloudCoreManager
    participant W as Worker
    participant RT as routeDeterministic
    participant G as Gemini
    participant T as Tool

    U->>UI: "abrí el navegador"
    UI->>CC: invoke(send_text_to_cloud_core)
    CC->>W: WSS text_input {text, ts}
    W->>RT: ¿es determinista?
    alt determinista y safe
        RT-->>W: pc_command
        W->>T: ejecuta
        T-->>W: resultado
        W-->>CC: caption + respuesta
    else determinista y unsafe
        RT-->>W: pc_command (lock_pc_screen)
        W-->>CC: confirm_request
        CC-->>U: "¿Confirmás?"
        U->>CC: confirm
        W->>T: ejecuta
    else ai_needed
        RT-->>W: ai_needed
        W->>G: turno + memoria + tools
        G-->>W: respuesta
    end
    CC-->>UI: texto + audio
    UI-->>U: respuesta
```

**Clave del diseño:** el router determinista corre **antes** del modelo y con contexto mínimo. Todo lo caro (memoria semántica, historial, prompt de sesión, descubrimiento MCP) se arma **solo si el turno no se resolvió ahí** (`runtime.ts:137-141`).

## Proveedor de IA — verificado por uso

| Función | Proveedor | Modelo |
|---|---|---|
Conversación | Gemini API | `gemini-3.6-flash` |
STT | Gemini API | `gemini-3.6-flash` |
TTS | Gemini API | `gemini-3.1-flash-tts-preview` |
Embeddings | Gemini API | `text-embedding-004` |
**TTS fallback** | **Workers AI** | `@cf/myshell-ai/melotts` |

El binding `AI` **no** se usa para inferencia conversacional. **Sí** se usa para el fallback de TTS (`isWorkersAiTtsAvailable`).

**Sin `GEMINI_API_KEY` no hay conversación** (`apollo.ts:2999`). No hay proveedor alternativo para conversar.

## Estado por DO

| DO | Ámbito | Nota |
|---|---|---|
`Apollo` | **Global (una instancia)** | Fuente de P2/R7: particionar por cuenta |
`MobileBridge` | **Global compartido** | Concentra presencia y capacidades de todos los teléfonos |
`PcBridge` | **Global** | Capacidades desktop |
`Sandbox`/`Background`/`Coding` | Global | Sin datos de usuario |

## Persistencia

| Dato | Ubicación | Ámbito |
|---|---|---|
`memories`, `thread_meta`, `session_prefs` | DO Apollo | Conversacional |
Vectores | Vectorize `apollo-memory` | Semántico, **global** |
`mcp_tool_settings` | DO Apollo | Configuración de instalación |
`initiativeState`, `firmware*` | `session_prefs` | Estado del agente |
Credenciales de dispositivo | `mobile_device_credential` (MobileBridge) | Por dispositivo |
`installation_id`, preferencias | JSON `app_config_dir()` | Local, no secreto |
`device_shared_secret` | **Credential Manager** | **Cifrado (DPAPI)** |

## Migración a multiusuario

Ruta objetivo:

```
/agents/apollo/<accountId>
```

Un DO por **cuenta**, no por dispositivo: si fuera por dispositivo, dos usuarios en el mismo teléfono compartirían conversación. Con DO por cuenta, el PC y el móvil de un mismo usuario **sí** comparten memoria, que es lo correcto.

Secuencia: commit de resguardo → `.gitignore` → tablas `account`/`session` → DO por `accountId` → Vectorize con filtro → `account_id` en credenciales → login → cuotas → retirar secretos globales (**irreversible**).


## ANEXO FASE 2 � aislamiento por cuenta (implementado)

- Identidad: docs/IDENTITY-MODEL.md � cuenta cc_<32 hex> opaca; DO Apollo/acct:<accountId>; dispositivo desktop:<uuid>/mobile:<uuid>.
- Memoria: namespace Vectorize mem:<accountId> derivado obligatoriamente de la cuenta (src/memory/vector.ts); sin cuenta o inv�lida lanza. Antes: todos compart�an namespace 'default'.
- Aislamiento completo: docs/DATA-ISOLATION.md. Migraci�n de Apollo/default: docs/MIGRATION-APOLLO-DEFAULT.md. Dise�o de fase: docs/FASE-2-ARQUITECTURA-MULTIUSUARIO.md.
- Usage/cuotas: docs/USAGE-AND-QUOTAS.md � tabla usage_events por cuenta + pol�tica configurable; enforcement en caliente pendiente.


## ANEXO FASE 2.2 � auth + routing por cuenta (implementado)

- Sesiones reales: `docs/AUTH.md`. DO `AccountRegistry` (binding nuevo, migraci�n v5): cuentas, sesiones (hash-only), binding device?cuenta.
- Endpoints `/api/auth/*` (register/login/logout/session/devices). La cuenta SIEMPRE sale de la sesi�n; el `accountId` del cliente se ignora.
- Routing WebSocket: `Apollo/acct:<accountId>` con `Bearer <sessionToken>`; verificaci�n en borde + DO; `close(1008)` si la sesi�n no es de esa cuenta. El secreto global legacy s�lo abre `Apollo/default`.
- Cuota pre-Gemini: el turno se rechaza (`quota_exceeded`) antes de llamar al modelo si excede pol�tica por tier.
- `memories` escribe `account_id` y sus lecturas est�n acotadas a la cuenta (NULL tolerado s�lo en filas pre-fase de una instancia single-tenant).
