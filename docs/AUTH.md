# AUTH & SESSIONS (FASE 2.2)

Estado: **implementado y verificado con tests locales**. Verificación contra Cloudflare real: `NO VERIFICADO` (requiere deploy).

## Endpoints (Worker)

| Ruta | Método | Auth | Devuelve |
|---|---|---|---|
`/api/auth/register` | POST | — | `{ accountId, sessionToken, expiresAt }` · 409 email repetido · 400 input inválido |
`/api/auth/login` | POST | — | igual a register · 401 credenciales inválidas (idéntico para email desconocido y password mal: sin enumeración) |
`/api/auth/logout` | POST | Bearer sesión | `{ ok }` — revoca esa sesión |
`/api/auth/session` | GET | Bearer sesión | `{ authenticated: true, accountId }` |
`/api/auth/devices` | GET/POST | Bearer sesión | lista / enrola dispositivo con binding cuenta↔device |
`/api/auth/devices/revoke` | POST | Bearer sesión | revoca UN dispositivo (no cierra sesiones de la cuenta) |

Un `accountId` enviado por el cliente **nunca** es autoridad: se ignora. La cuenta sale siempre de la sesión (`auth/account.ts` → `accounts/authority.ts`).

## Almacenamiento — DO `AccountRegistry` (global, singleton `'registry'`)

| Tabla | Contenido |
|---|---|
`auth_accounts` | `account_id` (acc_+32hex), `email_hash` (SHA-256 del email normalizado — **sin email plano**), `password_hash`, `tier`, `created_at` |
`auth_sessions` | `token_hash` (SHA-256 del token — **sin token plano**), `account_id`, `created_at`, `expires_at`, `revoked_at`, `last_seen_at` (deslizante) |
`auth_devices` | `device_id` (`desktop:<uuid>`/`mobile:<uuid>`), `account_id`, tipo, nombre, `created_at`, `last_seen_at`, `revoked_at` |

## Passwords

PBKDF2-HMAC-SHA256 (WebCrypto, único KDF sin dependencias nativas en Workers), **210.000 iteraciones** (mínimo OWASP), salt 16B aleatoria, clave 32B, comparación constante. Serializado `pbkdf2-sha256$<iter>$<saltB64>$<hashB64>`. Consideración CPU: en el plan free de Workers el login puede acercarse al límite de CPU; si ocurre, bajar iteraciones vía configuración documentada (NO_VERIFICADO en producción).

## Tokens de sesión

256 bits del CSPRNG, base64url, opacos. Sólo el **hash** se persiste: una fuga de la tabla no permite replay. TTL 30 días. Revocación individual, masiva por cuenta (borrado de cuenta) y expiración.

## Routing por cuenta (WebSocket)

```text
WS /agents/apollo/acct:<accountId>  +  Authorization: Bearer <sessionToken>
  borde (authorizeApolloConnection): verifica sesión vs AccountRegistry y exige que
    la cuenta de la sesión == cuenta de la URL → si no, 401
  DO (getConnectionTags): re-verifica; cuenta != instancia → sin tags
  DO (onConnect): inválida o cruzada → close(1008,'account_session_rejected')
```

Separación de espacios: un Bearer `apollo_dev_*`/`apollo_enr_*` jamás se valida como sesión; un token de sesión jamás como credencial de dispositivo. El secreto global legacy **sólo** abre `Apollo/default` — en instancias `acct:*` se ignora (anti-bypass entre cuentas).

## Tests

`accounts/__tests__/auth-flow.spec.ts` (7): hash sin texto plano, email duplicado, sesión viva/vencida, revocación individual, password correcto/incorrecto/corrupto, revocar device sin cerrar sesiones, listas de devices por cuenta.
`accounts/__tests__/authority.spec.ts` (6): credencial ≠ sesión, sesión → su cuenta exacta, token desconocido/manipulado → nada, biyección cuenta↔DO↔namespace, bloqueo por cuota pre-modelo, burst por minuto.


## ANEXO FASE 2.3 � clientes migrados (implementado, verificado localmente)

- **Android**: login/registro/logout en MainActivity; token de sesi�n cifrado con Keystore (`AccountSessionStore`); cliente `/api/auth` (`AccountAuthClient`, HttpURLConnection, token en header nunca en URL); enrolamiento del dispositivo con la cuenta autenticada; conexi�n de conversaci�n a `/agents/apollo/acct:<accountId>` con `DeviceCredential.AccountSession` (Bearer). Logout local borra token+accountId sin tocar la cuenta del servidor ni otros dispositivos.
- **PC (Rust/Tauri)**: `account.rs` (cliente auth + URL de cuenta); sesi�n en Credential Manager (`ApolloDesktop:account-session`); `ConversationAuth::{LegacyDeviceSecret, AccountSession}` en CloudCore (`Authorization: Bearer`, nunca en URL); arranque: si hay sesi�n ? `acct:<accountId>`, si no ? camino legacy; comandos `account_status/register/login/logout`; panel de cuenta en la UI (email/password ? commands, la UI nunca ve el token).
- **Prioridad de identidad en Android**: sesi�n de cuenta > credencial enrolada > sin conexi�n. La credencial de dispositivo queda para el plano de capacidades (MobileBridge).
- Tests: Worker +5 (escenarios 1-5 del plan contra el c�digo real de cuentas), Android +8 (`AccountAuthTest`), Rust +6 (URL cuenta, header Bearer, parseo, modos de auth).
