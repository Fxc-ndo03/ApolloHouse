# Builds de staging de Apollo (PC y Android)

Estos builds apuntan **exclusivamente** a `apollo-staging.facupapollo.workers.dev`
y están separados de producción por tres capas: destino, credenciales y
identidad de aplicación. Ninguno contiene tokens, contraseñas ni secretos.

## Por qué existe

Probar el login de cuentas nuevas requiere una aplicación que apunte al entorno
de pruebas sin pisar la instalación normal: ni su Worker, ni su sesión en
Credential Manager / Keystore, ni sus datos.

## Escritorio (Tauri)

Dos decisiones al **compilar**, no en runtime: el binario no puede cambiar de
entorno por accidente.

```bash
# build normal (producción) — el comportamiento de siempre
cargo test --lib

# build de staging
cd apps/desktop
set APOLLO_WORKER_URL=wss://apollo-staging.facupapollo.workers.dev/agents/apollo/default
set APOLLO_CREDENTIAL_NAMESPACE=:staging
npx @tauri-apps/cli build --config src-tauri/tauri.staging.conf.json
```
  ambos del mismo origen), así que nunca hay la mitad HTTP en un entorno y WS
  en otro.
  (`AccountAuthClient::from_worker_url` y `account_conversation_url` derivan
  ambos del mismo origen), así que nunca hay一半 HTTP en un entorno y WS en otro.
- `APOLLO_CREDENTIAL_NAMESPACE`: sufijo de las entradas de Credential Manager.
  Sin él los nombres son los de siempre; con `:staging` quedan
  `ApolloDesktop:staging:account-session` y
  `ApolloDesktop:staging:device-shared-secret`. Un build de staging **no lee ni
  borra** las entradas de producción, y un logout de staging sólo borra lo suyo.
- `tauri.staging.conf.json`: perfil Tauri que cambia `productName` a
  "Apollo Desktop (STAGING)" e `identifier` a `com.apollo.desktop.staging`, para
  que conviva con la instalación normal. `tauri.conf.json` de producción no se
  toca.

Artefactos que produce:
- `src-tauri/target/release/apollo-desktop.exe`
- `src-tauri/target/release/bundle/nsis/Apollo Desktop (STAGING)_0.1.1_x64-setup.exe`

## Android

Variante de producto `staging` (Gradle `productFlavors`):

```bash
cd apps/mobile
./gradlew assembleStagingDebug
./gradlew assembleStagingDebug -PapolloWorkerHost=apollo-staging.facupapollo.workers.dev
```

- `applicationIdSuffix '.staging'` → el identificador final es
  `com.apollo.mobile.staging`: se instala **junto** a la app normal, con su propio
  paquete de datos (SharedPreferences), su propio Android Keystore y su propio
  espacio de apps. No puede pisar ni borrar datos de producción.
- Nombre visible: "Apollo (STAGING)" (`resValue app_name`).
- `BuildConfig.DEFAULT_WORKER_HOST` = `apollo-staging.facupapollo.workers.dev` en
  esta variante. En el build normal la propiedad queda vacía y la app arranca sin
  host, que es el comportamiento previo: **no hay fallback silencioso a
  producción**.

APK: `app/build/outputs/apk/staging/debug/app-staging-debug.apk`.

## Instalar

```bash
# Android (con el teléfono en modo depuración)
adb install -r app/build/outputs/apk/staging/debug/app-staging-debug.apk

# Escritorio: ejecutar el instalador NSIS generado
# (doble clic, o Start-Process "Apollo Desktop (STAGING)_0.1.1_x64-setup.exe")
```

## Primer arranque y login

1. En la app de staging, el host ya viene cargado (staging). Si aparece vacío,
   escribí `apollo-staging.facupapollo.workers.dev` a mano.
2. Registrá o iniciá sesión con una cuenta **sintética** de staging.
3. El token de sesión se guarda en Credential Manager (PC) o Android Keystore
   (Android) y viaja en `Authorization: Bearer`, **nunca en la URL**.
4. Verificá el entorno: en PC, *Ajustes → Worker* debe mostrar
   `apollo-staging.facupapollo.workers.dev`; en Android, el host de la pantalla
   principal.

## Desinstalar sin tocar producción

- Android: `adb uninstall com.apollo.mobile.staging` (o desinstalar "Apollo
  (STAGING)"). Sólo borra los datos de la variante staging.
- PC: desinstalar "Apollo Desktop (STAGING)" desde *Configuración → Aplicaciones*.
  La instalación normal y sus credenciales quedan intactas.

## Conversación real: qué falta

El Worker de **staging** tiene una clave sintética del proveedor de IA: acepta
conexiones y enruta, pero la llamada al modelo falla. Por eso una conversación
"de prueba" termina en `turn_failed`: eso demuestra el camino de contrato
(registro → sesión → WebSocket → cuota), **no** una conversación real.

Para que una respuesta llegue al proveedor hace falta una credencial válida de
staging, provista por el mecanismo de secrets (`wrangler secret put GEMINI_API_KEY
--env staging`) y nunca por código o configuración versionada. No hay una en este
entorno y no se usó ninguna de producción.
