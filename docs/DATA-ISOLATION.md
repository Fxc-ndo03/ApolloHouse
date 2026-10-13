# DATA-ISOLATION

Garantía: **cuenta A no puede leer ni escribir datos de cuenta B**, por construcción, no por filtros.

## Capas

### 1. Durable Object por cuenta

`Apollo/acct:<accountId>`. El estado conversacional, preferencias, hilos y usage viven en el SQLite de esa instancia. Dos cuentas = dos instancias = dos almacenes físicos distintos.

### 2. Vectorize por namespace de cuenta

`memoryNamespaceForAccount(accountId) = mem:<accountId>`. `src/memory/vector.ts`:

- `accountId` es un parámetro **requerido** en `upsertMemoryVector` y `queryMemoryVectors` — es imposible llamarlas sin cuenta (error de compilación).
- El valor se valida con `requireAccountId`: `undefined`, `'default'`, un email o un deviceId lanzan `InvalidAccountIdError` en runtime.
- El namespace nunca se recibe como parámetro: **siempre** se deriva de la cuenta. Ningún llamador puede pasar un namespace ajeno.

Tests (`src/memory/__tests__/isolation.spec.ts`): escrituras de A y B aterrizan en namespaces distintos; consultas se emiten dentro del namespace del llamador; cuenta ausente/inválida lanza; un deviceId como cuenta lanza y **no** escribe nada.

### 3. Jobs de cola por cuenta

El job `index_memory` lleva `accountId` (validado por `accountIdSchema`, default `LEGACY_ACCOUNT_ID` para colas pre-fase). El consumidor indexa en el namespace de esa cuenta. `run_background`/`run_coding` conservan `deviceId` porque eligen dispositivo, no cuenta.

### 4. Tools

`ToolExecutionContext.accountId` es opcional en el tipo, pero la tool `recall_memory` exige cuenta (`requireAccountId(context.accountId)`) y falla cerrado. Una tool que necesite memoria **no puede** ejecutarse sin identidad de cuenta.

## Qué queda pendiente para aislamiento total

- Columnas `account_id` en `memories`/`thread_meta` como defensa en profundidad + queries acotadas (`NO VERIFICADO`, fase siguiente).
- Sesiones de cuenta y binding sesión→DO (`NO VERIFICADO`, FASE 2.2).
- Verificación contra Cloudflare real (`NO VERIFICADO`: requiere deploy).
