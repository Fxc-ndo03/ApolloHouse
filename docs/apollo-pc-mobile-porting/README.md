# Apollo PC — Paquete de referencia para portar a Android

Paquete de **solo lectura** preparado para que Claude estudie la arquitectura de Apollo PC y
diseñe un nodo Android equivalente. **No contiene implementación de la migración.**

Nada de este paquete modifica el repositorio: son copias de archivos ya existentes, más este README.

---

## 1. Qué es Apollo PC

Apollo PC es la aplicación de escritorio del asistente Apollo. Está construida con **Tauri**:

- **Backend en Rust** (`apps/desktop/src-tauri/src/`) —70 KB de lógica real, ~7 archivos.
- **Frontend React/TypeScript** (`apps/desktop/ui/`) — interfaz,Settings, chat, orb, voice overlay.
- **Worker en Cloudflare** (`apps/agent/`) — backend compartido que implementa el protocolo.

Apollo PC es **un nodo más** de Apollo, no el centro. Habla con Cloudflare por WSS y recibe RPC
desde ahí. Esa es exactamente la posición que quieres ocupar con Android.

### Componentes del backend Rust

| Archivo | Bytes | Rol |
|---|---|---|
| `cloudcore.rs` | 35 015 | **El nodo Apollo**: conexión WSS, `hello`, heartbeat, reconnect, backoff |
| `commands.rs` | 40 452 | Comandos Tauri, config, arranque |
| `state.rs` | 17 051 | **Config y defaults — contiene el endpoint Cloudflare** |
| `sidecar.rs` | 33 538 | Proceso Python de voz (**PC-only**) |
| `pcbridge.rs` | 12 590 | Puente de audio del sistema (**PC-only**) |
| `wallpaper.rs` | 5 347 | Fondo animado (**PC-only**) |
| `lib.rs` / `main.rs` | 12 914 / 82 | Bootstrap |

---

## 2. Cómo se conecta a Cloudflare

Todo está en `00-architecture/cloudcore.rs` y `00-architecture/state.rs`.

**Endpoint por defecto** (`state.rs:152`):

```rust
worker_url: "wss://apollo.facupapollo.workers.dev/agents/apollo/default".to_string(),
```

**Construcción de la URL** (`cloudcore.rs:507`):

```rust
let url = format!("{}?token={device_secret}", worker_url);
```

**Conexión** (`cloudcore.rs:511`) — con timeout explícito, un detalle importante:

```rust
// Sin timeout, un handshake colgado bloquea el loop de reconexion para siempre.
// Con timeout se convierte en reintento con backoff en vez de muerte permanente.
let connect_result = tokio::timeout(Duration::from_secs(25), connect_async(&url)).await;
```

**Mensaje inicial** (`cloudcore.rs:538`):

```rust
let hello = serde_json::json!({
    "type": "hello",
    "deviceId": device_id,
    "ts": chrono::Utc::now().timestamp_millis(),
});
```

**Backoff** (`cloudcore.rs:47`): 2 s tras el primer fallo, duplicando hasta 60 s.

**Higiene de secretos** (`cloudcore.rs:501-505`): el host se registra sin secreto; del token sólo
se registra `token_present: true/false`.

---

## 3. Autenticación

Apollo PC usa el **secreto compartido global** en la query string:

```
wss://<worker>/agents/apollo/default?token=<DEVICE_SHARED_SECRET>
```

El secreto llega a PC por `SettingsWindow` (campo *Device Shared Secret*) y se persiste vía
`state.rs` (`device_shared_secret`, default vacío).

Es configurable por el usuario en Ajustes. Ver `08-config/` y `06-pc-platform/commands.rs`.

---

## 4. Identity, enrollment y credenciales

**Apollo PC NO tiene enrollment.** Su identidad es un `device_id` que se guarda en config
(`state.rs`) y se envía en el `hello`. La autorización es collective: el secreto compartido.

El modelo de **enrollment individual por dispositivo** existe en el Worker pero lo usa Mobile, no PC:

| Pieza | Archivo | Qué hace |
|---|---|---|
| Identidad | `02-identity-auth/identity.ts` | Resuelve/valida el `deviceId` |
| Enrollment | `02-identity-auth/enrollment.ts` | Challenge → claim → credencial, ligado a un `deviceId`, de un solo uso |
| Credenciales | `02-identity-auth/credential-store.ts` | SQLite, hashes, revocación, `pruneChallenge` |
| Rutas HTTP | `02-identity-auth/route.ts` | `/enrollment/challenge`, `/claim`, `/revoke` |
| Autorización | `02-identity-auth/token.ts` | Bearer, roles, comparación timing-safe |

**Autenticación de enrollment**: el *challenge* requiere el secreto del **dueño**
(`DASHBOARD_SHARED_SECRET`) en `Authorization: Bearer`. El *claim* no lleva credencial: el challenge
de un solo uso y ligado al `deviceId` es lo que autoriza. El teléfono nunca recibe el secreto global.

---

## 5. Sesión, heartbeat, presence, reconnect

| Concepto | PC (Rust) | Worker (TypeScript) |
|---|---|---|
| Sesión | `cloudcore.rs` bucle de conexión | `03-session-transport/session.ts` |
| Conexión | `connect_async` 25 s | `03-session-transport/connection.ts` |
| Heartbeat | temporizador en `cloudcore.rs` | `03-session-transport/heartbeat.ts` |
| Presence | — | `03-session-transport/presence.ts` |
| Reconnect | backoff 2 s→60 s | ver `cloudcore.rs` L428 `run_reconnect_loop` |

**Lección clave para Android**: el timeout de conexión no es opcional. Sin él, un handshake colgado
mata el loop de reconexión para siempre. El comentario de `cloudcore.rs:508` documenta que se
midió: la latencia de handshake iba de 0.3 s a 28 s+ según lo fría que estuviera el isolate.

---

## 6. RPC, routing y authorization

| Pieza | Archivo | Rol |
|---|---|---|
| Transporte RPC | `04-rpc/rpc.ts` | Envoltura del protocolo RPC sobre WebSocket |
| Servidor/routing | `04-rpc/apollo.ts` | DO `Apollo`: recibe RPC, enruta, autoriza, invoca tools |
| Bridge Mobile | `04-rpc/mobile-bridge.ts` | DO `MobileBridge`: el equivalente para móvil |
| Resolución de destino | `04-rpc/target.ts`, `resolve.ts` | Decide a qué nodo va un RPC |
| Comandos | `04-rpc/command.ts` | Catálogo de comandos |

El Worker expone **dos Durable Objects distintos**: `Apollo` (`idFromName('default')`, para PC) y
`MobileBridge` (para teléfonos).

---

## 7. Capabilities

| Archivo | Contenido |
|---|---|
| `05-capabilities/capability.ts` | Registro y resolución de capabilities |
| `05-capabilities/payload.ts` | **Un schema por comando**, validados con zod en los tres lados |
| `05-capabilities/mobile.ts` | Capabilities específicas de móvil |
| `05-capabilities/intent.ts`, `mobile-intent.ts` | Intenciones y su resolución |
| `05-capabilities/events.ts` | Eventos de ejecución |

Las capabilities que Mobile anuncia hoy (confirmadas en el inspector):
`mobile.notifications`, `mobile.alarm`, `mobile.calendar`, `mobile.media`, `mobile.volume`,
`mobile.open_app`.

---

## 8. ⚠️ Current protocol divergence

**Este es el punto que Claude debe entender antes de diseñar nada.**
PC y Mobile **no hablan el mismo protocolo hoy**. No es una diferencia de implementación: son
protocolos, rutas, autenticación y Durable Objects **distintos**.

| | **Apollo PC** | **Apollo Mobile (actual)** |
|---|---|---|
| Ruta | `/agents/apollo/default` | `/agents/mobile-bridge/mobile` |
| Autenticación | `?token=<DEVICE_SHARED_SECRET>` (secreto global en la URL) | `Authorization: Bearer <credencial individual>` |
| Durable Object | `Apollo` | `MobileBridge` |
| Modelo de identidad | `deviceId` en config, sin enrollment | `deviceId` enrolado + credencial cifrada |
| Enrollment | **no existe** | challenge → claim → credencial |
| Backoff | 2 s → 60 s | 1, 2, 4, 8, 16, 30 s + 20 % jitter |
| Endpoint | default Cloudflare en `state.rs:152` | host escrito a mano en la UI |
| Voz / TTS | sí (`pcbridge`, `sidecar`) | no |

### Qué tiene que estudiar Claude antes de decidir

1. **El modelo de credencial.** PC no tiene identidad individual: cualquiera con el secreto global
   es un nodo. Mobile sí, y es estrictamente más seguro. Unificar bajaría la seguridad de Mobile
   si se adopta el modelo de PC;、统一 al revés obligaría a migrar PC.

2. **La ruta y el DO.** Unificar exige elegir un DO o añadir un tercero. Cambiar el DO de PC rompe
   la sesión de Apollo PC hoy mismo.

3. **El transporte del secreto.** PC mete el secreto en la query string; eso lo mete en access logs.
   Mobile usa header `Authorization` justamente para evitarlo (`transport/config.kt`). El modelo de
   Mobile es el correcto y no debería revertirse.

4. **El backoff.** Distinto en ambos. No es un conflicto, pero hay que unificar la política.

**Este paquete no resuelve la divergencia.** La documenta.

---

## 9. Partes Windows / PC-only — NO copiar literalmente

Están aisladas en `06-pc-platform/` para que Claude sepa qué comportamiento tienen, sin arrastrarlo:

| Archivo | Qué es | Por qué no se porta |
|---|---|---|
| `sidecar.rs` | Lanza y supervisa un proceso Python de voz | Requiere procesos en Windows |
| `pcbridge.rs` | Captura/burbujeo de audio del sistema | APIs de audio de escritorio |
| `wallpaper.rs` | Fondo de escritorio animado | Sin equivalente conceptual en móvil |
| `commands.rs` | Comandos Tauri + config | Bindings de Tauri |
| `agents/pc-bridge.ts` | Lado Worker del bridge de PC | Par del anterior |

También específico de PC: selección de dispositivo de audio, wake words, overlay de voz,
notificaciones de escritorio.

---

## 10. Mapa PC → Android

| Apollo PC | Equivalente Android | Estado |
|---|---|---|
| `cloudcore.rs` (WSS + hello + reconnect) | OkHttp WebSocket + `MobileSession` | **EXISTE** en `apps/mobile` |
| Credencial en config plana | Android Keystore + cifrado AES-GCM | **EXISTE** en `apps/mobile` |
| Proceso en segundo plano | Foreground Service (`specialUse`) | **EXISTE** en `apps/mobile` |
| Notificación de escritorio | Notificación Android | **EXISTE** en `apps/mobile` |
| Endpoint Cloudflare hardcodeado en `state.rs` | Configuración de endpoint en la app | **DISEÑAR** |
| Timeout de conexión 25 s | `connectTimeout` en OkHttp | **DISEÑAR** (ver nota) |
| `?token=` global | `Authorization: Bearer` individual | **DISEÑAR** (divergencia §8) |
| Ruta `/agents/apollo/default` | Ruta de nodo Android | **DISEÑAR** (divergencia §8) |
| Capabilities de voz/TTS | TTS Android | **DISEÑAR** |
| Sin TTS en Mobile | Reconocimiento de voz | **DISEÑAR** |
| (nada en PC) | `VoiceInteractionService` / rol de Assistant | **DISEÑAR** |
| Overlay de voz | Notificación /Assistant UI | **DISEÑAR** |

**Nota sobre el timeout**: Mobile ya usa `connectTimeout(15s)` en `transport/okhttp.kt`, pero el
socket es de larga vida con `readTimeout(0)`. Son responsabilidades distintas y el equivalente
correcto debe decidirse con criterio, no por copia.

---

## 11. Behavioral specification — tests a leer primero

Estos tests **son** la especificación del protocolo. Están en `07-tests/`.
Orden sugerido de lectura:

| Test | Qué comportamiento fija |
|---|---|
| `enrollment.spec.ts` | Challenge, claim, binding al `deviceId`, un solo uso, reintentos |
| `enrollment-auth.spec.ts` | Que el challenge exige secreto de **dueño**; que la credencial del **dispositivo** no sirve |
| `enrollment-binding.spec.ts` | Que un challenge no se puede reutilizar para otro dispositivo |
| `session.spec.ts` | **El más importante.** Ciclo de vida completo: hello, auth, rechazo, cierre, reconexión |
| `heartbeat.spec.ts` / `heartbeat-scheduler.spec.ts` | Cadencia y que no haya timers duplicados |
| `presence.spec.ts` | online/offline y transiciones |
| `route.spec.ts` | Rutas de enrollment y quién está autorizado |
| `capability.spec.ts` | Registro y resolución de capabilities |
| `apollo-path.spec.ts` | Recorrido completo de un RPC: tool → target → bridge → peer → resultado |
| `endpoint.spec.ts` | Normalización de host, loopback, cleartext |
| `mobile.spec.ts` | Handshake y sesión de un cliente móvil |
| `guards.spec.ts` | Guardas de autorización |
| `wiring.spec.ts` | Que las piezas queden conectadas |
| `credential-migration.spec.ts` | Migración y formato de credenciales |
| `revocation.spec.ts` | Revocación y su efecto |
| `multi-device.spec.ts` | Varios nodos a la vez |
| `execution-path.spec.ts` | Ejecución de comandos y eventos |

`07-tests/peer.ts` es un doble de prueba reutilizable (peer simulado), no un test en sí mismo.

---

## 12. Diagrama

```
Apollo PC                        Apollo Mobile (hoy)
   │                                   │
   │ identity (config)                  │ identity (enrolada, Keystore)
   │ auth (?token= secreto global)      │ auth (Bearer credencial individual)
   │                                   │
   ▼                                   ▼
cloudcore.rs  ──── WSS ───►  transport/okhttp.kt ──── WSS ───►
   │                                                           │
   │  wss://apollo.facupapollo.workers.dev                      │
   │  /agents/apollo/default                                    │
   │  ?token=...                                                │
   │                                                           │
   └──────────────► CLOUDFLARE ◄───────────────────────────────┘
                        │
                        ├── Durable Object  Apollo         (sirve a PC)
                        └── Durable Object  MobileBridge  (sirve a Mobile)
                                │
                                ▼
                     Worker: RPC routing, tools,
                     memoria, presencia

Lo que Android debe replicar del lado del nodo:
  identity · auth · transport WSS · session lifecycle · hello ·
  heartbeat · reconnect/backoff · presence · manejo de RPC ·
  capabilities · almacenamiento seguro de credencial ·
  ejecución en segundo plano

Lo que Android NO debe copiar de PC:
  sidecar.rs · pcbridge.rs · wallpaper.rs · commands.rs ·
  audio de escritorio · wake words · ?token= en la URL
```

---

## 13. Fuente de verdad

Cuando algo de este paquete y el repositorio difieran, **manda el repositorio**. Las copias son
de una foto puntual y no se actualizan solas.

| Pregunta | Archivo autoritativo |
|---|---|
| Qué es el protocolo | `01-protocol/protocol-schema.ts` |
| Cómo autentica PC | `00-architecture/cloudcore.rs` |
| Cuál es el endpoint | `00-architecture/state.rs` |
| Qué acepta el Worker | `04-rpc/apollo.ts`, `04-rpc/mobile-bridge.ts` |
| Cómo se enrola | `02-identity-auth/enrollment.ts` |
| Comportamiento esperado | `07-tests/` |

---

## 14. Avisos

- **No hay secretos reales en este paquete.** Los valores que aparecen en los tests
  (`apollo_dev_0000…`, `test-dashboard…`, `credential-shaped-but-wrong`) son fixtures deliberados y
  utiles: muestran la forma que se valida.
- **Los archivos de Mobile NO están incluidos** (salvo este README, que los describe). Este paquete
  documenta PC y la divergencia; el código de Mobile sigue en `apps/mobile/`.
- `04-rpc/apollo.ts` son 106 KB: es grande pero contiene el routing, la autorización y la
  ejecución de tools. No se puede recortar sin perder contexto.
