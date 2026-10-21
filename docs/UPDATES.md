# Actualizaciones automáticas de Apollo

Cómo se actualizan Apollo Desktop (Windows) y Apollo Mobile (Android), en dos
canales separados, sin servicios de pago y sin perder datos.

## Cómo funciona, en una línea

Un build publica sus artefactos en una **release de GitHub** junto a dos
manifiestos JSON. Cada app consulta **el manifiesto de su canal** al arrancar y
periódicamente, y decide con reglas comprobables si lo instala. Las firmas
verifican autenticidad; los hashes verifican integridad. Son cosas distintas y
ninguna reemplaza a la otra.

## Canales

| Canal | Etiqueta | Manifiesto de escritorio | Manifiesto Android | Builds |
|---|---|---|---|---|
| Estable | `v<version>` | `releases/latest/download/latest.json` | `releases/latest/download/android.json` | `com.apollo.desktop`, `com.apollo.mobile` |
| Staging | `staging` | `releases/download/staging/latest.json` | `releases/download/staging/android.json` | `com.apollo.desktop.staging`, `com.apollo.mobile.staging` |

El canal se compila dentro del binario (`APOLLO_UPDATE_CHANNEL`). Una app de
staging pide el manifiesto de staging; si alguien apunta el manifiesto del canal
equivocado, el cliente **rechaza** la actualización en vez de instalarla: hay
tests que lo verifican en ambos sentidos.

## Windows (Tauri)

Usa el actualizador oficial `tauri-plugin-updater`, que valida la **firma
minisign** del artefacto antes de instalarlo. Apollo no reimplementa esa
verificación.

- Endpoint y clave pública: `apps/desktop/src-tauri/tauri.conf.json` (estable) y
  `tauri.staging.conf.json` (staging).
- Comandos: `check_for_update`, `download_and_install_update`,
  `update_channel`, `restart_after_update`.
- UI: *Ajustes → Sistema → Actualizaciones*. Muestra versión, canal, última
  comprobación, progreso, notas y estado.
- El reinicio **nunca** es automático tras instalar: se pide confirmación, para
  no cortar una conversación en curso.

### Requisitos para publicar una actualización de Windows

1. `TAURI_SIGNING_PRIVATE_KEY` configurada como secreto del repositorio.
2. La **misma** clave pública en `tauri.conf.json` y `tauri.staging.conf.json`.
3. Una release publicada con `latest.json` y el instalador + `.sig`.

Si falta la clave privada, el workflow **falla** y no publica nada: es preferible
a publicar una release que ningún cliente pueda instalar.

## Android

Android **no permite instalación silenciosa** en un teléfono normal. Apollo
automatiza todo lo permitido y usa el instalador del sistema para el paso que
requiere confirmación de la persona.

### Cómo está conectado (FASE 3.5)

El actualizador no es una biblioteca suelta: está atado al ciclo de vida real.

- **`UpdateOwner`** vive en la `Application`, no en la pantalla, por el mismo
  motivo que `sessionOwner`: una descarga que dependiera de la `Activity` se
  perdería al rotar el teléfono. La UI lo **observa**.
- **Comprobación al arrancar** (`onStart`) y **al volver a primer plano**
  (`onResume`). Ambas pasan por un intervalo de **6 horas**: abrir y cerrar la
  pantalla diez veces no produce diez consultas. "Reintentar" lo ignora porque
  lo pidió la persona.
- **Sin servicio en segundo plano**: comprobar cuando hay alguien mirando es
  suficiente, y una tarea periódica sería trabajo que Android penaliza.
- **No se duplican descargas**: si ya hay una comprobación o una descarga en
  vuelo, la segunda petición se rechaza; si el APK ya está verificado, no se
  vuelve a bajar.
- La red y el instalador del sistema son fronteras inyectables
  (`UpdateInstallerGateway`), lo que permite probar el flujo completo sin
  dispositivo.

### Variantes y canales (FASE 3.6)

Hay **dos flavors**, y cada uno es una aplicación distinta con su canal:

| Flavor | `applicationId` | `UPDATE_CHANNEL` | Manifiesto | Tarea de release |
|---|---|---|---|---|
| `stable` | `com.apollo.mobile` | `stable` | `releases/latest/download/android.json` | `:app:assembleStableRelease` |
| `staging` | `com.apollo.mobile.staging` | `staging` | `releases/download/staging/android.json` | `:app:assembleStagingRelease` |

El canal se declara en el flavor y se compila dentro del binario. **No se
infiere de la URL del Worker.**

`stable` **no** lleva `applicationIdSuffix`: su paquete es exactamente
`com.apollo.mobile`, el de las instalaciones de producción ya existentes. Si
cambiara, esas instalaciones dejarían de recibir actualizaciones aunque el
certiguado fuera el mismo.

> Antes de la FASE 3.6 sólo existía el flavor `staging`, así que la "producción"
> no tenía variante propia y el build de release firmaba con la clave de
> producción el APK de staging.

### Matriz de firma

Cada canal tiene su keystore y **no se sustituyen entre sí**:

| Variante | Clave | ¿Necesita secretos? |
|---|---|---|
| `:app:assembleStableDebug` | debug key local | no |
| `:app:assembleStagingDebug` | debug key local | no |
| `:app:assembleStableRelease` | **producción** (`ANDROID_KEYSTORE_*`) | sí |
| `:app:assembleStagingRelease` | **staging** (`STAGING_KEYSTORE_*`) | sí |

La firma se asigna **por variante de release**, no en `buildTypes.release` ni en
el flavor: en el buildType firmaría todo con la clave de producción, y en el
flavor haría que hasta `stagingDebug` usara la clave de producción.

Si a una release le falta su credencial, el build **falla antes de producir el
APK** diciendo exactamente cuál falta. Configurar la clave del otro canal no
sirve: no hay sustitución posible.

### Verificación antes de publicar

`scripts/verify-android-apk.ts` lee el APK construido y lo contrasta con lo que
se esperaba publicar: `applicationId`, `versionName`, `versionCode` y
certificado. El workflow corre esto **antes** de generar el manifiesto, y el
manifiesto se arma desde ese mismo APK verificado.

Es una barrera real: si el build de "stable" saliera con el paquete o el canal
de staging, el proceso muere ahí en vez de publicar un manifiesto que describe
una cosa y adjunta otra.

### La clave de producción no se puede perder

El certificado de producción es la identidad de `com.apollo.mobile`. Android
exige que un APK nuevo vaya firmado con **el mismo certificado** que la app ya
instalada. Si esa clave se pierde:

- las instalaciones existentes **dejan de poder actualizarse**;
- no hay forma de recuperarlas: habría que publicar con un `applicationId`
  nuevo, lo que deja atrás sesiones, preferencias y conversaciones.

**Copiá `ANDROID_KEYSTORE_*` y `STAGING_KEYSTORE_*` a un gestor de secretos y
respaldalos fuera de GitHub.** No se regeneran nunca: si no hay clave, ese canal
queda bloqueado para publicar y se avisa, pero no se improvisa un certificado
nuevo.

### Integridad del APK

- Se escribe con extensión `.parcial` y recién se renombra al terminar: **un
  APK a medio descargar jamás queda con el nombre final**.
- Se compara el **tamaño exacto** contra `sizeBytes` del manifiesto, y el
  **SHA-256** por bloques (nunca el APK entero en memoria).
- Si algo no cuadra, el parcial se borra y no se abre el instalador.
- Descargar limpia los APK de **otras versiones**, para que un reintento no
  pueda toparse un archivo viejo.
- El instalador recibe **el archivo exacto** que se verificó, no "el APK más
  reciente por fecha". Antes, con dos versiones en caché, se podía abrir un APK
  distinto del que el manifiesto había autorizado.
- Las validaciones se **repiten inmediatamente antes** de abrir el instalador.
  Si el archivo cambió, se borra y hay que comprobar de nuevo.

### Instalación

- Se comprueba `canRequestPackageInstalls()`. Si falta, se explica y se lleva a
  la pantalla del sistema; **al volver se vuelve a leer el permiso**.
- El APK se comparte por `FileProvider`, nunca con `file://`.
- Se usa `startActivityForResult` para **recibir el regreso**. Al volver se
  relee el `versionCode` realmente instalado: **abrir el instalador no es
  instalar**. Si no cambió, se dice que no quedó instalada y se pide comprobar
  de nuevo.

### Compatibilidad

- `applicationId` de producción: `com.apollo.mobile`; staging añade `.staging`.
- `minSdk 33`: los APK actuales requieren Android 13 o superior. El manifiesto
  anuncia este mínimo para que dispositivos incompatibles no reciban la oferta.
- La **firma la exige Android**: el APK nuevo debe llevar el mismo certificado
  que la app instalada y un `versionCode` mayor. Eso es lo que preserva cuenta,
  sesión, preferencias y conversaciones al actualizar.
- `minSigningCertificateSha256` es **informativo y hoy no se verifica**: el
  generador no lo publica. La única comprobación de certificado que vale es la
  del sistema al instalar, y la app no simula ninguna otra.

### Compatibilidad de firma en Android

- `applicationId` de producción: `com.apollo.mobile`.
- Un APK nuevo actualiza el existente porque coincide identificador + certificado
  y sube `versionCode`.
- **No se genera ni se reemplaza el certificado de producción aquí.** Si no tenés
  el keystore, configurá el secreto `ANDROID_KEYSTORE_BASE64` (más
  `ANDROID_KEY_ALIAS` y `ANDROID_KEY_PASSWORD`) en el repositorio antes de
  publicar al canal estable. Sin ese secreto, publica solo staging o pedí que te
  lo/enviarlo por un canal seguro. Perderlo significa no poder publicar
  actualizaciones de producción.

## Publicar una versión

Ningún canal se publica con `git push` directo. Las dos vías pasan por
*Publish Apollo client release*.

### Staging (release rodante)

Staging publica siempre en la misma release, la etiquetada `staging`. Para no
repetir la misma versión ni dejarla a medias, el workflow compara el
`versionCode` solicitado contra el de `android.json` ya publicado y **rechaza**
cualquier valor que no sea estrictamente mayor.

```text
Actions → Publish Apollo client release → Run workflow
  channel: staging
  version: 1.4.1        # semver de tres componentes, siempre creciente
```

Sólo las apps de staging lo ven. La release rodante sobrescribe sus artefactos;
la versión anterior se conserva en el historial de la release.

### Producción (release estable e inmutable)

```bash
# 1. Commiteá los cambios.
# 2. Etiquetá y subí la etiqueta; no hace falta tocar tauri.conf.json.
git tag v1.4.0
git push origin v1.4.0
```

El workflow valida el formato `v<major>.<minor>.<patch>`, deriva el
`versionCode` de la versión, corre las suites, firma y publica la release con
`latest.json` y `android.json`. Si la etiqueta ya tiene una release, el
workflow **falla**: las releases estables no se sobrescriben. Para corregir algo
hay que publicar una versión nueva.

Una publicación estable nunca ocurre por un commit o una compilación de prueba:
requiere la etiqueta. `workflow_dispatch` con canal `stable` se rechaza a
propósito, para que una prueba manual no pueda abrir un canal estable.

### Números de versión

El `versionCode` de Android se deriva de la versión, con `minor` y `patch`
limitados a 99 porque cada uno ocupa dos dígitos:

```text
versionCode = major * 10000 + minor * 100 + patch
```

Sin ese límite `1.0.100` y `1.1.0` producirían el mismo código. Staging suma
`99900000`, de modo que sus APK ocupan una banda propia y un cliente nunca puede
recibir un APK firmado con el certificado del otro canal.

El nombre de versión del APK de staging lleva el sufijo `-staging`
(`1.4.0-staging`) mientras el manifiesto dice `1.4.0`: el sufijo es metadata de
variante, y la comparación de actualizaciones usa siempre el `versionCode`.

## Comandos exactos

```bash
# compilar la app de escritorio de staging
cd apps/desktop
set APOLLO_WORKER_URL=wss://apollo-staging.facupapollo.workers.dev/agents/apollo/default
set APOLLO_CREDENTIAL_NAMESPACE=:staging
set APOLLO_UPDATE_CHANNEL=staging
.\ui\node_modules\.bin\tauri.exe build --config src-tauri/tauri.staging.conf.json

# compilar el APK de staging
cd apps/mobile
./gradlew assembleStagingDebug

# generar los manifiestos desde artefactos ya firmados
bun scripts/generate-update-manifest.ts \
  --channel stable --version 1.4.0 --android-version-code 10400 \
  --windows-setup <ruta>/Apollo_Desktop_1.4.0_x64-setup.exe \
  --android-apk <ruta>/app-release.apk \
  --out-latest latest.json --out-android android.json
```

El cliente de Tauri se compila desde `apps/desktop`, no desde `apps/desktop/ui`:
el CLI busca `tauri.conf.json` en el directorio actual o sus subdirectorios, y
sólo `apps/desktop` contiene a `src-tauri`.

## Si algo falla

| Síntoma | Qué significa | Qué hacer |
|---|---|---|
| "La firma de la actualización no es válida" | El artefacto no lo firmó la clave cuya pública está en el binario | No se instaló nada. Revisá que `TAURI_SIGNING_PRIVATE_KEY` sea la misma que generó esa clave pública |
| "La descarga no coincide con el hash esperado" | Integridad rota; el archivo se borró | Reintentá la descarga. Si persiste, la release está corrupta |
| "El manifiesto es del canal X y esta app es Y" | Se mezclaron canales | Está funcionando: el aislamiento evitó una instalación incorrecta |
| "La conexión se interrumpió" | Fallo de red | Reintentá; el error es recuperable y no cambia nada |
| Android: "ninguna app puede abrir el instalador" | Falta el permiso de fuentes desconocidas | Habilitalo en *Ajustes → Apps → acceso especial → instalar apps desconocidas* |
| Android: "el APK requiere Android 13" | Tu teléfono es anterior a API 33 | Esta versión no se ofrece a ese dispositivo |

## Qué falta configurar (externo a este repositorio)

1. `TAURI_SIGNING_PRIVATE_KEY` como secreto de Actions. **Respaldala fuera de
   GitHub.** Sin ella no hay actualizaciones automáticas de Windows.
2. La privada vivió en `~/.apollo/release-keys/apollo-updater.key` al generarla
   en este entorno. Conviene moverla a un gestor de secretos.
3. `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` y
   `ANDROID_KEY_PASSWORD` para publicar al canal estable desde CI. Son los
   secretos de producción: **nunca** los reutilices para staging.
4. `STAGING_KEYSTORE_BASE64`, `STAGING_KEYSTORE_PASSWORD`, `STAGING_KEY_ALIAS` y
   `STAGING_KEY_PASSWORD`. Staging necesita su **propia** clave: si se firmara
   con la debug key que Windows genera en cada runner, cada publicación sería
   incompatible con la anterior y el actualizador fallaría siempre.
5. Publicar la **primera** release en cada canal: hasta que exista un
   `latest.json`/`android.json`, los clientes informarán "todavía no hay
   ninguna release publicada en este canal", que es el comportamiento correcto.
6. **Rotar el PAT de GitHub**: estuvo incrustado en la URL del remoto. Ya se
   limpió `.git/config` y quedó como
   `https://github.com/Fxc-ndo03/ApolloHouse.git`, pero el token sigue sin
   revocar y hay que hacerlo en GitHub.

## Qué NO hace este sistema

- No instala en silencio en Android: eso requiere MDM o una tienda con su propio
  actualizador, y no se intenta esquivar.
- No instala una versión anterior, ni de otro canal, ni sin firma válida.
- No borra datos ni cierra sesión al actualizar.
- No cobra ni depende de un servicio de pago: usa GitHub Releases.
