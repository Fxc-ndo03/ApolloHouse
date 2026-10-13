# Apollo ‚Äî SECURITY

## Modelo de amenazas

| # | Amenaza | Estado | Mitigaci√≥n verificada |
|---|---|---|---|
T1 | Secreto en URL ‚Üí access logs, `Referer`, diagn√≥sticos | **Corregido** | `X-Apollo-Device-Secret` |
T2 | Secreto en JSON plano | **Corregido** | Windows Credential Manager (DPAPI) |
T3 | Dos PCs con la misma identidad | **Corregido** | `installation_id` persistente |
T4 | Credencial individual actuando como secreto global | **Mitigado** | Namespaces separados por construcci√≥n |
T5 | M√≥vil entra al Apollo de otro | **Mitigado** | `idFromName(x).equals(ctx.id)` |
T6 | Acci√≥n sensible sin confirmar | **Cubierto** | `safety: 'unsafe'` ‚Üí `needs_confirm` |
T7 | Dos usuarios comparten memoria | **Abierto** | Requiere cuentas (fase siguiente) |
T8 | Sin l√≠mite de uso | **Abierto** | Requiere cuotas por cuenta |
T9 | Phishing de credenciales | **Parcial** | Credenciales revocables por dispositivo |
T10 | Worker ca√≠do | **Cubierto** | Backoff 2s‚Üí60s + timeout 25s |

---

## T1 ¬∑ El secreto ya no viaja en la URL

### El problema

```rust
// ANTES ‚Äî cloudcore.rs:507 y pcbridge.rs:124
let url = format!("{}?token={device_secret}", worker_url);
```

Una URL completa queda registrada en: access logs del Worker, `Referer` cuando el cliente navega, cualquier `console.log` de URL, y diagn√≥sticos del runtime de Cloudflare. El secreto quedaba expuesto en texto plano en cuatro lugares.

### La soluci√≥n

El secreto viaja en un header dedicado:

```rust
// AHORA
pub const DEVICE_SECRET_HEADER: &str = "X-Apollo-Device-Secret";

pub fn build_secret_request(worker_url: &str, device_secret: &str) -> Result<Request, String> {
    Request::builder()
        .uri(worker_url)
        .header(DEVICE_SECRET_HEADER, device_secret)
        .body(())
}
```

Aplicado en **las dos** conexiones del escritorio: conversaci√≥n (`cloudcore.rs`) y capacidades (`pcbridge.rs`).

### Por qu√© un header propio y no `Authorization`

`Authorization: Bearer` tiene su propio namespace: **nunca** se compara contra `DEVICE_SHARED_SECRET`. Si se aceptara el secreto global ah√≠, una credencial individual podr√≠a actuar como secreto global y a la inversa. Son √°mbitos separados por construcci√≥n, y hay un guard que lo verifica:

```
apps/mobile/__tests__/contract.spec.ts
  "el header Authorization nunca se valida como secreto global"
```

Ese guard recorta el archivo desde `readBearerCredentialFromRequest` hasta el final y afirma que no toca secretos globales. Por eso `readDeviceSecretFromRequest` est√° declarado **antes** de esa funci√≥n: el orden mantiene el guard significando lo que dice.

### Transici√≥n

El servidor acepta ambas formas (`apps/agent/src/auth/token.ts`):

```ts
export function readDeviceSecretFromRequest(request: Request): string | null {
  const headerSecret = request.headers.get(DEVICE_SECRET_HEADER)?.trim();
  if (headerSecret) return headerSecret;
  return readDeviceTokenFromRequestUrl(new URL(request.url));  // clientes viejos
}
```

Un cliente antiguo sigue funcionando. `readDeviceSecretFromRequest` es **el √∫nico punto** a tocar cuando se retire la URL.

**La validaci√≥n no cambi√≥:** el valor se sigue comparando en el servidor, con la misma comparaci√≥n timing-safe, contra los mismos secretos.

### Pruebas

| Test | Qu√© demuestra |
|---|---|
`el_secreto_no_aparece_en_la_url_del_handshake` | **Falla si alguien mueve el secreto de vuelta a la URL** |
`el_secreto_va_en_el_header_propio` | El header lleva el valor |
`la_url_del_handshake_no_cambia` | La ruta del Apollo es id√©ntica |
`un_secreto_vacio_no_rompe_el_armado` | Sin secreto, el cliente intenta y el Worker responde 401 |
`NO lee el espacio de credenciales individuales` | Un `Bearer` nunca es secreto global |

---

## T2 ¬∑ El secreto vive en Credential Manager

### El problema

`state.rs` guardaba `device_shared_secret` con `tokio::fs::write` en JSON plano: legible por cualquier proceso del usuario, incluido en copias de seguridad y en cualquier archivo que se suba.

### La soluci√≥n

`src/secret_store.rs` usa la API nativa de Windows, que cifra con la **DPAPI del usuario**: solo este usuario, en esta m√°quina, puede leerlo.

Se activ√≥ un feature de una crate que el proyecto **ya usaba** ‚Äî no se a√±adi√≥ ninguna dependencia:

```toml
windows = { version = "0.61", features = [
  "Win32_Foundation", "Win32_UI_WindowsAndMessaging",
  "Win32_Security_Credentials" ] }
```

### Por qu√© la API nativa y no `keyring`

`keyring` no era dependencia del proyecto. Agregarla habr√≠a arrastrado backends multiplataforma y una subida de versi√≥n de `windows` que pod√≠a conflicto con el `0.61` fijado. La crate `windows` ya estaba; s√≥lo faltaba el feature.

### Migraci√≥n sin cortar la conexi√≥n

La regla es una sola y no es negociable: **el secreto anterior no se borra hasta que el nuevo est√© confirmado escrito.**

```
Al cargar:
  1. Si Credential Manager tiene algo  ‚Üí ese es el valor vigente
  2. Si est√° vac√≠o y el JSON tiene algo ‚Üí se copia al almac√©n (migraci√≥n)
                                       ‚Üí el JSON se conserva como respaldo
  3. Si el almac√©n falla               ‚Üí el JSON sigue siendo la fuente
                                         y el cliente conecta igual
```

**El JSON nunca se borra autom√°ticamente.** Se conserva para que un rollback manual sea posible. `device_secret_migrated` evita reintentar la escritura en cada arranque.

En plataformas sin Credential Manager **se falla cerrado**: no se degrada a texto plano.

### Identidad no es secreto

`installation_id` sigue en el JSON. Es un identificador **p√∫blico** que el due√±o necesita leer para autorizar esta instalaci√≥n; meterlo en un almac√©n cifrado har√≠a imposible mostrarlo en la interfaz de vinculaci√≥n.

### Pruebas

| Test | Qu√© demuestra |
|---|---|
`una_escritura_fallida_conserva_el_secreto_anterior` | **Si el almac√©n falla, el usuario no pierde conexi√≥n** |
`un_secreto_ausente_no_inventa_uno_nuevo` | Nunca genera una credencial que el Worker no conoce |
`en_plataformas_sin_almacen_se_falla_cerrado` | Fuera de Windows no cae a texto plano |
`el_nombre_de_entrada_no_colisiona` | Prefijado con el nombre de la app |

---

## T3 ¬∑ La identidad del PC ahora persiste

### El problema

`cloudcore.rs` usaba `local_device_id()`, que devuelve `COMPUTERNAME`:

- Renombrar el PC le cambiaba la identidad.
- Un `COMPUTERNAME` reutilizado en otra m√°quina habr√≠a colisionado.
- No ten√≠a prefijo, as√≠ que el PC y el tel√©fono no se distingu√≠an en el registro.

### La soluci√≥n

`installation_id: String` en `AppSettings`, generado una vez:

```rust
pub fn generate_installation_id() -> String {
    format!("desktop:{}", uuid::Uuid::new_v4())
}
```

El prefijo `desktop:` lo alinea con `mobile:` del tel√©fono. **No es un secreto**: es el `deviceId` que el due√±o necesita conocer para autorizar esta instalaci√≥n, y por eso vive en el JSON de preferencias.

Migraci√≥n: un archivo existente sin el campo lo recibe al cargar, **sin tocar ninguna otra preferencia**.

### Pruebas

`generated_installation_ids_are_unique` ¬∑ `installation_id_survives_a_serialization_round_trip` ¬∑ `a_settings_file_without_installation_id_still_deserializes` ¬∑ `installing_an_id_does_not_touch_the_rest_of_the_settings`

---

## T4 ¬∑ Namespaces de credenciales separados

| √Åmbito | D√≥nde viaja | Contra qu√© se compara |
|---|---|---|
Credencial individual | `Authorization: Bearer apollo_dev_‚Ä¶` | La tabla de enrollment |
Secreto global (legacy) | `X-Apollo-Device-Secret` | `env.DEVICE_SHARED_SECRET` |
Token interno | `X-Internal-Token` | `env.INTERNAL_CORE_TOKEN` |

Cada uno se compara **s√≥lo** contra lo que le corresponde. El c√≥digo los separa por construcci√≥n, no por convenci√≥n.

`readBearerCredentialFromRequest` nunca ve un secreto global. `resolveApolloConnectionRole` nunca ve una credencial individual.

---

## T6 ¬∑ Acciones sensibles: ya funciona

**No se modific√≥.** La pol√≠tica ya era correcta:

```
close_pc_app   ‚Üí safety: 'unsafe' ‚Üí requiere confirmaci√≥n
lock_pc_screen ‚Üí safety: 'unsafe' ‚Üí requiere confirmaci√≥n
open_pc_app    ‚Üí safety: 'safe'
spotify_*      ‚Üí safety: 'safe'
```

El router determinista **no evita** esta pol√≠tica: una tool `unsafe` devuelve `needs_confirm` y no se ejecuta hasta que el usuario apruebe (`runtime.ts:1250`).

**Riesgo residual:** los 14 tipos de comando del router se resuelven sin pasar por el modelo, pero la **confirmaci√≥n se aplica igual** sobre la tool resultante. La velocidad no sacrifica la autorizaci√≥n.

---

## Riesgos abiertos

### R7 ¬∑ Aislamiento entre usuarios ‚Äî CR√çTICO

No existe el concepto de cuenta. `memories` y `thread_meta` viven en un DO `Apollo/default`; Vectorize es un √≠ndice global. **Dos usuarios compartir√≠an memoria.**

Mitigaci√≥n futura: DO por cuenta + filtro obligatorio por `accountId` en toda consulta.

### R8 ¬∑ Sin l√≠mite de consumo ‚Äî ALTO

Un usuario puede generar tokens y minutos de voz sin tope. Con multiusuario es riesgo financiero directo.

### R9 ¬∑ Un `COMPUTERNAME` como identidad ‚Äî MITIGADO

Ver T3. Resuelto.

---

## Reglas para no filtrar secretos

1. **Nunca loguear el valor.** Los helpers de `secret_store` devuelven `Unavailable(String)` con un **c√≥digo** de error, nunca el blob.
2. **Nunca construir URLs con secretos.** `build_secret_request` existe para eso.
3. **El historial de conversaci√≥n no guarda credenciales.** Hay un test que falla si aparece `apollo_dev_`, `Bearer` o `apollo_enr_`.
4. **Los errores de credencial no dicen si fall√≥ el formato o la revocaci√≥n** al cliente, pero s√≠ lo distinguen internamente para diagn√≥stico.


## ANEXO FASE 2 ó aislamiento multiusuario (implementado)

- Hallazgo crÌtico corregido: la memoria Vectorize usaba namespace 'default' compartido por todos. Ahora cada cuenta tiene namespace mem:<accountId> derivado obligatoriamente; sin cuenta v·lida la operaciÛn lanza.
- Un DO Apollo por cuenta (cct:<accountId>): el aislamiento es estructural, no por filtros.
- Los vectores legacy viven en el namespace de LEGACY_ACCOUNT_ID y nunca se mezclan con cuentas reales.
- Pendiente: login/sesiones, columnas ccount_id como defensa en profundidad, verificaciÛn contra Cloudflare real (ver docs/DATA-ISOLATION.md).


## ANEXO FASE 2.2 ó sesiones y authority (implementado)

- Passwords: PBKDF2-SHA256 210k iter + salt + comparaciÛn constante; email sÛlo como hash de lookup. Sin texto plano de passwords ni tokens en la tabla (sÛlo SHA-256 del token).
- Sin enumeraciÛn de cuentas: email desconocido y password mal devuelven la misma respuesta.
- SesiÛn ? credencial de dispositivo: espacios separados y testados; revocar un device no cierra la cuenta.
- Anti-bypass: secreto global legacy rechazado en instancias `acct:*`; token de sesiÛn inv·lido nunca degrada a legacy.
- `NO VERIFICADO`: CPU del PBKDF2 en plan free, comportamiento del DO v5 en Cloudflare real.


## ANEXO FASE 2.4 ó device security + defensa en profundidad + usage

- **PcBridge ligado a cuenta** (`devices/desktop-authorization.ts` + `agents/pc-bridge.ts`): el `hello` del desktop se autoriza contra el binding deviceId?cuenta del registro. Con sesiÛn: dispositivo revocado ? `close(1008 device_revoked)`; deviceId de OTRA cuenta ? `device_of_other_account`. `resolveCapabilityTarget` exige que la cuenta que pide sea la del bridge conectado (`capability_account_mismatch`); el camino legacy (sin sesiÛn) sigue acept·ndose sin binding de cuenta.
- **Hello con identidad persistente**: el esquema del protocolo acepta `deviceId` opcional en el hello (aditivo); los clientes legacy siguen deriv·ndolo del hostname. La AUTORIZACI”N nunca sale del cliente: se verifica contra el registro.
- **`thread_meta` + `memories`: columna `account_id`** (ALTER idempotente + Ìndices). Escrituras siempre con cuenta; lecturas acotadas a la cuenta (NULL tolerado sÛlo dentro de la MISMA instancia single-tenant). Un sessionId conocido de otra cuenta NO resuelve datos.
- **Usage real de Gemini**: `usageMetadata` capturado del proveedor cuando existe (`usage` en el resultado); se registra `totalTokens` real por turno. Streaming sin usage ? 0 = desconocido, nunca inferido. La request se cuenta igual.
- **Cuota pre-Gemini** (F2.2) + serializaciÛn natural: un DO por cuenta procesa sus turnos en serie ó no hay carrera entre solicitudes simult·neas de la misma cuenta.
- **RevocaciÛn/expiraciÛn en clientes**: PC: close 1008 detiene el loop de reconexiÛn y emite `account-session-rejected` (sin reintentos infinitos con credencial muerta); un corte de red sigue reintentando con backoff. Android: `DENIED` por sesiÛn/credencial revocada borra la sesiÛn local ? vuelve a login; la red caÌda sigue reintentando.
- **Staging: NO ejecutado** ó no existe `[env.staging]`; un solo Worker `apollo` y Vectorize `remote: true` compartido. La separaciÛn no puede demostrarse. Pasos pendientes: crear `env.staging` con nombre separado, Ìndice Vectorize propio, DO/migraciones controladas y secretos sintÈticos; reciÈn entonces deploy + baterÌa de escenarios A-E.


## ANEXO FASE 2.5 ó staging real + PcBridge multidispositivo

- **Staging desplegado (real)**: `https://apollo-staging.facupapollo.workers.dev` (`wrangler deploy --env staging`). Recursos propios, creados y verificados: Worker `apollo-staging`, Ìndice Vectorize `apollo-memory-staging` (1536/cosine), cola `apollo-jobs-staging`, workflows `apollo-*-staging`, DOs dentro del script (el `Apollo/default` de producciÛn es inalcanzable), migraciones v1ñv5 aplicadas desde cero, secrets sintÈticos. ProducciÛn NO fue tocada.
- **BaterÌa remota ejecutada (21/22 PASS)** contra staging: registro/login/logout/revocaciÛn, email repetido 409, credenciales 401, aislamiento A/B (binding de dispositivo no movible por B), **WS 101 con sesiÛn propia y 401 cross-account**, cuota por cuenta aislada. Pendiente por inestabilidad del entorno local: confirmaciÛn remota del rechazo `quota_exceeded` (la sem·ntica de reserva atÛmica est· testeada localmente).
- **Hallazgos de staging corregidos**: ? PBKDF2 210k superaba la CPU del plan free ? `APOLLO_PBKDF2_ITERATIONS` configurable (staging: 10k, sintÈtico); ? `acct:` en el path rompe clientes WS ? nombre de instancia ahora `acct-<accountId>` (parser acepta ambos por transiciÛn); ? el borde no decodificaba `%3A` ? `accountIdFromPathSegment`.
- **PcBridge multidispositivo**: instancia por dispositivo (`/agents/pc-bridge/<deviceId>`); selecciÛn de destino `selectDesktopTarget` (7 tests): sÛlo desktops de la cuenta, revocados jam·s destino, `any` elige UNA en lÌnea, deviceId ajeno ? `device_of_other_account`, offline ? `target_unavailable` (nunca Èxito fingido ni fallback a otra PC). Legacy: instancia compartida `pc-bridge` sin binding.
- **Cuota anti-carrera**: el request se RESERVA antes del turno (chequeo+reserva atÛmicos dentro del DO por cuenta); los tokens reales de Gemini se registran aparte cuando el proveedor los reporta; `requestsPerMinute` bloquea con `consumed >= lÌmite`; los intentos fallidos cuentan.
- **ClasificaciÛn D (sin columnas por automatismo)**: con DO por cuenta, `session_prefs` y `mcp_tool_settings` son cuenta-·mbito POR CONSTRUCCI”N (no pueden compartirse entre cuentas) ó no se agregan columnas; la migraciÛn futura de datos documentar· el tratamiento de NULL.
- **Rust local: BLOQUEADO** ó el OOM del entorno corrompiÛ la toolchain (reparada a 1.99.0, pero la m·quina sigue sin memoria para compilar; `cargo test --lib` pendiente). Android 157, Worker 1381, paridad 75: verdes.
