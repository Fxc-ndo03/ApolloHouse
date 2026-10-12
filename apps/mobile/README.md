# Apollo Mobile

Cliente mobile real de Apollo. Habla el protocolo que ya existe contra
`MobileBridge` y no inventa transporte: el Device Protocol y la Mobile Session son
los de BLOCK 9.

- **BLOCK 10**: el cliente y el peer, con una sola capability (`mobile.notifications`).
- **BLOCK 11**: seis capabilities mobile sobre el `CapabilityRegistry` que ya existia,
  con comandos multiples por capability, idempotencia, reachability y metricas.

## Capabilities y comandos (BLOCK 11)

Cada capability declara la lista de comandos que acepta. El comando canonico (el
primero) es el que se usa cuando Apollo no manda `command`, que es lo que pasaba
antes de BLOCK 11.

| Capability | Comandos | Queueability | Efecto real en el peer |
|---|---|---|---|
| `mobile.notifications` | `notification_post` | `queueable` | `NotificationAdapter.post` (permiso + canal) |
| `mobile.alarm` | `alarm_set`, `alarm_cancel` | `queueable` | `AlarmManager.setExact` / `setInexactRepeating` + `PendingIntent` |
| `mobile.calendar` | `calendar_create`, `calendar_list`, `calendar_cancel` | `queueable` | `ContentResolver` sobre `CalendarContract.Events` |
| `mobile.media` | `media_play`, `media_pause`, `media_next`, `media_previous` | `realtime_only` | `MediaPlayer` |
| `mobile.volume` | `volume_set`, `volume_get` | `realtime_only` | `AudioManager.setStreamVolume` / `getStreamVolume` |
| `mobile.open_app` | `app_open` | `realtime_only` | `PackageManager.getLaunchIntentForPackage` |

`queueable` significa que el comando se puede encolar y ejecutar despues;
`realtime_only` significa que tiene que correr en el momento o no sirve
(subir el volumen de un turno viejo es tapar el audio de ahora).

### El payload se valida por comando, no por capability

Con un schema por capability, `alarm_cancel` (que manda solo `{label}`) fallaba
siempre con `invalid_hour_minute` porque se le exigia la hora. Ahora hay un schema
por comando en los dos lados, y los dos son estrictos en ambas direcciones.

### Los comandos de lectura contestan con datos

`volume_get` y `calendar_list` no pueden devolver un booleano: el `command_result`
lleva un `result` estructurado (`{level: 42}`, `{events: [...]}`) y el bridge lo
propaga hasta la tool.

### Ningun comando reporta exito sin efecto

`media_play` es el caso donde esto importa. El telefono no resuelve una query de
texto a una URL (eso es del backend y no existe), asi que el peer devuelve:

| Situacion | Resultado |
|---|---|
| la query ya es una URI jugable (`http`, `https`, `content`, `file`) | `media_play` arranca el player |
| la query no es una URI | `media_unresolvable` |
| el player falla al preparar | `media_failed` |

Devolver exito sin reproducir era el bug: Apollo no podia distinguir "sono" de
"intente".

### Gaps declarados del peer

1. **No hay resolvedor de media en el telefono.** `media_play` con texto libre
   ("algo de jazz") devuelve `media_unresolvable`. Cerrarlo requiere resolver la
   query a una URL del lado del backend.
2. **`calendar_list` no filtra por calendario ni por recurrentes**: devuelve los
   eventos de la cuenta por defecto en la ventana pedida.
3. **`app_open` toma un package name** (`com.whatsapp`), no un nombre legible.
   El intent determinista de voz pasa el nombre que dijo el usuario.
4. **Sin provisioning por dispositivo** (ver arriba): un unico secret global.
5. **Sin hardware:** las alarmas, el calendario, el volumen y `app_open` usan APIs
   nativas que no se ejecutaron contra un teléfono real en esta sesión.

## Toolchain

Lo fija `APOLLO_ANDROID_SOURCE_OF_TRUTH.md`, que es la fuente de verdad del cuerpo
Android de este repo: **Android nativo, Kotlin 1.3, AGP 3.3, minSdk 25**
(Samsung Galaxy S5 SM-G900H / LineageOS 14.1 / Android 7.1). Sin Jetpack Compose.

Versiones que se usan y verificaron ejecutando (BLOCK 10.1):

| Pieza | Version | Nota |
|---|---|---|
| JDK | Temurin 1.8.0_504 | Gradle 4.x y AGP 3.3 no corren con JDK 21 |
| Gradle | **4.10.1** | ver la incompatibilidad de abajo |
| AGP | 3.3.3 | el que nombra el doc |
| Kotlin | 1.3.72 | el que nombra el doc |
| compileSdk / targetSdk | 28 / 25 | el que nombra el doc |
| build-tools | 28.0.3 | el que pide AGP 3.3 |
| Android SDK platform | android-28 | |

### Incompatibilidad real del doc: Gradle 4.6 + AGP 3.3 no pueden coexistir

El doc dice "Gradle 4.6 + AGP 3.3" en §23. Eso no compila. El propio jar de
`com.android.tools.build:gradle:3.3.3` declara:

```
com/android/build/gradle/BasePlugin.class  ->  MIN_SUPPORTED_GRADLE_VERSION = 4.10.1
```

Con Gradle 4.6 el build falla antes de compilar:

```
Failed to apply plugin [id 'com.android.application']
> Minimum supported Gradle version is 4.10.1. Current version is 4.6.
```

Se corrigio subiendo **solo Gradle a 4.10.1**, el minimo que AGP 3.3.3 acepta. AGP,
Kotlin, compileSdk y targetSdk quedan exactamente como el doc los pide. La alternativa
-era bajar AGP a 3.2.x para conservar Gradle 4.6; se eligió mover Gradle porque AGP
determina el pipeline de build y 3.2 es una version con mas bugs conocidos.

Decisiones que salen del doc y no de este bloque:

- **OkHttp 3.14** para el WebSocket: Android 7.1 no trae cliente WebSocket en el framework.
- **NotificationCompat**: los canales de notificacion nacen en API 26 y el objetivo es API 25,
  asi que el framework no alcanza. `POST_NOTIFICATIONS` solo se pide en API 33+.
- **Backoff 1s -> 2s -> 4s -> 8s -> 16s -> 30s**, la tabla que ya estaba escrita en §10 del doc.

## Arquitectura

Cuatro capas separadas, ninguna depende de internals del servidor:

| Capa | Carpeta | Que sabe |
|---|---|---|
| transporte | `transport/` | bytes: `DeviceSocket`, OkHttp, URL con token |
| sesion | `session/` | estados, hello, heartbeat, reconnect, backoff |
| comando | `command/` | allowlist, payload estricto, target, duplicados, `command_result` |
| notificacion | `notification/` | `NotificationAdapter` y su impl Android |
| plataforma | `notification/platform.kt`, `android-platform.kt` | `MobilePlatform`: el puerto que el dispatcher prueba en la JVM |

Mas `contract/` (constantes del wire, unico lugar donde se declaran), `identity/`
(deviceId estable) y `protocol/` (mensajes que entran y salen).

El cliente **no** conoce registry, target resolver, `ToolDefinition`, routing de Apollo
ni PcBridge.

## Autenticacion y provisioning

Se reutiliza el mecanismo existente: `DEVICE_SHARED_SECRET` como `?token=`, validado por
el Worker con comparacion timing-safe. No hay JWT, password, token propietario ni secret
nuevos, y **no se agrega `MOBILE_SHARED_SECRET`**.

El secret **nunca se compila**: no esta en `BuildConfig`, ni en un recurso, ni en el
fuente. `transport/credentials.kt` lo lee en runtime desde las preferencias privadas de la
app (`MODE_PRIVATE`), y el dev lo provee en el dispositivo ya instalado o desde
`MainActivity`.

## BLOCK 12: enrollment y credencial por telefono

### Que cambio

Antes todos los telefonos compartian `DEVICE_SHARED_SECRET`: cualquiera que lo tuviera
era un dispositivo indistinguible de los demas, y revocar uno era imposible de expresar.
Ahora cada telefono tiene su propia credencial, que se puede revocar sola.

### Los dos ambitos, y por que no se mezclan

| Ambito | Como viaja | Quien lo usa |
|---|---|---|
| `enrolled_android` | header `Authorization: Bearer <credencial>` | telefonos enrolados |
| `legacy_shared_secret` | `?token=<DEVICE_SHARED_SECRET>` | Desktop y telefonos aun no enrolados |

Tres reglas que sostienen esto:

1. **Si viene `Authorization`, el ambito es enrolled.** No hay fallback al secreto
   global, y un bearer nunca se compara contra `DEVICE_SHARED_SECRET`.
2. **La identidad sale del hash, no del cliente.** La credencial esta atada a un
   `deviceId` en el servidor, asi que un telefono no abre sesion declarando ser otro.
3. **El legacy no puede reintroducir a un telefono enrolado o revocado.** Si el
   `deviceId` del hello aparece en el registro de enrollment --activo O revocado-- el
   camino `?token=` lo rechaza. Sin esta regla, revocar no significaria nada: alcanza
   con volver por el secreto global.

La regla 3 es la que mas importa, y el smoke la ejercita de verdad.

### Donde vive el estado

En el SQLite del `MobileBridge`, que ya era `new_sqlite_classes` en `wrangler.jsonc`
(tag v4). Se guardan **hashes**, nunca credenciales: un dump del DO no sirve para
conectarse. La revocacion sobrevive a que el DO se descargue, y hay un smoke de dos
fases que lo comprueba reiniciando workerd.

### El flujo

```
1. el dueno pide un desafio   POST /enrollment/challenge   Authorization: Bearer <DASHBOARD_SHARED_SECRET>
2. el telefono lo canjea      POST /enrollment/claim  {challenge, deviceId}
3. el servidor lo CONSUME y devuelve la credencial individual
4. android la cifra con AES-GCM (clave en el Keystore) y la guarda
5. el socket abre con         Authorization: Bearer <credencial>
```

El token del dueno viaja **unicamente** en `Authorization: Bearer`. Estas rutas no
aceptan `?token=`: el queryParam abre el socket mobile legacy, no administra
enrollment, y un `?token=` con el secreto del dueno responde `401` (comprobado
sobre workerd). La version anterior de este README decia `?token=` y estaba mal.

El desafio es impredecible (24 bytes del CSPRNG), de un solo uso (consumir es borrar) y
expira a los 5 minutos, siempre contra el reloj del servidor. El claim **no** pide
token: todavia no hay credencial; lo que lo autoriza es el desafio.

La revocacion es `POST /enrollment/revoke` con `Authorization: Bearer
<DASHBOARD_SHARED_SECRET>`. Cierra el socket vivo, corta los comandos en vuelo y
deja al telefono sin reconectar.

### En android

- `KeystoreCredentialCipher`: AES/GCM/NoPadding con clave en `AndroidKeyStore`. En las
  preferencias queda el **ciphertext**, no la credencial.
- `DeviceCredential.resolve()`: si hay credencial enrolada, gana siempre. Nunca degrada al
  secreto global -- esa es la regla anti-bypass del lado del cliente.
- Un cierre 1008 del servidor (credencial revocada) **no** dispara reconexion: la sesion
  queda esperando un enrollment nuevo. Una caida de red si reconecta, porque cortarle
  el servicio al telefono por un corte de wifi seria peor.
- `MainActivity` tiene las dos pantallas: enrolar con un desafio, o el secret legacy de
  desarrollo. Ningun campo se loguea.

### BLOCK 12.1: el desafio queda atado al telefono

Antes el desafio era un pase sin dueno: quien lo obtuviera podia reclamar cualquier
identidad. Ahora el dueno dice **que telefono** autoriza, y ese vinculo se guarda con
el desafio.

```
1. la app muestra su deviceId            mobile:<UUID>, persistido desde el primer arranque
2. el dueno pide el desafio              POST /enrollment/challenge  {deviceId}
3. el servidor guarda el vinculo         challenge_hash -> device_id
4. el telefono lo canjea                 POST /enrollment/claim  {challenge, deviceId}
5. el claim exige EXACTAMENTE ese deviceId, y lo consume con un CAS
```

Cuatro propiedades que de verdad importan:

- **El intento equivocado no gasta nada.** B presentando el desafio de A recibe
  `device_id_mismatch`, y el desafio sigue vivo para A. El `device_id` va **dentro**
  del `UPDATE` del CAS, no en un chequeo previo.
- **El consumo es un compare-and-swap.** Una sola sentencia decide:
  `UPDATE ... SET consumed_at = ? WHERE challenge_hash = ? AND consumed_at IS NULL AND device_id = ?`.
  Dos claims simultaneos no pueden ganar los dos. En BLOCK 12 esto era
  `readChallenge` + `deleteChallenge`, con un `await` en el medio y una carrera real.
- **Reutilizar dice `challenge_consumed`, no `challenge_unknown`.** La fila sigue viva
  marcada, asi que el telefono recibe un motivo preciso.
- **El token de dueno va en `Authorization`, no en la URL.** `?token=` queda como
  compatibilidad, no como el camino documentado.

### El camino legacy quedo cerrado para telefonos

Una identidad mobile sin credencial propia ya **no** entra por
`?token=DEVICE_SHARED_SECRET`: el hello se rechaza con `device_not_enrolled`. Y una
identidad que si esta en el registro se rechaza con `device_is_enrolled_or_revoked`, que
es un motivo distinto y accionable ("ya estabas enrolado, no uses el secreto global").

Esto no afecta a Desktop ni al ESP32: ellos no pasan por la ruta mobile, conectan contra
`/agents/apollo/<desk>` con su propio `onBeforeConnect` y su rol `device`. Lo que queda
del camino legacy en la ruta mobile son las llamadas que **no** son un dispositivo -- el
RPC del bridge, el inspector, el harness -- porque no mandan `hello`.

Por eso `MainActivity` retiro la pantalla del `DEVICE_SHARED_SECRET`: ofrecer una opcion
que el servidor ya rechaza seria una pantalla que miente.

### Migracion del store

`CREATE TABLE IF NOT EXISTS` no agrega columnas a una tabla existente, asi que una
deployment de BLOCK 12 -- que ya tiene `mobile_enrollment_challenge` -- fallaba con
`no column named device_id`. El store ahora migra de forma aditiva e idempotente, y el
memo es de promesa y no de booleano porque con booleano dos requests concurrentes
corrian la migracion los dos y la segunda moria con `duplicate column name`.

Las filas viejas quedan con `device_id` vacio y no autorizan a nadie: un desafio de
BLOCK 12 no tenia vinculo, asi que no puede atarse a nadie.

### Gaps declarados

1. **Sin UI de administracion.** El dueno emite el desafio y revoca por HTTP con el
   token del dashboard. No hay pagina en `/console`: el bloque pedia no tocar la UI.
2. **Sin hardware.** `KeystoreCredentialCipher` no se ejecuto contra un telefono real:
   lo probado es el puerto (`CredentialCipher`) y la logica, no el Keystore de un
   Android vivo.
3. **Provisioning productivo sigue pendiente.** El enrollment es por telefono, pero la
   distribucion inicial de credenciales es manual (pegar el desafio). No hay onboarding
   por QR ni provisionamiento remoto.
4. **El `deviceId` llega al dueno por un canal fuera de banda.** El flujo funciona, pero
   si alguien logra que el dueno autorice el `deviceId` equivocado, ese telefono queda
   enrolado. Atar el desafio a un canal autenticado (QR firmado) lo cerraria.


## Tests

`app/src/test/java/com/apollo/mobile/` tiene JUnit 4 y **66 casos**: los 22
obligatorios de BLOCK 10 (mas extras) y los de BLOCK 11 y 12.1. Se ejecutan de verdad:

```bash
./gradlew :app:testDebugUnitTest
```

Mapa de los 22 obligatorios a los tests que los cubren:

| # | Caso | Test |
|---|---|---|
| 1 | stable deviceId | `IdentityTest.generatesAStructuredMobileDeviceId`, `reusesTheSameDeviceIdOnTheNextBoot` |
| 2 | hello mobile correcto | `SessionTest.sendsAHelloMobileWithTheStructuredContract` |
| 3 | solo mobile.notifications | `SessionTest.announcesOnlyMobileNotifications` |
| 4 | authentication failure | `SessionTest.anInvalidTokenNeverReachesOnline`, `recordsTheRejectionReasonAndStaysDisconnected` |
| 5 | successful connection | `SessionTest.reachesOnlineWhenTheServerAcceptsTheHello` |
| 6 | heartbeat | `HeartbeatTest.sendsHeartbeatsWithTheServerProvidedInterval`, `answersTheHeartbeatProbe` |
| 7 | disconnect | `HeartbeatTest.dropsTheHeartbeatWhenTheConnectionDies` |
| 8 | reconnect mismo deviceId | `HeartbeatTest.aReconnectKeepsTheSameDeviceId` |
| 9 | no duplicate heartbeat timer | `HeartbeatTest.aReconnectDoesNotDuplicateTheHeartbeatScheduler` |
| 10 | notification command valido | `CommandTest.acceptsTheAllowlistedNotificationCapability` |
| 11 | desktop capability rechazada | `CommandTest.rejectsADesktopCapability` |
| 12 | mobile unimplemented rechazada | `CommandTest.rejectsAnUnimplementedMobileCapability` |
| 13 | unknown capability rechazada | `CommandTest.rejectsAnUnknownCapability` |
| 14 | payload invalido | `CommandTest.rejectsAnInvalidPayload`, `thePayloadValidatorIsStrictAboutBothDirections` |
| 15 | notification success | `NotificationTest.postsWhenThePermissionIsGranted` |
| 16 | permission denied | `NotificationTest.reportsPermissionDeniedWithoutPostingAndWithoutRetrying` |
| 17 | requestId preservado | `ResultTest.preservesTheRequestIdExactly` |
| 18 | duplicate in-flight request | `DuplicateTest.runsOneEffectForADuplicateInFlightRequestId` |
| 19 | malformed envelope | `EnvelopeTest.rejectsAMalformedEnvelope` |
| 20 | command antes de autenticacion | `SecurityTest.rejectsACommandBeforeAuthentication` |
| 21 | command dirigido a otro device | `SecurityTest.rejectsACommandDirectedToAnotherDevice` |
| 22 | result envelope correcto | `ResultTest.buildsAFailureResultWithAStructuredError` |

Ademas `apps/mobile/__tests__/contract.spec.ts` corre en `bun run test` y:

- deriva las expectativas del lado TypeScript del Worker (ruta, `deviceType`, `protocolVersion`,
  capabilities implementadas, comandos, limites del payload, intervalo de heartbeat) y las
  compara con las constantes declaradas en Kotlin;
- deriva la tabla de backoff del propio doc del repo;
- forbid que el secret llegue al bundle y que el cliente importe internals del servidor;
- ata el cliente del smoke (`apps/agent/smoke/mobile-client.ts`) al cliente Kotlin.

Ese gate tiene sus propios mutation checks: **21 contra el Kotlin** y 9 contra el
puerto del smoke, todas detectadas. Las de BLOCK 11 apuntan a los bugs que este
bloque corrige:

| Mutacion | Que se rompe si pasa |
|---|---|
| el peer acepta una capability que no es mobile | allowlist se abre de mas |
| el peer acepta un comando que su capability no declara | se ejecuta algo no pedido |
| el peer deja de rechazar campos extra | payload laxo |
| el peer valida el payload por capability en vez de por comando | vuelve el bug de `alarm_cancel` |
| `volume_get` vuelve a devolver exito fijo | miente sobre el volumen |
| se borra la rama de `calendar_list` | comando declarado sin efecto |
| `media_play` reporta exito sin reproducir | miente sobre la musica |
| el `command_result` tira los datos | los comandos de lectura no devuelven nada |
| el puerto deja de exponer los comandos de lectura | la lectura desaparece del contrato |
| Android deja de leer el volumen real | stub que compila y no hace nada |

El guard de JUnit tambien se derivo del catalogo: `everyImplementedMobileCapabilityReachesItsPlatformCommand`
recorre `ALLOWED_COMMAND_MAP` y falla si hay un comando sin rama en el dispatcher.
La version anterior de ese test era una lista escrita a mano, y por eso
`calendar_list` y `volume_get` quedaron afuera del test justo cuando no
funcionaban.

## APK y scan de secrets

```bash
./gradlew :app:assembleDebug
bun test apps/mobile/__tests__/artifact.spec.ts
```

El APK sale en `app/build/outputs/apk/debug/app-debug.apk`
(`com.apollo.mobile`, minSdk 25, targetSdk 25).

`__tests__/artifact.ts` es un scanner del artefacto: abre el ZIP del APK,
**descomprime** cada entrada (los strings viven deflateados, asi que un grep sobre
el `.apk` crudo no encontraria nada) y busca secrets de desarrollo, URLs con
`?token=` hardcodeado y asignaciones de `*_SHARED_SECRET`. Falla si aparece alguno.

El scanner tiene sus propios tests con APKs sinteticos que SI contienen un secret,
para probar que el guard tiene dientes y no es decorativo, y mutation checks propios.

## Bugs reales que encontro la ejecucion con toolchain

Estos aparecieron solo al compilar de verdad (BLOCK 10.1); no se podian ver sin javac:

1. **`Build.VERSION_CODES.TIRAMISU` y `Manifest.permission.POST_NOTIFICATIONS` no existen en el SDK de compilacion 28.** El codigo no compilaba. Ahora van como literales con guarda de API.
2. **`.put("title" to "Apollo")`** en dos tests: el `to` infijo de Kotlin construye un `Pair`, no es el `put(String, value)` de `JSONObject`.
3. **Faltaba el import de `PermissionOutcome`** en `ResultTest.kt`.
4. **No existia el Gradle wrapper**, aunque el bloque lo invoca con `./gradlew`.
5. **Gradle 4.6 + AGP 3.3.3 son incompatibles** (ver arriba).

Ninguna assertion se relajo, ningun test se borro y nada se reemplazo por TypeScript.

## Smoke

```bash
bun run --cwd apps/agent smoke/mobile-client-smoke.ts   # 53 checks, peer Kotlin no corre
bun run smoke:multi-device                              # 30 checks, orquestacion
```

Cliente mobile real -> WebSocket real -> MobileBridge real -> Apollo real ->
`mobile.notifications` -> notificacion -> `command_result` real.

`smoke/multi-device.ts` (BLOCK 11) cubre la orquestacion: target explicito, `any`,
failover cuando un device se cae, reconexion, `requestId` duplicado, resultado
tardio, `unsupported_command`, `invalid_payload` y aislamiento entre devices.

Los dos unicos componentes que no corren ahi son el runtime de Android y el APK:
la notificacion nativa y la plataforma mobile se representan con dobles que
registran lo que se habria hecho. Todo lo demas (handshake, auth, registry,
heartbeat, dispatch, `requestId`, idempotencia, reconexion, reachability,
contexto cross-device) es real.
