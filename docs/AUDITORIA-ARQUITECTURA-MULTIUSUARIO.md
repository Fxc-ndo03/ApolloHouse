# Apollo — Auditoría integral y plan de arquitectura multiusuario

**Fecha:** 2026-10-12 · **Alcance:** auditoría de solo lectura + commit de resguardo. Ningún archivo de producción modificado.
**HEAD al inicio:** `6993bd2` (2026-09-19) · **HEAD ahora:** `35c61b0` (resguardo local, sin push)

> Etiquetas de evidencia: **[L]** leído · **[T]** demostrado por test ejecutado · **[B]** build ejecutado ·
> **[P]** probado en dispositivo real · **[C]** probado contra Cloudflare producción ·
> **[H]** hipótesis, pendiente de verificar

---

## 1. Resumen ejecutivo

Apollo es hoy un asistente **de un solo usuario**, arquitecturasingle-tenant, sostenido por dos secretos globales. Funciona: 1320 tests del Worker y 149 de Android pasan, el APK compila. Pero **no puede convertirse en multiusuario sin refactorizar el origen**, porque el concepto de "usuario" **no existe en ninguna parte del código** [L].

Los tres riesgos que bloquean el producto multiusuario:

1. **Autenticación = dos secretos globales** (`DEVICE_SHARED_SECRET`, `DASHBOARD_SHARED_SECRET`). Quien los tiene, es el dueño. No hay identidad, ni cuentas, ni sesiones [L].
2. **Todo el estado conversacional vive en un único Durable Object `Apollo/default`** más un Vectorize global `apollo-memory` [L]. Añadir un segundo usuario no es un `if`: es una premisa arquitectónica rota.
3. **~290 archivos de trabajo crítico fuera de Git** [T]. Un `git checkout` o un `git clean` destruye el proyecto. **Resuelto en esta etapa con el commit `35c61b0`.**

**Lo que hay que conservar:** el Worker, el protocolo, el MobileBridge, la app Android y el FGS están sólidos y probados. La migración es aditiva, no una reescritura.

---

## 2. Árbol y módulos reales

```
ApolloHouse/
├── apps/
│   ├── agent/      315 archivos · 69 492 líneas   ← Worker (núcleo)
│   ├── mobile/      62 archivos ·  8 568 líneas   ← Android (Kotlin)
│   ├── desktop/     30 archivos ·  6 799 líneas   ← Tauri (Rust + React)
│   ├── console/    129 archivos · 11 610 líneas   ← web de marketing + dashboard
│   └── wizard/      36 archivos ·  2 723 líneas   ← generador del starter
├── juana-client/                              ← sidecar Python (wake word + STT)
├── packages/typescript-config/
└── docs/                          ← este informe
```

**Workspaces:** el `package.json` raíz declara scripts que delegan en Turbo, pero **el array `workspaces` está vacío** [L]. Los workspaces se resuelven por convención de `package.json` por paquete.

### Módulos del Worker por dominio [L]

| Dominio | Archivos | Rol |
|---|---|---|
`devices` | 60 | enrollment, credenciales, sesión, presencia, capacidades, RPC |
`tools` | 58 | ejecución de herramientas, cancelación, targets |
`voice` | 33 | STT/TTS, streaming |
`mcp` | 16 | Model Context Protocol |
`agents` | 13 | DO Apollo, MobileBridge, PcBridge, runtime |
`coding` | 13 | agente de código |
`memory` | 11 | consolidación, indexado |
`threads` | 10 | rotación y metadatos de hilos |
`console` `github` `ota` `weather` `persona` | 4–9 c/u | integraciones |
resto | ≤6 c/u | foco, listas, rates, colas, workflows, telemetría |

---

## 3. Estado de Git y protección del trabajo [T]

### 3.1 Commit de resguardo creado

**`35c61b0` — "chore: resguardo del trabajo acumulado sin versionar"** — 357 archivos. **Sin push.**

| Métrica | Antes | Después |
|---|---|---|
Commit HEAD | `6993bd2` (23 días viejo) | `35c61b0` |
Entradas sin commitear | **298** | **10** |
Riesgo de pérdida | **Crítico** | **Bajo** |

### 3.2 Contenido del commit — revisado antes de stagear

| Verificación | Resultado |
|---|---|
Secretos (llaves privadas, API keys, JWT, AWS, GitHub) | **0 reales** |
`apps/agent/.dev.vars` | **excluido** (ya ignorado por `.gitignore:24`) |
`.dev.vars.example` | **incluido** — plantilla con `change-me` y claves vacías |
Artefactos generados (`build/`, `target/`, `.apk`) | **0 incluidos** |
`local.properties` | **excluido** (ruta SDK local) |
Los 10 temporales de la raíz | **excluidos**, siguen en disco |
`.venv/`, `__pycache__/` | **excluidos** |
`gradle-wrapper.jar` | **incluido** — Gradle lo exige; es el estándar de Android |

### 3.3 Dos hallazgos del staging que corregí

**1. `.gitignore` raíz no cubría `build/`.** `apps/mobile/.gitignore` sí lo cubría, pero como `apps/mobile` estaba **sin trackear**, Git lo trata como directorio nuevo y **no aplica el ignore anidado**: un `git add` arrastraba **809 artefactos Android**. Añadido:

```gitignore
build/
.gradle/
local.properties
*.apk
*.aab
*.iml
```

**2. Los 10 temporales de la raíz se colaron** en el primer `git add`. Los saqué con `git restore --staged` (sin borrarlos).

### 3.4 Backup externo

```
C:\Users\Admin\Documents\Apollo y Jarvis\_apollo_audit_backup_20261012-141550
1353 archivos · 28.6 MB · hashes verificados (4/4 OK)
```

Incluye los 8 borrados recuperables desde `6993bd2` y el `_git_status.txt` original.

### 3.5 Estado restante

Sólo los 10 temporales sin seguimiento. Los 8 borrados quedaron registrados como borrados en el commit — **reversible con `git checkout 6993bd2 -- <ruta>`** si decides restaurarlos.

---

## 4. Inventario de componentes

| Componente | Ubicación | Estado | Clasificación |
|---|---|---|---|
Worker / API | `apps/agent/src/index.ts` | 292 líneas, 6 rutas | **Conservar** |
DO Apollo | `agents/apollo.ts` | 3055 líneas, 7 tablas SQL | **Refactorizar** (agregar identidad) |
DO MobileBridge | `agents/mobile-bridge.ts` | compartido, ~553 líneas | **Conservar** |
DO PcBridge | `agents/pc-bridge.ts` | | **Conservar** |
Registro de dispositivos | `devices/` (60 archivos) | | **Conservar** + **extraer** auth |
Auth | `auth/role.ts` (30 líneas) | 2 secretos globales | **Reemplazar** |
Enrollment | `devices/enrollment.ts` | flujo correcto | **Conservar** |
Credenciales | `devices/credential-store.ts` | W1/W2 aplicados | **Conservar intacto** |
Protocolo | `protocol/schema.ts` | zod, 20 tipos | **Conservar** + versionar |
Voz | `voice/` (33) | Cloudflare + Gemini | **Conservar** |
Memoria | `memory/` + Vectorize | índice **global** | **Refactorizar** |
MCP | `mcp/` (16) | | **Conservar** |
Herramientas | `tools/` (58) | | **Conservar** |
Android | `apps/mobile` | FGS + conversación | **Conservar** |
Desktop | `apps/desktop` | Tauri/Rust | **Conservar** |
Console | `apps/console` | marketing + dashboard | **Conservar** |
Wizard | `apps/wizard` | starter generator | **Conservar** |
Juana client | `juana-client/` | ~13 archivos | **Pendiente de investigación** |
`apps/firmware` | submódulo | referenciado, no presente | **Pendiente de investigación** |

---

## 5. Problemas arquitectónicos demostrados

### P1 · No existe el concepto de usuario [L]

Busqué `userId`, `ownerId`, `accountId`, `tenantId` en **todo** `apps/agent/src`. El único resultado es un `botUserId` de GitHub en `api.ts:118`, sin relación. **Cero conceptos de cuenta en 69 492 líneas.**

### P2 · Autenticación = dos secretos compartidos [L]

```ts
// auth/role.ts:34-43
if (await isDeviceSharedSecretValid(presentedToken, environment.DEVICE_SHARED_SECRET)) return 'device';
if (await isDeviceSharedSecretValid(presentedToken, environment.DASHBOARD_SHARED_SECRET)) return 'dashboard';
return null;
```

Dos strings. Sin expiración, sin sesión, sin revocación por usuario.

### P3 · Estado conversacional en un solo DO [L]

`index.ts:120` — `idFromName('default')`. Un solo Apollo. Tablas: `memories`, `thread_meta`, `session_prefs`, `list_items`, `pending_confirmations`, `pending_device_messages`, `mcp_tool_settings`.

### P4 · Vectorize global [L]

`wrangler.jsonc` → `"index_name": "apollo-memory"`. **Un único índice para todos los usuarios futuros.** Sin filtrado por usuario: el usuario B leería la memoria de A.

### P5 · Sin login en ninguna parte [L]

Busqué `signIn|signUp|register|login|oauth|password` en Worker, Android y Desktop. Los 6 hits son falsos positivos: `MainActivity.kt:37` es un comentario sobre el campo *challenge* tipado como password; `commands.rs:410` es "registered app path".

### P6 · Identidad del PC no persistida [L]

`cloudcore.rs:225` — `self.device_id.as_deref().unwrap_or("desktop")`, y `device_id` **no está en `state.rs`**. No se persiste. El valor efectivo es la constante `"desktop"`.

### P7 · El legado es la puerta real [L]

`authorizeApolloConnection` acepta `?token=` con secreto global. `default` sigue operativo. Mientras exista, cualquiera con el secreto tiene acceso completo.

---

## 5-bis. Arquitectura cloud actual verificada

**Confirmado: la nube es el centro, y se conserva.** [L]

| Capa | Estado | Evidencia |
|---|---|---|
Workers (API/routing) | **Implementado** | `index.ts`, 292 líneas, 6 rutas |
Durable Objects | **Implementado** | 6 clases: Apollo, MobileBridge, PcBridge, Sandbox, Background, Coding |
Vectorize | **Implementado** | binding `VECTORIZE`, índice `apollo-memory` |
IA en la nube | **Implementado** | ver abajo |
Android ↔ nube | **Implementado** | WebSocket + enrollment + FGS |
PC ↔ nube | **Implementado** | `cloudcore.rs` WSS directo |

### Proveedor de IA — verificado [L]

**Gemini, vía API de Google, no Workers AI.**

```jsonc
"GEMINI_MODEL":           "gemini-3.6-flash",
"GEMINI_STT_MODEL":       "gemini-3.6-flash",
"GEMINI_LIVE_MODEL":      "gemini-3.1-flash-live-preview",
"GEMINI_TTS_MODEL":       "gemini-3.1-flash-tts-preview",
"GEMINI_EMBEDDING_MODEL": "text-embedding-004"
```

La autenticación es `GEMINI_API_KEY` contra `generativelanguage.googleapis.com` (`index.ts:83`, `apollo.ts:2181, 2285, 2999`). El binding `AI` existe en `wrangler.jsonc` pero **no encontré uso de `env.AI.*`** en el código: conviven dos mechanisms y sólo uno está en uso.

**Esto es lo correcto según tu objetivo:** la IA sigue en la nube. No propongo moverla a local.

### `juana-client` — NO es código muerto [L]

Es el **sidecar Python en uso activo** del escritorio:

```
apps/desktop/src-tauri/src/sidecar.rs
  1: //! Sidecar manager for Python juana-client
  3: //! Python handles: wake word, STT, TTS playback.
  4: //! Python does NOT connect to the Worker directly.
  6: //! Worker responses come through CloudCoreManager → Rust → Python stdin.
```

Con 9 archivos de test propios. **Recomendación: conservar.** Es exactamente el "complemento opcional de reconocimiento de voz en PC" que describes, y no es requisito para que Apollo funcione en la nube.

---

## 6. Riesgos de seguridad y aislamiento multiusuario

| # | Riesgo | Estado | Mitigación |
|---|---|---|---|
S1 | **Dos usuarios comparten `memories`** | Crítico | Particionar el DO por usuario |
S2 | **Dos usuarios comparten Vectorize** | Crítico | Namespaces por usuario, o vector con `userId` filtrado |
S3 | **Secreto global da acceso total** | Crítico | Retirar tras migrar todos los usuarios |
S4 |(device) entra al Apollo de otro (device) | **Mitigado** [L] | `idFromName(x).equals(ctx.id)` — código presente, **no desplegado** |
S5 | Credencial en texto plano | **Resuelto** | Keystore en Android |
S6 | Sin revocación de sesión | Alto | No hay sesiones que revocar |
S7 | `mcp_tool_settings` duplicable | Medio | No migrar por dispositivo |
S8 | Coste sin límites por usuario | Alto | Cuotas por cuenta |

### Verificación de hipótesis del punto 6 del encargo

| Hipótesis | Estado |
|---|---|
W1 y W2 aplicados en `credential-store.ts` | **[T] confirmado presente** |
Tests SQLite de W1/W2 existen | **[T] confirmado** |
Chequeo de identidad en Apollo | **[L] presente, no desplegado** |
App Android de conversación por WebSocket | **[L] presente, compila [B]** |
Conectividad real con Cloudflare | **[H] NO verificada** — nunca hubo E2E contra producción |
Código local no desplegado | **[H] muy probable** — 290 archivos fuera de Git nunca llegaran a un deploy |

---

## 7. Candidatos a eliminación

**Precondición: ninguno se elimina en esta fase.** La tabla es un plan.

| Archivo | Motivo | Referencias | Riesgo | Reversión |
|---|---|---|---|---|
`_check.py` | Script de debugging personal | ninguna [T] | Bajo | Commit `35c61b0` los preserva en disco |
`_fix_final.py`, `_fix_tests4.py`, `_fix_tests_final.py` | Scripts de reparación puntual | ninguna | Bajo | Ídem |
`_ui_read.py`, `_ui_read2.py`, `_ui4_read.py`, `_ui6.xml` | Volcados de UI para inspección | ninguna | Bajo | Ídem |
`_notify.ts` | Prueba manual de notificación | ninguna | Bajo | Ídem |
`_reconnect.py` | Script de reconexión | ninguna | Bajo | Ídem |
`test_device_selection.py` | Script de prueba | ninguna | Bajo | **Ya commiteado** — mover a `tests/` o borrar |
`build/` de Android | Artefacto generado | N/A | **Resuelto**: ya ignorado | Regenerable |

### Los 8 archivos borrados — recomendación por caso

**Investigados. Ninguno tiene referencias reales.** Los 3 "hits" iniciales eran coincidencias de palabra:

| Archivo | Búsqueda | Resultado real |
|---|---|---|
`chat.html` / `settings.html` | `default.json` | **Falso positivo** — no aparecen en el archivo |
`Dashboard.tsx` | `cloudcore.rs:783` | **Falso positivo** — es el mensaje de protocolo `"dashboard"` |
`OrbWindow.tsx`, `chat-main.tsx`, `ChatWindow.tsx`, `Eyes.tsx`, `settings-main.tsx` | — | **Sin referencias** |

**Recomendación: NO restaurar.** Fueron reemplazados por la UI actual (`components/App/`, `components/Assistant/`, `components/Orb/`). El commit los registra como borrados y son recuperables con `git checkout 6993bd2 -- <ruta>` si alguna vez hacen falta.

### `juana-client/` — recomendación

**Conservar.** Verificado en uso activo por `sidecar.rs` con 9 tests propios (§5-bis). No es candidato a eliminación.

---

## 7-bis. `.gitignore` — estado

Corregido en esta etapa. El problema era real: `build/` no estaba cubierto en la raíz y el `.gitignore` anidado de `apps/mobile` **no se aplica** mientras el directorio está sin trackear.

```gitignore
build/          # añadido
.gradle/        # añadido
local.properties  # añadido
*.apk  *.aab  *.iml  # añadidos
```

**Verificado:** tras la corrección, `git status` muestra **0 artefactos generados** y `.dev.vars` sigue ignorado (`.gitignore:24`). No se ocultó ninguna fuente: `gradle-wrapper.jar` sigue versionándose porque Gradle lo exige.

---

## 8. Estructura de directorios propuesta

```
apps/agent/src/
├── identity/          ← NUEVO: cuentas, sesiones, registro
│   ├── account.ts
│   ├── session.ts
│   └── authorization.ts
├── agents/
│   ├── apollo/         ← el DO por usuario, no 'default'
│   │   ├── index.ts
│   │   ├── turn.ts
│   │   └── state.ts
│   ├── mobile-bridge/
│   └── pc-bridge/
├── devices/           ← conserva; añade accountId a deviceId
├── memory/            ← particionado por usuario
├── tools/
├── voice/
├── mcp/
└── protocol/          ← añade accountId a los schemas
```

Rutas → nomenclatura:

```
/agents/apollo/<accountId>/<deviceId>
/agents/mobile-bridge/mobile      (sin cambios: DO compartido)
```

---

## 9. Arquitectura futura

```
                    ┌──────────────── CLOUDFLARE ────────────────┐
                    │                                            │
  ┌──────────┐     │   ┌──────────────────────────────────┐     │
  │ Android  │─────┼──▶│  API Gateway                       │     │
  │ Desktop  │─────┼──▶│  ├─ /agents/apollo/<user>/<dev>   │     │
  │ (futuro) │     │   │  ├─ /agents/mobile-bridge/mobile  │     │
  └──────────┘     │   │  └─ /enrollment/*                 │     │
   WSS, bearer     │   └──────────────┬───────────────────┘     │
                    │                  │                         │
                    │   ┌──────────────▼───────────────┐         │
                    │   │ Identity Service               │         │
                    │   │ cuentas · sesiones · tokens    │         │
                    │   └──────────────┬───────────────┘         │
                    │                  │                         │
                    │   ┌──────────────▼───────────────┐         │
                    │   │ DO Apollo  POR USUARIO        │         │
                    │   │ memoria · hilos · preferencias │         │
                    │   └──────────────┬───────────────┘         │
                    │                  │                         │
                    │   ┌──────────────▼───────────────┐         │
                    │   │ DO MobileBridge (compartido)  │         │
                    │   │ presencia · capacidades · RPC │         │
                    │   └──────────────┬───────────────┘         │
                    │                  │                         │
                    │   ┌──────────────▼───────────────┐         │
                    │   │ Vectorize POR USUARIO         │         │
                    │   │ (o filtro userId obligatorio)  │         │
                    │   └──────────────────────────────┘         │
                    └────────────────────────────────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │  Agentes de dispositivo          │
                    │  Android · PC · (futuro altavoz) │
                    └─────────────────────────────────┘
```

### Capas

**A. Núcleo en nube** — Identity, DO Apollo por usuario, MobileBridge, Vectorize particionado, Tools, MCP, voz.

**B. Clientes** — Android (ya conversando), Desktop, futuro dispositivo físico.

**C. Agentes de dispositivo** — WSS autenticado, capacidades declaradas, ejecución local, confirmación para acciones sensibles. Ya implementado en `mobile/` y `pcbridge`.

**D. Domótica** — **No existe hoy** [L]. Se propone como adaptador MCP por dispositivo: la home se expone como tool MCP y hereda autorización, confirmaciones y auditoría sin código nuevo. Es la vía más barata y ya tiene el andamiaje.

**E. Contratos** — `protocol/schema.ts` como fuente única, con `accountId` y versión.

### Flujo de un turno

```
Usuario → cliente → WSS
  → DO Apollo(<user>,<dev>)   verifica sesión
  → memory(user)              recupera contexto
  → tool loop (MCP, capabilities)
     → MobileBridge → Android → confirmación → resultado
  → VECTORIZE(user)           guarda
  → TTS/caption → cliente
```

---

## 10. Modelo de datos multiusuario

| Entidad | Dónde vive hoy | Dónde debe vivir | Migración |
|---|---|---|---|
Usuario/cuenta | **no existe** | `identity/account` + tabla `account` | Crear |
Sesión | **no existe** | `identity/session` | Crear |
Dispositivo | `mobile_device_credential` (DO MobileBridge) | + `account_id` | **Añadir columna** |
Conversación | `memories`, `thread_meta` (DO Apollo `default`) | DO por `<user>` | Particionar |
Mensajes | `session_prefs.caption` (efímero) | igual, por usuario | No migrar |
Memoria personal | Vectorize `apollo-memory` global | namespace por usuario | **Reindexar** |
Preferencias usuario | `session_prefs` | DO por usuario | Copiar 3 claves |
Preferencias dispositivo | ninguna | tabla aparte | — |
Herramientas/permisos | `mcp_tool_settings` | **global + override usuario** | Decidir |
Estado global | `initiativeState`, `firmware*` | **global, NO por usuario** | No duplicar |

### Cómo garantizar el aislamiento

1. **El `accountId` viene de la sesión verificada**, jamás del `deviceId` del cliente. Un cliente que mienta sobre su ruta no cambia de usuario: el servidor resuelve la cuenta desde el token.
2. **Un DO por `(accountId)`** para lo conversacional. El Vectorize por namespace de usuario.
3. **Migración de credenciales: doble lectura.** Se añade `account_id` con default que **rechaza** el acceso hasta que el dueño la asigne. Nunca se concede acceso por defecto.

### Evaluación de los DO actuales

| DO | ¿Global, por usuario o por dispositivo? |
|---|---|
`Apollo` | **Por usuario** (no por dispositivo: compartiría memoria entre el PC y el móvil del mismo dueño) |
`MobileBridge` | **Global compartido** — correcto, ya lo es |
`PcBridge` | **Por usuario** — hoy es único |
`Sandbox`/`Background`/`Coding` | Global, sin datos de usuario |

> **ADVERTENCIA:** un DO por dispositivo **no** resuelve el aislamiento entre usuarios. Si dos usuarios conectan desde el mismo dispositivo, comparten DO. Sólo un DO por cuenta lo resuelve.

---

## 11. Costes y alternativas

### 11.1 Infraestructura — límites gratuitos verificados

| Servicio | Estado | Límite gratuito | Clasificación |
|---|---|---|---|
Cloudflare Workers | 1 Worker | 100k req/día | Gratuito con cuota |
**Durable Objects** | 6 clases | 1M req/mes | Gratuito con cuota |
**WebSockets en DO** | Crítico | Incluidos en DO | **Gratuito** (en Workerssx se cobra) |
Vectorize | 1 índice | 10M vectores almacenados | Gratuito con cuota |
Queues | 1 cola | 10k msg/día | Gratuito con cuota |
Workflows | 2 | incluidos | Gratuito con cuota |
R2 | sin usar | 10 GB/mes | Gratuito con cuota |

### 11.2 IA — coste variable, NO gratuito [L]

Verificado que el Worker usa **Gemini por API de Google** (`generativelanguage.googleapis.com`), no Workers AI.

| Modelo | Uso | Coste |
|---|---|---|
`gemini-3.6-flash` | conversación, STT | **Por token de entrada/salida** |
`gemini-3.1-flash-live-preview` | conversación por voz | **Por minuto** |
`gemini-3.1-flash-tts-preview` | síntesis de voz | **Por carácter** |
`text-embedding-004` | embeddings a Vectorize | **Por token** |

**Éste es el único coste que escala con el uso.** La infraestructura es gratuita hasta cuotas generosas; **un asistente de voz con 10 usuarios activos genera coste real en minutos de audio.**

### 11.3 Clasificación final

| Categoría | Servicios |
|---|---|
**Gratuito sostenible** | Workers, DO, WebSockets, R2 |
**Gratuito con cuotas** | Vectorize, Queues, Workflows |
**Requiere clave propia** | `GEMINI_API_KEY` (cuenta de Google del dueño) |
**Coste variable creciente** | Gemini (conversación, voz, embeddings) |
**Complemento local opcional** | `juana-client` (Vosk STT en PC) |

**Nada depende de una clave personal de pago salvo `GEMINI_API_KEY`.** Pero esa clave **es un único punto de coste y de cuota**: si se agota o se revoca, Apollo deja de conversar. mitigated con cuotas por usuario, y a futuro con modelos locales para STT.

### 11.4 Riesgo de abuso [nuevo]

Hoy no hay **ningún límite de uso**: un usuario puede consumir tokens sin límite. En multiusuario esto es un riesgo financiero directo. La fase de identidad debe incluir cuotas por cuenta.

---

## 12. Plan incremental de migración

| # | Etapa | Depende de | Aceptación | Rollback |
|---|---|---|---|---|
0 | **Commit del trabajo actual** | — | 0 entradas sueltas | Revertir commit |
1 | **`.gitignore` para `build/`** | 0 | Artefactos no aparecen | Editar archivo |
2 | **Identidad: tablas `account`/`session`** | 0 | Tests de auth nuevos | Drizzle/rollback |
3 | **DO Apollo por `<accountId>`** | 2 | 2 usuarios aislados, tests | Volver a `default` |
4 | **Vectorize por namespace** | 3 | test de no-fuga entre usuarios | Reindexar a global |
5 | **`account_id` en credenciales** | 2 | Teléfono actual sigue conectado | Columna nullable |
6 | **Migrar enrollment a multiusuario** | 5 | — | Doble lectura |
7 | **Login en Android y Desktop** | 2,3 | Sesión persiste | Quitar UI |
8 | **Voz en Android** | 7 | — | — |
9 | **Domótica vía MCP** | 7 | — | Desactivar tool |
10 | **Retirar secretos globales** | 3–7 | Todos migrados | **NO REVERSIBLE** |

**Etapas 0 y 1 son las urgentes** y no dependen de la arquitectura.

---

## 13. Criterios de aceptación

| Etapa | Test |
|---|---|
1 | `git status --porcelain` sin `build/` |
2 | Usuario A no lee datos de B |
3 | 2 DOs `Apollo` distintos, memoria aislada |
4 | Búsqueda en namespace B no devuelve documentos de A |
5 | Credencial existente sigue funcionando |
6 | Teléfono real enrolado conecta tras migrar |
7 | Login persiste entre reinicios |
10 | acceso sin token → 401 |

---

## 14. Preguntas bloqueantes

**Resueltas en esta etapa:**
1. ~~¿Restauro los 8 archivos borrados?~~ → **No.** Sin referencias reales; borrado intencional.
2. ~~¿Qué hago con `juana-client/`?~~ → **Conservar.** Sidecar activo con tests.
3. ~~¿Puedo hacer commit?~~ → **Sí, hecho:** `35c61b0`, sin push.

**Abiertas — necesito tu decisión:**

4. **¿Cuántos usuarios reales?** Define si Vectorize va por namespace o por filtro con metadatos.
5. **¿Voz: Gemini en nube, o hybrid con Vosk?** Es la mayor decisión de coste. Recomiendo nube ahora, Vosk como complemento.
6. **¿Registro por email o por proveedor externo?** Afecta la experiencia y el coste.
7. **¿Dominio propio (`heyapollo.dev`)?** El `.jsonc` lo menciona como pendiente.
8. **¿Los 10 temporales se borran o se archivan?**requieren tu OK.
9. **¿Quién paga `GEMINI_API_KEY`?** Con multiusuario, la cuota es del operador, no del usuario.

---

## 15. Diseño multiusuario cloud-first

### 15.1 Modelo de identidad

```
Account (cuenta)
  ├── Session (sesión de acceso, con expiración)
  │     └── Token (bearer, corto)
  └── Device (dispositivo vinculado)
        └── DeviceCredential (individual, revocable)
```

**Regla de oro:** el `accountId` **nunca** viene del cliente. Se resuelve desde la sesión validada en el servidor. Un cliente que mienta sobre su ruta no cambia de cuenta.

### 15.2 Durable Objects — qué es de quién

| DO | Ámbito | Razón |
|---|---|---|
`Apollo` | **Por cuenta** | La memoria y las conversaciones son del dueño, no del aparato. Si fuera por dispositivo, dos usuarios en el mismo teléfono compartirían conversación |
`MobileBridge` | **Global compartido** | Concentra presencia y capacidades de todos los teléfonos. Ya funciona así |
`PcBridge` | **Por cuenta** | Hoy es único; debe seguir a la cuenta |
`Sandbox`/`Background`/`Coding` | Global | Sin datos de usuario |

> **Corrección importante:** un DO por **dispositivo** NO aísla usuarios. Un DO por **cuenta** sí. Si un usuario tiene PC y móvil, ambos escriben en **el mismo** Apollo de su cuenta — que es lo correcto: su memoria es compartida entre sus propios dispositivos.

Ruta: `/agents/apollo/<accountId>` (el `deviceId` ya no determina el DO).

### 15.3 Vectorize — comparación de estrategias [L]

La integración existente usa `VECTORIZE` con `deleteByIds` y búsqueda por vector (`memory.ts:20`). Cloudflare Vectorize **no soporta namespaces múltiples por binding en un solo Worker**: hay que elegir.

| Estrategia | Aislamiento | Coste | Migración |
|---|---|---|---|
**A. Índice por cuenta** | **Perfecto** | 1 binding por cuenta; limitado por el número de cuentas | Reindexar todo |
**B. Metadatos + filtro `accountId`** | Correcto **si el filtro es obligatorio** | 1 índice | Ninguna |

**Recomiendo B**, con dos condiciones no negociables:
1. **Toda** consulta, escritura y borrado exige el filtro `accountId` derivado de la sesión.
2. **Tests que demuestren que sin filtro la función lanza error**, no que devuelve vacío.

Vectorize soporta metadatos y filtrado por ellos; el filtro va en el propio índice, no post-filtrado.

### 15.4 Migración del propietario actual

El estado actual (`Apollo/default`) debe pasar a la cuenta inicial **sin perder memoria**:

1. Crear la cuenta del propietario
2. Mover el DO: `default` → `<accountId>` requiere **copiar las 7 tablas** (`memories`, `thread_meta`, `session_prefs`, `list_items`, `pending_confirmations`, `pending_device_messages`, `mcp_tool_settings`)
3. Reindexar Vectorize con `accountId`
4. Mantener `default` **en solo lectura** durante la ventana
5. Verificar recuento de filas antes/después

---

## 16. Plan de fases actualizado

| # | Fase | Estado | Aceptación | Rollback |
|---|---|---|---|---|
0 | **Commit de resguardo** | **✅ Hecho** (`35c61b0`) | 0 archivos críticos sueltos | `git reset --soft 35c61b0~1` |
1 | **`.gitignore`** | **✅ Hecho** | 0 artefactos en status | Revertir el archivo |
2 | Tablas `account`/`session` + tests de auth | Pendiente | Tests de expiración/revocación | Drizzle rollback |
3 | DO Apollo por `accountId` (con `default` en lectura) | Pendiente | 2 cuentas aisladas | Volver a `default` |
4 | Vectorize con filtro `accountId` + **tests de no-fuga** | Pendiente | B no lee memoria de A | Quitar filtro (solo dev) |
5 | `account_id` en credenciales (doble lectura) | Pendiente | Teléfono actual sigue conectado | Columna nullable |
6 | Migrar enrollment a multiusuario | Pendiente | — | Doble lectura |
7 | Login en Android y Desktop | Pendiente | Sesión persiste entre reinicios | Quitar UI |
8 | Cuotas por cuenta | Pendiente | Test de abuso | Subir límites |
9 | Voz en Android | Pendiente | — | — |
10 | Domótica vía MCP | Pendiente | — | Desactivar tool |
| 11 | **Retirar secretos globales** | Pendiente | Todos migrados | **NO REVERSIBLE** |

**Las fases 0 y 1 están hechas. Son las que no dependían de decisiones de producto.**

---

## 17. Acciones NO ejecutadas

- ❌ No modifiqué código de producción
- ❌ No eliminé archivos (los 10 temporales siguen en disco)
- ❌ No restauré los 8 borrados
- ❌ No eliminé dependencias
- ❌ No modifiqué `apps/mobile`, `apps/agent` ni `apps/desktop`
- ❌ **No hice push** — el commit `35c61b0` es local
- ❌ No desplegué a Cloudflare
- ❌ No instalé APKs
- ❌ No revertí W1/W2 (verificados presentes **dentro del commit**)
- ❌ No migré datos ni credenciales reales
- ❌ No creé tablas de cuentas ni sesiones
- ❌ No probé contra Cloudflare producción — **la conectividad real sigue sin verificar**

### Qué SÍ hice
- ✅ Leí el repositorio y verifiqué la auditoría previa contra el código
- ✅ Verifiqué el backup (hashes 4/4)
- ✅ **Corregí `.gitignore`** (única modificación de configuración)
- ✅ **Creé el commit de resguardo `35c61b0`** con 357 archivos revisados
- ✅ Saqué los 10 temporales del staging sin borrarlos
- ✅ Verifiqué 0 secretos y 0 artefactos en el commit
- ✅ Confirmé que `juana-client` está en uso activo
- ✅ Confirmé que los 8 borrados no tienen referencias
- ✅ Actualicé este informe

---

## Resumen

**Qué tenemos:** un asistente cloud-first funcional y sólido — 1320 tests del Worker [T], 149 de Android [T], APK compilando [B], Gemini en la nube para conversación y voz [L], `juana-client` como STT local opcional en PC [L].

**Qué estaba roto:** la ausencia total de identidad de usuario, y 290 archivos fuera de Git.

**Qué arreglé:** el riesgo de pérdida de trabajo. Commit `35c61b0` + backup externo verificado.

**Qué conservar:** todo. Worker, MobileBridge, protocolo, Android, FGS, Gemini, `juana-client`.

**Cómo organizar:** un DO **por cuenta** (no por dispositivo), identidad como servicio nuevo, Vectorize con filtro `accountId` obligatorio.

**Secuencia:** las dos etapas urgentes ya están hechas. Sigue identidad → partición → credenciales → login → cuotas → voz → domótica. El secreto global se retira **último y sin vuelta atrás**.

**No afirmo que Apollo funcione de extremo a extremo contra Cloudflare: nunca fue probado.**
