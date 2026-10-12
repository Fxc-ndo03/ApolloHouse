# Apollo — Auditoría integral y plan de arquitectura multiusuario

**Fecha:** 2026-10-12 · **Alcance:** auditoría de solo lectura. Ningún archivo de producción modificado.
**Commit:** `6993bd2` (2026-09-19) — el trabajo reciente **no está en Git**.

> Etiquetas de evidencia: **[L]** leído · **[T]** demostrado por test ejecutado · **[B]** build ejecutado ·
> **[P]** probado en dispositivo real · **[C]** probado contra Cloudflare producción ·
> **[H]** hipótesis, pendiente de verificar

---

## 1. Resumen ejecutivo

Apollo es hoy un asistente **de un solo usuario**, arquitecturasingle-tenant, sostenido por dos secretos globales. Funciona: 1320 tests del Worker y 149 de Android pasan, el APK compila. Pero **no puede convertirse en multiusuario sin refactorizar el origen**, porque el concepto de "usuario" **no existe en ninguna parte del código** [L].

Los tres riesgos que bloquean el producto multiusuario:

1. **Autenticación = dos secretos globales** (`DEVICE_SHARED_SECRET`, `DASHBOARD_SHARED_SECRET`). Quien los tiene, es el dueño. No hay identidad, ni cuentas, ni sesiones [L].
2. **Todo el estado conversacional vive en un único Durable Object `Apollo/default`** más un Vectorize global `apollo-memory` [L]. Añadir un segundo usuario no es un `if`: es una premisa arquitectónica rota.
3. **~290 archivos de trabajo crítico fuera de Git** [T]. Un `git checkout` o un `git clean` destruye el proyecto. Es el riesgo inmediato y no tiene relación con la arquitectura.

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
├── packages/typescript-config/
└── docs/                          ← informe generado en esta auditoría
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

**Este es el hallazgo más urgente y no es arquitectónico.**

| Métrica | Valor |
|---|---|
Commit HEAD | `6993bd2` — **2026-09-19** (23 días atrás) |
Entradas sin commitear | **298** |
Modificados (M) | 237 |
Sin seguimiento (??) | 53 |
**Borrados (D)** | **8** |

### 3.1 Archivos borrados respecto de HEAD

```
apps/desktop/ui/chat.html            apps/desktop/ui/src/Dashboard.tsx
apps/desktop/ui/settings.html        apps/desktop/ui/src/OrbWindow.tsx
apps/desktop/ui/src/chat-main.tsx    apps/desktop/ui/src/components/Chat/ChatWindow.tsx
                                     apps/desktop/ui/src/components/Eyes/Eyes.tsx
                                     apps/desktop/ui/src/settings-main.tsx
```

Estos son de la UI del escritorio. **No los restauré**: no sé si fueron borrados a propósito (reemplazo por la UI actual) o por accidente. Requeriría decisión tuya.

### 3.2 Código de producción crítico sin seguimiento

```
?? apps/agent/src/devices/            ← TODO el dominio de dispositivos
?? apps/agent/src/agents/mobile-bridge.ts
?? apps/agent/src/tools/              ← 58 archivos
?? apps/mobile/...                   ← la app Android completa
```

`credential-store.ts` —donde viven W1 y W2— **no está en Git**. `git checkout` lo destruye sin dejar rastro.

### 3.3 `.gitignore` incompleto

Ignora `node_modules/`, `dist/`, `target/`, `.wrangler/`, `*.tsbuildinfo`. **No ignora `build/`**, aunque `apps/mobile/.gitignore` existe. Artefactos Androidgenerated podrían colarse en cualquier commit.

### 3.4 Backup ejecutado

```
C:\Users\Admin\Documents\Apollo y Jarvis\_apollo_audit_backup_20261012-141550
1353 archivos · 28.6 MB · hashes verificados
```

Incluye los 8 borrados recuperables desde HEAD y el `_git_status.txt` original. **Este backup es la red de seguridad antes de cualquier refactorización.**

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

`wrangler.jsonc` → `"index_name": "apollo-memory"`. **Un único índice para todos los usuarios futuros.** Sin filtrado por usuario, el usuario B leería la memoria de A.

### P5 · Sin login en ninguna parte [L]

Busqué `signIn|signUp|register|login|oauth|password` en Worker, Android y Desktop. Los 6 hits son falsos positivos: `MainActivity.kt:37` es un comentario sobre el campo *challenge* tipado como password; `commands.rs:410` es "registered app path".

### P6 · Identidad del PC no persistida [L]

`cloudcore.rs:225` — `self.device_id.as_deref().unwrap_or("desktop")`, y `device_id` **no está en `state.rs`**. No se persiste. El valor efectivo es la constante `"desktop"`.

### P7 · El legado es la puerta real [L]

`authorizeApolloConnection` acepta `?token=` con secreto global. `default` sigue operativo. Mientras exista, cualquiera con el secreto tiene acceso completo.

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
`_check.py` | Script de debugging personal | ninguna [T] | Bajo | Git/backup |
`_fix_final.py`, `_fix_tests4.py`, `_fix_tests_final.py` | Scripts de reparación puntual | ninguna | Bajo | Git/backup |
`_ui_read.py`, `_ui_read2.py`, `_ui4_read.py`, `_ui6.xml` | Volcados de UI para inspección | ninguna | Bajo | Git/backup |
`_notify.ts` | Prueba manual de notificación | ninguna | Bajo | Git/backup |
`_reconnect.py` | Script de reconexión | ninguna | Bajo | Git/backup |
`test_device_selection.py` | Script de prueba | ninguna | Bajo | Git/backup |
`build/` de Android | Artefacto generado | N/A | **Añadir a .gitignore, no borrar** | Regenerable |
`juana-client/`, `juana_client/` | Posible código muerto | **parcial** | **Alto** | Git/backup |

**Advertencia sobre `juana-client`:** hay archivos modificados ahí (`juana-core client` aparece en el commit `2791b74`). **No lo marco como eliminable** sin que decidas.

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

| Servicio | Hoy | Coste | Alternativa libre |
|---|---|---|---|
Cloudflare Workers | 1 Worker | **Gratis hasta 100k req/día** | — |
DO | 6 clases | **Gratis**: 1M req/mes | — |
**WebSockets** | Crítico | **Gratis en DO**; en Workerssx, cobro por duración | — |
Vectorize | 1 índice | Gratis hasta 10M vectores | SQLite + FTS5 |
R2 | sin usar | Gratis 10 GB/mes | — |
Queues | 1 cola | Gratis 10k msg/día | — |
**AI (Gemini/Cloudflare)** | Activo | **Costo por token.** Esto **no** es gratis | Modelos locales (ollama) para STT/TTS básico |
Voz STT/TTS | Gemini + Cloudflare | **Costo por minuto** | Vosk (ya integrado en PC) + Piper |
E2EE / Almacenamiento | R2 | Gratis acotado | — |

**Riesgo económico real:** el **tráfico de IA y voz**, no la infraestructura. Un asistente de voz siempre cuesta tokens. Mitigación: modelos pequeños por defecto, cacheo, y permitir modelos locales.

**Nada depende de una clave personal**, salvo el despliegue de Cloudflare del dueño.

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

1. **¿Restauro los 8 archivos borrados de la UI del desktop?** No sé si fue intencional.
2. **¿Qué hago con `juana-client/`?** Tiene cambios sin commitear y no sé si se usa.
3. **¿Cuántos usuarios reales?** Define si Vectorize por namespace o por filtro.
4. **¿Sigo con Gemini/Cloudflare para voz, o local?** Es la mayor decisión de coste.
5. **¿Dominio propio (`heyapollo.dev`)?** El `.jsonc` lo menciona como pendiente.
6. **¿Puedo hacer commit del trabajo actual?** Sin eso, cada `git checkout` es una pérdida.

---

## 15. Acciones NO ejecutadas

- ❌ No modifiqué código de producción
- ❌ No eliminé archivos (incluidos los 10 temporales de la raíz)
- ❌ No moví ni renombré directorios
- ❌ No eliminé dependencias
- ❌ No toqué `.gitignore` (la etapa 1 lo propone)
- ❌ No restauré los 8 borrados
- ❌ No hice commit, ni `reset`, ni `clean`
- ❌ No desplegué a Cloudflare
- ❌ No instalé APKs
- ❌ No revertí W1/W2 (verificados presentes)
- ❌ No probé contra Cloudflare producción — **la conectividad real sigue sin verificar**
- ❌ No instalé dependencias

### Qué SÍ hice
- ✅ Leí el repositorio
- ✅ Ejecuté `git status` y analicé las 298 entradas
- ✅ **Creé un backup** de 1353 archivos en `_apollo_audit_backup_20261012-141550`
- ✅ Verifiqué W1/W2 presentes por hash
- ✅ Escribí este informe

---

## Resumen

**Qué tenemos:** un asistente single-tenant funcional, con Worker sólido (1320 tests [T]), Android compilable (149 tests [B]), y separación clara entre PC, móvil y núcleo.

**Qué está roto:** la ausencia total de identidad de usuario; el estado global compartido; y 290 archivos fuera de Git que son un riesgo de pérdida inmediata e inmediata.

**Qué conservar:** casi todo. La migración es aditiva.

**Cómo organizar:** un DO por cuenta, identidad como servicio nuevo, Vectorize particionado.

**Secuencia:** commit primero (urgente), luego identidad, luego partición, y el secreto global se retira **último**.

**No afirmo que Apollo funcione de extremo a extremo contra Cloudflare: nunca fue probado.**
