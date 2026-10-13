# IDENTITY-MODEL

Fuente de verdad: `apps/agent/src/accounts/identity.ts`. Tests: `src/accounts/__tests__/identity.spec.ts`.

## Entidades y relaciones

```text
User (humano)
  1─1 Account            acc_<32 hex>     opaco, inmutable, jamás derivado de datos mutables
  1─N Device             desktop:<uuid> / mobile:<uuid> / futuro: physical, home, tablet, web
  1─N Session            token opaco; expira; revocable
  1─N Credential         credencial por dispositivo; ≠ sesión; revocable sin cerrar la cuenta
```

## Reglas verificadas por tests

| Regla | Test |
|---|---|
El email, `COMPUTERNAME`, `Apollo/default` y un deviceId **no** son cuentas válidas | `rejects mutable identities as account ids` |
Formato estricto `acc_` + 32 hex minúsculas | `accepts a well formed account id...` |
Device requiere prefijo + UUID | `requires a namespaced device id` |
DO por cuenta: `acct:acc_A` ≠ `acct:acc_B`; mapping inverso exacto | `derives one Durable Object name per account...` |
Namespace de memoria por cuenta: `mem:acc_A` ≠ `mem:acc_B` | `derives one memory namespace per account...` |
La cuenta legacy `acc_000...ffee` nunca colisiona con una real | `keeps the legacy account namespace separate...` |
Sólo `desktop` y `android` están implementados; `physical/home/tablet/web` existen en el enum pero se rechazan como implementados | `only claims desktop and android...` |
Un dispositivo enrolado tiene scopes completos incl. `device:execute` | `grants enrolled devices the full capability scope set` |

## Por qué el nombre del DO es la cuenta

`ApolloObjectNameForAccount('acc_A') = 'acct:acc_A'` → `idFromName(...)`. El aislamiento queda **estructural**: cada cuenta es otra instancia con otro SQLite. Ningún filtro olvidado puede cruzar cuentas, porque no hay vía de datos entre instancias.

## Scopes

`memory:read/write`, `conversation:read/write`, `device:read/write`, `device:execute` — centralizados en `defaultScopesForDeviceType()`. Ampliar capacidades exige editar esa función deliberadamente.
