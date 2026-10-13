# USAGE-AND-QUOTAS

Fuente de verdad: `apps/agent/src/usage/usage.ts`. Tests: `src/usage/__tests__/usage.spec.ts` (8).

## Enforcement en el camino caliente (FASE 2.7, VERIFICADO en staging)

`#checkAndReserveTurnQuota()` corre antes de `executeApolloTurn()` y hace chequeo +
reserva en un unico bloque sincrono: todas las operaciones son `storage.sql.exec`
sincronas, asi que sin `await` entre el chequeo y la reserva JavaScript no puede
intercalar otro turno de la misma cuenta. Esto cerro una carrera real observada
en staging (dos turnos concurrentes pasaban el chequeo con la misma cuota porque
la version anterior era `async`).

- Turno permitido -> 1 fila `requests: 1` reservada antes de tocar Gemini.
- Turno excedido -> `error quota_exceeded` al cliente, sin invocar al proveedor.
- Medido en `apollo-staging` (tier `free`, `APOLLO_REQUESTS_PER_MINUTE=1`):
  turno dentro de cuota `turn_failed` en 1.4-3.4 s (llega al proveedor y muere por
  la key sintetica); turno siguiente `quota_exceeded` en 1.1-1.5 s, es decir
  rechazado por el Worker sin llegar a Gemini.

Endpoint de inspeccion, solo staging: `GET /api/debug/usage?accountId=acc_...`
existe unicamente si el var `APOLLO_ENABLE_USAGE_DEBUG === 'true'` (declarado solo
en `env.staging`) y trae `X-Internal-Token`. Sin el var la ruta no existe (404) en
cualquier otro entorno, produccion incluida.

## Qué se implementó

### Tabla por cuenta (en el DO `Apollo/acct:<accountId>`)

```sql
usage_events (id, account_id, tokens, requests, voice_seconds, created_at)
INDEX usage_events_account_time (account_id, created_at)
```

Creada de forma idempotente por el DO (`CREATE TABLE IF NOT EXISTS`). Cada consulta suma **sólo** la cuenta pedida (`WHERE account_id = ?`) entre dos timestamps.

### Registro

`recordUsageEvent(executor, { accountId, tokens, requests, voiceSeconds, atMilliseconds })` — conectado al fin de cada turno del Apollo DO: 1 request por turno completado.

### Política configurable

```ts
UsagePolicy { tier, dailyTokens, monthlyTokens, dailyVoiceSeconds, monthlyVoiceSeconds, requestsPerMinute }
```

`resolveUsagePolicy(tier, overrides)`: valores base por tier (`anonymous` = 0 en todo → bloquea al primer token; `free` = placeholder conservador; `paid`/`admin` superiores) **más overrides** — los números comerciales nunca viven en el tipo. `evaluateUsageQuota()` detecta cada límite excedido independientemente y devuelve `{ allowed, exceededLimit }`.

## Qué falta (NO VERIFICADO)

1. **Tokens y segundos de voz reales**: el registro por turno hoy suma `requests: 1` con `tokens: 0`. Extraer usage real de las respuestas de Gemini (y duración de TTS) e incorporarlo al evento — punto de conexión ya definido (mismo sitio donde se registra el turno).
2. ~~Enforcement en el camino caliente~~ RESUELTO en FASE 2.7 (ver seccion arriba): chequeo + reserva atomicos antes de Gemini, quota_exceeded verificado en staging.
3. **Tabla en instancias ya creadas**: verificada en pollo-staging (usage_events creada al primer arranque tras deploy; filas visibles por /api/debug/usage).
4. **Primer turno en frio**: en una cuenta recien creada el handler del primer text_input tarda >120 s en llegar a la reserva de cuota y se desbloquea cuando llega una segunda conexion; los turnos siguientes responden en 1-4 s. text_input -> executeTurn_entry mide 0 ms, asi que la demora esta antes del gate, dentro del bootstrap del SDK en la primera invocacion del DO. Instrumentar ahi para cerrarlo.
