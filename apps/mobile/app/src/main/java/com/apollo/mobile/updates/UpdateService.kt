package com.apollo.mobile.updates

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/**
 * FASE 3.1 / 3.5 — orquestador de actualizaciones de Apollo en Android.
 *
 * Recorre exactamente el mismo camino que el cliente de escritorio:
 * manifiesto del canal -> decisión -> descarga -> verificación -> instalador del
 * sistema. Lo que cambia es el último paso: Android exige que la persona
 * confirme, y eso no se puede (ni se debe) automatizar.
 *
 * FASE 3.5: ya no recibe un `Context`. Toda la dependencia con Android quedó
 * detrás de [UpdateInstallerGateway] y de las dos funciones de red inyectadas,
 * de modo que el flujo completo se puede ejercitar en tests sin dispositivo.
 */
class UpdateService(
    private val installer: UpdateInstallerGateway,
    private val manifestUrl: String,
    private val appChannel: String,
    private val manifestFetcher: (String) -> String = ::fetchManifestOverHttps,
    private val apkSource: UpdateDownloader.ApkSource = UpdateDownloader.HttpsApkSource,
    /**
     * Dónde corre la red.
     *
     * En la app es `Dispatchers.IO`. Es inyectable para que los tests puedan
     * ejecutarlo en línea y afirmar sobre el resultado sin esperar: el resto
     * del flujo es idéntico.
     */
    private val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
    /**
     * API del dispositivo.
     *
     * En la app es `Build.VERSION.SDK_INT`. Es inyectable porque en un test
     * unitario el stub de Android devuelve 0, y contra `minSdk` eso haría que
     * TODO se rechazara como incompatible.
     */
    private val deviceSdkIntProvider: () -> Int = { android.os.Build.VERSION.SDK_INT }
) {

    sealed class Outcome {
        object SinActualizaciones : Outcome()
        data class HayActualizacion(
            val manifest: UpdateManifest,
            val rejection: UpdateRejection?
        ) : Outcome()

        data class Descargando(val bytesRead: Long, val totalBytes: Long) : Outcome()
        data class ListoParaInstalar(val apk: UpdateDownloader.VerifiedApk) : Outcome()
        object FaltaPermisoDeInstalacion : Outcome()
        data class Error(val motivo: String, val recuperable: Boolean) : Outcome()
    }

    private val installedVersionCode: Long
        get() = runCatching { installer.installedVersionCode() }.getOrElse { 0L }

    /**
     * Consulta el manifiesto del canal de ESTA app.
     *
     * El canal viene del build (staging o estable) y la URL se valida como
     * HTTPS antes de abrir nada.
     */
    suspend fun check(): Outcome = withContext(ioDispatcher) {
        if (!manifestUrl.startsWith("https://")) {
            return@withContext Outcome.Error("El manifiesto no esta en HTTPS", false)
        }
        val body = runCatching { manifestFetcher(manifestUrl) }
            .getOrElse { error ->
                return@withContext Outcome.Error(
                    "No se pudo contactar al servidor de actualizaciones: ${error.message ?: "sin detalle"}",
                    true
                )
            }
        val manifest = UpdateManifest.parse(body)
            ?: return@withContext Outcome.Error("El manifiesto no se pudo interpretar", true)

        val rejection = UpdateEvaluator.findRejection(
            installedVersionCode = installedVersionCode,
            deviceSdkInt = runCatching { deviceSdkIntProvider() }
                .getOrDefault(android.os.Build.VERSION.SDK_INT),
            appChannel = appChannel,
            manifest = manifest
        )
        Outcome.HayActualizacion(manifest, rejection)
    }

    suspend fun download(
        manifest: UpdateManifest,
        onProgress: (Long, Long) -> Unit
    ): Outcome = withContext(ioDispatcher) {
        val result = UpdateDownloader.download(
            cacheDirectory = installer.cacheDirectory,
            manifest = manifest,
            onProgress = onProgress,
            source = apkSource
        )
        when (result) {
            is UpdateDownloader.Result.Listo -> {
                // Se limpian los APK de otras versiones: un reintento posterior
                // no debe poder toparse un archivo viejo.
                UpdateDownloader.discardOtherDownloads(installer.cacheDirectory, result.apk.file)
                Outcome.ListoParaInstalar(result.apk)
            }
            UpdateDownloader.Result.SinPermisoDeInstalacion -> Outcome.FaltaPermisoDeInstalacion
            is UpdateDownloader.Result.Fallo -> Outcome.Error(result.motivo, result.recuperable)
        }
    }

    /**
     * Abre el instalador del sistema para el APK YA verificado.
     *
     * FASE 3.5 — recibe el archivo exacto que produjo la descarga, no uno
     * buscado por fecha. Antes, `latestDownloadedApk()` devolvía "el APK más
     * reciente del caché": con dos versiones presentes, la persona podía
     * instalar algo distinto del que el manifiesto había autorizado.
     *
     * Las validaciones se REPITEN acá, inmediatamente antes de abrir: entre
     * descargar e instalar pueden pasar minutos y el archivo pudo cambiar. Si
     * algo no cuadra, se aborta y hay que comprobar de nuevo.
     */
    fun openInstaller(apk: UpdateDownloader.VerifiedApk): Outcome {
        if (!installer.canRequestInstall()) return Outcome.FaltaPermisoDeInstalacion

        val problem = UpdateDownloader.reverifyBeforeInstall(apk)
        if (problem != null) {
            // El archivo ya no es el que se verificó: se borra para que nadie
            // pueda reusarlo, y se pide una comprobación nueva.
            apk.file.delete()
            return Outcome.Error(problem, recuperable = true)
        }

        val launchResult = installer.openInstaller(apk)
        return when (launchResult) {
            UpdateDownloader.InstallerLaunch.Iniciado ->
                // Abrir el instalador NO es instalar. El estado real se decide
                // leyendo el `versionCode` de vuelta, en
                // [resolveAfterReturningFromInstaller].
                Outcome.ListoParaInstalar(apk)
            is UpdateDownloader.InstallerLaunch.Error ->
                Outcome.Error(launchResult.motivo, recuperable = true)
        }
    }

    /**
     * Qué pasó realmente después de volver de la pantalla de instalación.
     *
     * Se compara el `versionCode` instalado con el que ofrecía el manifiesto.
     * Android puede rechazar la instalación (firma distinta, falta de espacio,
     * cancelación) y no hay forma de saberlo sin mirarlo.
     */
    fun resolveAfterReturningFromInstaller(
        apk: UpdateDownloader.VerifiedApk
    ): Outcome {
        if (installedVersionCode < apk.versionCode) {
            // No se instaló. El archivo verificado ya no sirve para reintentar
            // porque el manifiesto pudo moverse, así que no se conserva.
            UpdateDownloader.discardOtherDownloads(installer.cacheDirectory, null)
            return Outcome.Error(
                "La actualizacion no quedo instalada (sigue la version actual)",
                recuperable = true
            )
        }
        UpdateDownloader.discardOtherDownloads(installer.cacheDirectory, null)
        apk.file.delete()
        return Outcome.SinActualizaciones
    }

    /** Explica, sin adivinar, qué falta para poder instalar. */
    fun explainMissingPermission(): String =
        "Para actualizar, Android necesita permiso para instalar aplicaciones de esta " +
            "fuente. Abre Ajustes > Aplicaciones > acceso especial > instalar apps " +
            "desconocidas y habilitalo para Apollo. La app no puede instalarse sola."

    companion object {
        /**
         * Construye el servicio con el canal de ESTA build.
         *
         * No hay URL suelta: el canal sale de `BuildConfig.UPDATE_CHANNEL`, que
         * fija el flavor, y la URL se deriva de ahí.
         */
        fun forThisBuild(context: Context): UpdateService {
            val channel = UpdateManifest.channelOfThisBuild()
            return UpdateService(
                installer = AndroidUpdateInstallerGateway(context),
                manifestUrl = UpdateManifest.manifestUrlFor(channel),
                appChannel = channel
            )
        }

        fun channelOfThisBuild(): String = UpdateManifest.channelOfThisBuild()

        fun installedVersionCode(context: Context): Long =
            AndroidUpdateInstallerGateway.readInstalledVersionCode(context)

        fun installedVersionName(context: Context): String =
            AndroidUpdateInstallerGateway.readInstalledVersionName(context)

        /**
         * Lectura real del manifiesto por HTTPS.
         *
         * Es una función suelta, no un método, para que `manifestFetcher` tenga
         * un valor por defecto sin depender de una instancia.
         */
        fun fetchManifestOverHttps(url: String): String {
            val connection = (URL(url).openConnection() as HttpsURLConnection).apply {
                connectTimeout = UpdateDownloader.CONNECT_TIMEOUT_MS
                readTimeout = UpdateDownloader.READ_TIMEOUT_MS
            }
            return try {
                if (connection.responseCode != 200) {
                    throw IllegalStateException("El servidor respondio ${connection.responseCode}")
                }
                connection.inputStream.bufferedReader().use { reader -> reader.readText() }
            } finally {
                runCatching { connection.disconnect() }
            }
        }
    }
}
