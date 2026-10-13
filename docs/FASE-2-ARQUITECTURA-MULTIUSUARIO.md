# FASE 2 — Arquitectura multiusuario

Estado: **base de aislamiento implementada y verificada en tests locales**. Login, migración de datos y verificación contra Cloudflare real: `NO VERIFICADO` (ver final).

## A. Arquitectura actual (verificada en código)

| Componente | Estado anterior al cambio |
|---|---|
Durable Objects | `Apollo`, `PcBridge`, `MobileBridge`, `Sandbox`, `Background`, `Coding` — todos con binding en `wrangler.jsonc` |
Instancia Apollo | **Única**: `idFromName('default')` → `Apollo/default` |
Memoria Vectorize | Índice `apollo-memory`, namespace = `this.name` = **`'default'` para todos** |
Tablas SQL del Apollo DO | `memories`, `session_prefs`, `pending_device_messages`, `list_items`, `pending_confirmations`, `mcp_tool_settings`, `thread_meta` — **sin columna de cuenta** |
Credenciales de dispositivo | `mobile_device_credential` en el MobileBridge DO, con challenge de enrollment |
Auth | secreto global legacy (`X-Apollo-Device-Secret` / `?token=`) + credenciales individuales `Authorization: Bearer` |
Cola | `APOLLO_QUEUE` con jobs `index_memory`, `run_background`, `run_coding` (todos con `deviceId` antes del cambio) |

**El hallazgo crítico de la auditoría:** la memoria no estaba aislada ni por dispositivo ni por cuenta — todos los usuarios compartían el namespace `'default'` de Vectorize y las mismas tablas SQL.

## B. Arquitectura objetivo

```text
User
 ↓ (login)
Account  acc_<32 hex>
 ↓
Durable Object  Apollo/acct:acc_...
 ├── Devices        (desktop / android / futuro physical, home, tablet, web)
 ├── Conversations  (thread_meta por cuenta)
 ├── Memory         (Vectorize namespace mem:acc_... + memories por cuenta)
 ├── Preferences    (session_prefs del DO de la cuenta)
 └── Usage          (usage_events por cuenta, cuota configurable)
```

Un DO **por cuenta**, no por dispositivo: si fuera por dispositivo, PC y teléfono de un mismo usuario no compartirían memoria. Con DO por cuenta sí la comparten, y dos usuarios jamás.

## C. Modelo de identidad

| Entidad | Identificador | Regla |
|---|---|---|
User | atributo de autenticación (email/passkey) | **nunca** clave primaria |
Account | `acc_` + 32 hex, opaco e inmutable | unidad de aislamiento |
Device | `desktop:<uuid>` / `mobile:<uuid>` | pertenece a una cuenta |
Session | token opaco, hash en servidor | expira y es revocable |
Credential | credencial por dispositivo | ≠ sesión de cuenta; revocable sin afectar a la cuenta |

Implementado en `apps/agent/src/accounts/identity.ts`: validación estricta (`acc_` + 32 hex minúsculas; dispositivos `prefijo:<uuid>`), rechazo explícito de `COMPUTERNAME`, email, `Apollo/default` y device-ids como cuentas.

## D. Modelo de almacenamiento

| Dato | Dónde | Por qué |
|---|---|---|
Estado conversacional, hilos, preferencias | DO `Apollo/acct:<accountId>` (SQLite) | serialización natural por cuenta, sin nueva base de datos |
Memoria semántica | Vectorize `apollo-memory`, namespace `mem:<accountId>` | primitivo existente; el namespace aísla |
Vectores de hilo | mismos namespace por cuenta | |
Credenciales de dispositivo | MobileBridge DO (existente) | ya tiene challenge/enrollment/revocación |
Usage | tabla `usage_events` en el DO de la cuenta | cuenta-local, sin DO extra |
Blobs | R2 (existente) | |

**No se introdujo D1, KV ni ningún almacén nuevo**: el DO de la cuenta ya serializa escrituras y cumple el patrón del resto del sistema.

## E. Modelo de aislamiento (demostración)

1. **Cuenta A no puede alcanzar datos de B**: el DO de Apollo se instancia por `idFromName('acct:acc_A')`. El almacenamiento del DO es físico por instancia; no existe consulta que cruce instancias.
2. **Memoria de A ≠ memoria de B**: `upsertMemoryVector`/`queryMemoryVectors` exigen `accountId` válido (`requireAccountId`) y derivan el namespace con `memoryNamespaceForAccount`. Sin cuenta o con cuenta inválida → `InvalidAccountIdError`. Namespace de A ≠ namespace de B por construcción (`mem:acc_A` vs `mem:acc_B`). Un `deviceId` como cuenta **lanza** (test incluido).
3. **Dispositivo de A no puede suplantar a B**: la credencial se compara por hash contra la tabla del bridge que la emitió; el binding credencial→deviceId→DO no cambió.
4. **Legacy separado**: `LEGACY_ACCOUNT_ID` (`acc_000...ffee`) genera un namespace distinto de cualquier cuenta real; los datos legacy nunca se mezclan silenciosamente.

Tests: `src/accounts/__tests__/identity.spec.ts` (9), `src/memory/__tests__/isolation.spec.ts` (5) — namespaces distintos, rechazo de cuenta ausente/inválida, rechazo de deviceId como cuenta, mapping DO↔cuenta.

## F. Autenticación — decisión

**Elegida: autenticación propia sobre primitivos de Cloudflare, con tokens opacos y sesiones en el DO.**

Razones (investigado contra documentación y proyectos actuales):
- Los clientes de Apollo son **nativos** (Android, Tauri), no navegadores: las librerías tipo cookie (better-auth, derbent) modelan mal el caso.
- Cloudflare Access protege URLs para *workforce*; no da login programático nativo ni control de cuentas de usuarios finales.
- SaaS externos (Auth0/Firebase/Supabase) añaden dependencia, coste y salida de datos — contrarios a los requisitos.
- Passkeys: upgrade path documentado; email-code como recuperación. No se implementó en esta fase (`NO VERIFICADO` — requiere dominio de envío de email y decisión de producto).

Diseño previsto (FASE 2.2): login → access token + refresh token opacos (hash SHA-256 + pepper en servidor), rotación de refresh con detección de reuso, revocación por sesión y por cuenta, enrolamiento de dispositivo con sesión activa.

## G. Migración de `Apollo/default`

`docs/MIGRATION-APOLLO-DEFAULT.md`. Resumen: snapshot → inventario → copia a `Apollo/acct:<cuentaDueño>` → verificación por conteos/hashes → legacy read-only → retiro. **No se ejecutó ninguna migración de datos reales** (`NO VERIFICADO`: requiere acceso a producción).

## H. Problemas abiertos al cierre de FASE 2.7

Este checkpoint **no** significa que los riesgos estén resueltos. Quedan dos
problemas conocidos, medidos contra `apollo-staging` y **sin resolver**:

### H.1. Arranque en frío del primer turno (>120 s) — PENDIENTE

En una cuenta recién creada, el handler del primer `text_input` tarda **más de
120 s** en llegar a la reserva de cuota, y se desbloquea cuando llega una segunda
conexión al mismo Durable Object. Los turnos siguientes responden en 1–4 s.

Lo que sí está medido: `text_input → executeTurn_entry` tarda **0 ms**, así que la
demora ocurre **antes** del gate de cuota, dentro del bootstrap del SDK en la
primera invocación del DO. Lo que falta: instrumentación dentro de ese bootstrap
para identificar la operación concreta. `wrangler tail` se mostró demasiado
inestable para capturar todos los eventos de una invocación, por lo que no se
atribuyó el tiempo a un punto preciso.

Impacto: el primer turno de cada cuenta nueva no es usable en producción; sólo
se verificó en staging. No tocar producción hasta cerrarlo.

### H.2. Dos DOs legacy de staging responden `500 no such table` — PENDIENTE

Las instancias de `Apollo/acct-<id>` de dos cuentas sintéticas antiguas de
staging (IDs cortos de 8 hex, creadas en fases previas) responden
`500 SQLITE_ERROR: no such table: usage_events` incluso después de que
`debugListUsageEvents` intente crear la tabla de forma idempotente antes de
consultar. Una tercera cuenta antigua responde `200` con la tabla recién creada
y vacía.

Estado: **aislado a instancias legacy de staging**. Las cuentas nuevas funcionan
(lectura `200` antes y después de un turno). Sin datos de usuarios reales
afectados. Causa raíz no confirmada: el storage de esas instancias quedó trabado
durante las pruebas de arranque en frío (manejadores de más de 120 s), no por el
código actual. Pendiente: reinstanciar esas cuentas sintéticas o determinar por
qué su storage no acepta escrituras antes de reutilizarlas como evidencia de
pruebas.
