# Inventario — Apollo PC → porting a Android

Paquete: `docs/apollo-pc-mobile-porting/` · 62 archivos · 768.7 KB

**Prioridades** — P0 imprescindible · P1 muy importante · P2 contexto · P3 innecesario

| Archivo | Categoría | Prio | Propósito | Dependencias | En paquete |
|---|---|---|---|---|---|
| `00-architecture/cloudcore.rs` | A Esencial | **P0** | El nodo Apollo: WSS, hello, heartbeat, backoff 2s→60s, timeout 25s | `state.rs` | ✅ |
| `00-architecture/state.rs` | A Esencial | **P0** | Config y **endpoint Cloudflare** (`state.rs:152`) | — | ✅ |
| `00-architecture/lib.rs` | A Esencial | P1 | Bootstrap de la app Tauri | `cloudcore.rs` | ✅ |
| `01-protocol/protocol-schema.ts` | B Contrato | **P0** | **Fuente de verdad del protocolo**: zod schemas, `hello`, heartbeat, payload de notificación | `devices/schema.ts` | ✅ |
| `01-protocol/devices-schema.ts` | B Contrato | P1 | Schemas de dispositivos | `protocol-schema.ts` | ✅ |
| `01-protocol/envelope.ts` | B Contrato | P1 | Sobre de mensajes WebSocket | `protocol-schema.ts` | ✅ |
| `02-identity-auth/identity.ts` | A Esencial | **P0** | Resolución y validación de `deviceId` | `protocol-schema.ts` | ✅ |
| `02-identity-auth/enrollment.ts` | A Esencial | **P0** | Challenge → claim → credencial; un solo uso, ligado al dispositivo | `identity.ts`, `credential-store.ts`, `route.ts` | ✅ |
| `02-identity-auth/credential-store.ts` | A Esencial | **P0** | Almacén de credenciales, revocación, `pruneChallenge` | `enrollment.ts` | ✅ |
| `02-identity-auth/route.ts` | A Esencial | **P0** | Rutas `/enrollment/*` y quién puede llamarlas | `enrollment.ts`, `auth/token.ts` | ✅ |
| `02-identity-auth/token.ts` | A Esencial | **P0** | Bearer, roles, comparación timing-safe | — | ✅ |
| `02-identity-auth/role.ts` | A Esencial | P1 | Roles de autorización | `token.ts` | ✅ |
| `02-identity-auth/http.ts` | A Esencial | P1 | Lectura del header de autorización | `token.ts` | ✅ |
| `03-session-transport/session.ts` | A Esencial | **P0** | Ciclo de vida de la sesión del lado Worker | `connection.ts`, `heartbeat.ts`, `presence.ts` | ✅ |
| `03-session-transport/connection.ts` | A Esencial | **P0** | Conexión WebSocket en el DO | `protocol-schema.ts` | ✅ |
| `03-session-transport/heartbeat.ts` | A Esencial | **P0** | Cadencia de heartbeat | `session.ts` | ✅ |
| `03-session-transport/presence.ts` | A Esencial | **P0** | online/offline | `session.ts` | ✅ |
| `03-session-transport/endpoint.ts` | A Esencial | **P0** | Normalización de host, loopback, cleartext | `protocol-schema.ts` | ✅ |
| `03-session-transport/bridge-client.ts` | A Esencial | P1 | Cliente hacia el bridge | `endpoint.ts` | ✅ |
| `03-session-transport/dispatch.ts` | A Esencial | P1 | Enrutado de mensajes y errores | `session.ts` | ✅ |
| `04-rpc/apollo.ts` | A Esencial | **P0** | DO `Apollo`: routing, autorización, tools, RPC hacia PC | `protocol-schema.ts`, `rpc.ts`, `devices/target.ts` | ✅ |
| `04-rpc/mobile-bridge.ts` | A Esencial | **P0** | DO `MobileBridge`: el otro lado de la divergencia | `protocol-schema.ts`, `devices/payload.ts` | ✅ |
| `04-rpc/rpc.ts` | A Esencial | **P0** | Envoltura del protocolo RPC | `protocol-schema.ts` | ✅ |
| `04-rpc/target.ts` | A Esencial | **P0** | Decide a qué nodo va un RPC | `capability.ts` | ✅ |
| `04-rpc/resolve.ts` | A Esencial | P1 | Resolución de destino | `target.ts` | ✅ |
| `04-rpc/command.ts` | A Esencial | P1 | Catálogo de comandos | `protocol-schema.ts` | ✅ |
| `04-rpc/execution-event.ts` | A Esencial | P2 | Eventos durante la ejecución | `command.ts` | ✅ |
| `05-capabilities/capability.ts` | A Esencial | **P0** | Registro y resolución de capabilities | `protocol-schema.ts` | ✅ |
| `05-capabilities/payload.ts` | B Contrato | **P0** | **Un schema por comando**, validado en los tres lados | `protocol-schema.ts` | ✅ |
| `05-capabilities/mobile.ts` | A Esencial | **P0** | Capacities de móvil | `capability.ts` | ✅ |
| `05-capabilities/mobile-intent.ts` | A Esencial | P1 | Intenciones móviles | `mobile.ts` | ✅ |
| `05-capabilities/intent.ts` | A Esencial | P1 | Intenciones genéricas | `capability.ts` | ✅ |
| `05-capabilities/events.ts` | A Esencial | P2 | Eventos de ejecución | `capability.ts` | ✅ |
| `06-pc-platform/sidecar.rs` | C PC-only | P2 | Proceso Python de voz — **no portar** | — | ✅ |
| `06-pc-platform/pcbridge.rs` | C PC-only | P2 | Audio del sistema — **no portar** | — | ✅ |
| `06-pc-platform/commands.rs` | C PC-only | P1 | Comandos Tauri y config | `state.rs` | ✅ |
| `06-pc-platform/wallpaper.rs` | C PC-only | P3 | Fondo animado — **no portar** | — | ✅ |
| `06-pc-platform/main.rs` | C PC-only | P3 | Entry point binario | — | ✅ |
| `06-pc-platform/pc-bridge.ts` | C PC-only | P2 | Lado Worker del bridge de PC | `apollo.ts` | ✅ |
| `07-tests/session.spec.ts` | F Tests | **P0** | **Especificación del ciclo de vida de sesión** | `session.ts` | ✅ |
| `07-tests/enrollment.spec.ts` | F Tests | **P0** | Challenge, claim, binding, un solo uso | `enrollment.ts` | ✅ |
| `07-tests/enrollment-auth.spec.ts` | F Tests | **P0** | Separación dueño vs dispositivo en la autorización | `route.ts`, `token.ts` | ✅ |
| `07-tests/apollo-path.spec.ts` | F Tests | **P0** | Recorrido completo de un RPC | `apollo.ts`, `target.ts` | ✅ |
| `07-tests/heartbeat.spec.ts` | F Tests | P1 | Cadencia de heartbeat | `heartbeat.ts` | ✅ |
| `07-tests/heartbeat-scheduler.spec.ts` | F Tests | P1 | **Sin schedulers duplicados** | `heartbeat.ts` | ✅ |
| `07-tests/presence.spec.ts` | F Tests | P1 | Transiciones online/offline | `presence.ts` | ✅ |
| `07-tests/capability.spec.ts` | F Tests | P1 | Registro y resolución | `capability.ts` | ✅ |
| `07-tests/endpoint.spec.ts` | F Tests | P1 | Host, loopback, cleartext | `endpoint.ts` | ✅ |
| `07-tests/route.spec.ts` | F Tests | P1 | Rutas de enrollment | `route.ts` | ✅ |
| `07-tests/mobile.spec.ts` | F Tests | P1 | Handshake de cliente móvil | `mobile.ts` | ✅ |
| `07-tests/guards.spec.ts` | F Tests | P1 | Guardas de autorización | `apollo.ts` | ✅ |
| `07-tests/wiring.spec.ts` | F Tests | P1 | Piezas conectadas | varios | ✅ |
| `07-tests/credential-migration.spec.ts` | F Tests | P2 | Migración y formato de credenciales | `credential-store.ts` | ✅ |
| `07-tests/revocation.spec.ts` | F Tests | P2 | Revocación | `credential-store.ts` | ✅ |
| `07-tests/multi-device.spec.ts` | F Tests | P2 | Varios nodos simultáneos | `session.ts` | ✅ |
| `07-tests/execution-path.spec.ts` | F Tests | P2 | Ejecución de comandos | `apollo.ts` | ✅ |
| `07-tests/enrollment-binding.spec.ts` | F Tests | P1 | Challenge ligado a un dispositivo | `enrollment.ts` | ✅ |
| `07-tests/peer.ts` | F Tests | P1 | Doble de prueba reutilizable | `protocol-schema.ts` | ✅ |
| `08-config/wrangler.jsonc` | E Config | **P0** | Bindings y DO del Worker (**sin secretos**) | — | ✅ |
| `08-config/tauri.conf.json` | E Config | P2 | Config de build de PC | — | ✅ |
| `08-config/Cargo.toml` | E Config | P2 | Dependencias Rust (**revela `tokio-tungstenite`**) | — | ✅ |
| `08-config/package.json` | E Config | P3 | Dependencias del frontend UI | — | ✅ |

---

## Archivos compartidos —Should be the source of truth

Estos archivos viven en el Worker (`apps/agent`) pero definen el protocolo **de cualquier nodo**,
no de Mobile en particular. No se deben mover ni duplicar:

| Archivo | Por qué es compartido |
|---|---|
| `01-protocol/protocol-schema.ts` | Define `hello`, heartbeat, credenciales y payloads. Mobile lo consume igual que PC. |
| `02-identity-auth/credential-store.ts` | El modelo de credencial individual **es** el modelo de nodo. |
| `04-rpc/rpc.ts` | Sobre de RPC común. |
| `03-session-transport/endpoint.ts` | Política de transporte (loopback, cleartext, TLS) aplicable a cualquier nodo. |

## Resumen de prioridades

| Prioridad | Cantidad |
|---|---|
| **P0** | **19** |
| **P1** | 24 |
| **P2** | 14 |
| **P3** | 4 |

*(19 P0 + 24 P1 + 14 P2 + 4 P3 = 61 archivos + `README.md` = 62)*

## No incluidos, y por qué

| No incluido | Motivo |
|---|---|
| `apps/mobile/**` | Fuera de alcance: este paquete documenta PC y la divergencia. El código de Mobile no se copia. |
| `.dev.vars` | **Secretos reales.** Nunca copiar. |
| `ui/src/**` (React) | UI de escritorio sin comportamiento de nodo. Los componentes de Assistant/Orb no aportan al protocolo. |
| `src-tauri/target/**` | Artefactos de build. |
| `src-tauri/resources/**` | Runtime Python empaquetado. |
| `node_modules/**` | Dependencias. |
| `src-tauri/gen/**` | Schemas generados por Tauri. |
| `src/agents/runtime.ts` | Voice turns, 54 KB, ortogonal al protocolo de nodo. |
| `src/agents/notify.ts`, `effects.ts`, `dashboard.ts` | Notificaciones y efectos, no de nodo. |
| `src/devices/{registry,idempotency,inspector,harness,exposure}.ts` | Registros y herramientas de diagnóstico; útiles pero no imprescindibles para el primer diseño. |
