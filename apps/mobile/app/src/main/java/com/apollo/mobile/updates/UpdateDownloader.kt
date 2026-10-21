package com.apollo.mobile.updates

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.URL
import java.security.MessageDigest
import javax.net.ssl.HttpsURLConnection

/**
 * FASE 3.1 / 3.5 — descarga e instalación de la actualización de Apollo.
 *
 * Lo que SÍ se automatiza: comprobar el manifiesto, comparar versiones,
 * descargar en segundo plano con progreso, verificar tamaño y SHA-256, y abrir
 * el instalador del sistema.
 *
 * Lo que NO se intenta: instalar en silencio. En un teléfono normal Android
 * exige confirmación de la persona. Cuando falta el permiso
 * `REQUEST_INSTALL_PACKAGES`, se explica cómo habilitarlo en lugar de
 * saltárselo.
 */
object UpdateDownloader {

    const val CONNECT_TIMEOUT_MS = 15_000
    const val READ_TIMEOUT_MS = 30_000
    /** Tope de seguridad: un APK de más de esto no es una actualización de Apollo. */
    const val MAX_APK_BYTES = 512L * 1024 * 1024

    private const val HTTP_OK = 200
    private const val DOWNLOAD_DIRECTORY_NAME = "updates"
    private const val TEMPORARY_SUFFIX = ".parcial"

    /**
     * Un APK verificado, con TODA su identidad.
     *
     * FASE 3.5 — el hallazgo A2 era que la descarga devolvía sólo el archivo y
     * luego el instalador buscaba "el APK más reciente" por fecha. Con dos
     * versiones en caché eso podía abrir un APK distinto del que el manifiesto
     * autorizó. Ahora el resultado lleva el archivo exacto, su tamaño y el
     * `versionCode` del manifiesto que lo autorizó, y esa identidad es la que se
     * revalida antes de instalar.
     */
    data class VerifiedApk(
        val file: File,
        val manifest: UpdateManifest
    ) {
        val versionCode: Long get() = manifest.versionCode
        val versionName: String get() = manifest.versionName
    }

    sealed class Result {
        data class Listo(val apk: VerifiedApk) : Result()
        object SinPermisoDeInstalacion : Result()
        data class Fallo(val motivo: String, val recuperable: Boolean) : Result()
    }

    /** Un APK abierto para leer, con el tamaño que declara el servidor. */
    data class ApkStream(val stream: InputStream, val declaredLength: Long)

    /**
     * De dónde sale el APK.
     *
     * FASE 3.5: la red es una frontera inyectable. La app usa [HttpsApkSource];
     * los tests usan una fuente local, y así el resto del flujo —tamaño, hash,
     * rename, revalidación— se ejercita de verdad sin internet ni releases.
     */
    interface ApkSource {
        // `kotlin.Result` explícito: dentro de este `object` el nombre `Result`
        // lo ocupa el `sealed class` de arriba y sin calificar no resuelve.
        fun open(url: String): kotlin.Result<ApkStream>
    }

    /** Fuente real: HTTPS con timeout y códigos de estado tratados. */
    object HttpsApkSource : ApkSource {
        override fun open(url: String): kotlin.Result<ApkStream> {
            if (!url.startsWith("https://")) {
                return kotlin.Result.failure(IllegalStateException("El enlace de descarga no es HTTPS"))
            }
            val connection = (URL(url).openConnection() as HttpsURLConnection).apply {
                connectTimeout = UpdateDownloader.CONNECT_TIMEOUT_MS
                readTimeout = UpdateDownloader.READ_TIMEOUT_MS
                requestMethod = "GET"
                instanceFollowRedirects = true
            }
            return runCatching {
                val status = connection.responseCode
                if (status != HTTP_OK) {
                    throw HttpStatusException(status)
                }
                if (connection.contentLengthLong > UpdateDownloader.MAX_APK_BYTES) {
                    throw PackageTooLargeException()
                }
                ApkStream(connection.inputStream, connection.contentLengthLong)
            }.fold(
                onSuccess = { kotlin.Result.success(it) },
                onFailure = { error ->
                    if (error is HttpStatusException) {
                        kotlin.Result.failure(HttpStatusException(error.statusCode))
                    } else {
                        kotlin.Result.failure(
                            IllegalStateException("No se pudo abrir la conexion de descarga")
                        )
                    }
                }
            )
        }
    }

    class HttpStatusException(val statusCode: Int) : Exception()
    class PackageTooLargeException : Exception()

    /**
     * Descarga el APK verificando tamaño y hash.
     *
     * El archivo se escribe con extensión `.parcial` y recién se renombra al
     * terminar: un APK a medio descargar jamás queda con el nombre final, así
     * que no puede ser tomado por listo. Si algo falla, el parcial se borra y se
     * limpia cualquier APK verificado de esa misma versión que hubiera quedado
     * de un intento anterior, para que un reintento no reutilice basura.
     */
    fun download(
        cacheDirectory: File,
        manifest: UpdateManifest,
        onProgress: (bytesRead: Long, totalBytes: Long) -> Unit = { _, _ -> },
        source: ApkSource = HttpsApkSource
    ): Result {
        val targetDirectory = File(cacheDirectory, DOWNLOAD_DIRECTORY_NAME).apply { mkdirs() }
        val targetFile = File(targetDirectory, fileNameFor(manifest))
        val temporaryFile = File(targetDirectory, fileNameFor(manifest) + TEMPORARY_SUFFIX)
        targetFile.delete()
        temporaryFile.delete()

        val opened = source.open(manifest.apkUrl)
        val apkStream = opened.getOrElse { error ->
            val motivo = error.message ?: "No se pudo abrir la conexion de descarga"
            // Un 4xx no se reintenta; un 5xx o un fallo de red, sí.
            val recuperable = !(error is HttpStatusException && error.statusCode in 400..499)
            return Result.Fallo(motivo, recuperable)
        }
        val stream = apkStream.stream

        return try {
            val digest = MessageDigest.getInstance("SHA-256")
            val copy = stream.use { input ->
                FileOutputStream(temporaryFile).use { output ->
                    copyAndDigest(input, output, manifest, onProgress)
                }
            }

            when (copy) {
                is CopyResult.ExcedeTamano -> {
                    temporaryFile.delete()
                    return Result.Fallo("La descarga excede el tamano permitido", false)
                }
                is CopyResult.Fallo -> {
                    temporaryFile.delete()
                    return Result.Fallo("La descarga se interrumpio: ${copy.motivo}", true)
                }
                is CopyResult.Completo -> {
                    // Tamaño exacto contra el manifiesto. El hash ya no
                    // alcanza: un archivo truncado tiene un hash distinto y
                    // sería rechazado igual, pero comparar el tamaño dice QUÉ
                    // pasó sin recalcular nada.
                    if (copy.bytesRead != manifest.sizeBytes) {
                        temporaryFile.delete()
                        return Result.Fallo(
                            "La descarga no tiene el tamano esperado (${copy.bytesRead} de ${manifest.sizeBytes})",
                            true
                        )
                    }
                    if (!copy.hash.equals(manifest.sha256, ignoreCase = true)) {
                        temporaryFile.delete()
                        return Result.Fallo("La descarga no coincide con el hash esperado", true)
                    }
                }
            }

            // El rename es el punto de no vuelta: hasta acá el archivo no era
            // instalable. Recién ahora pasa a llamarse como el APK final.
            if (!temporaryFile.renameTo(targetFile)) {
                temporaryFile.delete()
                return Result.Fallo("No se pudo guardar la descarga", true)
            }

            Result.Listo(VerifiedApk(targetFile, manifest))
        } catch (error: Exception) {
            temporaryFile.delete()
            Result.Fallo("La descarga se interrumpio: ${error.message ?: "sin detalle"}", true)
        }
    }

    /** Resultado de copiar el APK: bytes, hash y el motivo si se cortó. */
    private sealed class CopyResult {
        data class Completo(val bytesRead: Long, val hash: String) : CopyResult()
        data class ExcedeTamano(val bytesRead: Long) : CopyResult()
        data class Fallo(val motivo: String) : CopyResult()
    }

    /**
     * Copia en bloques, calculando el hash en el mismo passage.
     *
     * Devuelve el total en vez de dejar un contador compartido: `UpdateDownloader`
     * es un `object` y dos descargas simultáneas se pisarían entre sí.
     *
     * Nunca se lee el APK entero en memoria: son decenas de megabytes.
     */
    private fun copyAndDigest(
        input: InputStream,
        output: FileOutputStream,
        manifest: UpdateManifest,
        onProgress: (Long, Long) -> Unit
    ): CopyResult {
        return try {
            val digest = MessageDigest.getInstance("SHA-256")
            var bytesRead = 0L
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                bytesRead += read
                if (bytesRead > MAX_APK_BYTES || bytesRead > manifest.sizeBytes) {
                    return CopyResult.ExcedeTamano(bytesRead)
                }
                output.write(buffer, 0, read)
                digest.update(buffer, 0, read)
                onProgress(bytesRead, manifest.sizeBytes)
            }
            CopyResult.Completo(bytesRead, digest.digest().toHexString())
        } catch (error: Exception) {
            CopyResult.Fallo(error.message ?: "sin detalle")
        }
    }

    /**
     * Revalida un APK ya descargado ANTES de abrir el instalador.
     *
     * FASE 3.5: entre descargar e instalar pueden pasar minutos (el usuario
     * puede leer las notas, abrir ajustes, cancelar). El archivo o el manifiesto
     * pudieron cambiar en ese medio tiempo, así que se comprueba de nuevo contra
     * el mismo manifiesto que autorizó la descarga. Devuelve `null` cuando algo
     * no cuadra, y el llamador aborta.
     */
    fun reverifyBeforeInstall(apk: VerifiedApk): String? {
        if (!apk.file.exists()) return "El archivo descargado ya no esta"
        if (apk.file.length() != apk.manifest.sizeBytes) {
            return "El archivo descargado cambio de tamano"
        }
        val hash = sha256Of(apk.file)
        if (!hash.equals(apk.manifest.sha256, ignoreCase = true)) {
            return "El archivo descargado cambio de contenido"
        }
        return null
    }

    /**
     * Borra los APK verificados que no son el indicado.
     *
     * Sin esto, una descarga fallida deja el archivo viejo en caché y un
     * reintento posterior podría acabar instalando una versión obsoleta.
     */
    fun discardOtherDownloads(cacheDirectory: File, keep: File?) {
        val directory = File(cacheDirectory, DOWNLOAD_DIRECTORY_NAME)
        directory.listFiles { file -> file.name.endsWith(".apk") }
            ?.filter { keep == null || it.absolutePath != keep.absolutePath }
            ?.forEach { file -> file.delete() }
    }

    /** Todos los APK presentes en caché, para poder afirmar sobre ellos. */
    fun cachedApks(cacheDirectory: File): List<File> =
        File(cacheDirectory, DOWNLOAD_DIRECTORY_NAME)
            .listFiles { file -> file.name.endsWith(".apk") }
            ?.toList()
            ?: emptyList()

    /** Nombre determinístico: el archivo se llama por su `versionCode`. */
    fun fileNameFor(manifest: UpdateManifest): String = "apollo-${manifest.versionCode}.apk"

    /**
     * Prepara el Intent del instalador del sistema para un APK verificado.
     *
     * FASE 3.5: se separa del `startActivity` para que la `Activity` pueda
     * lanzarlo con `startActivityForResult` y así REALLY recibir el regreso:
     * sin eso no hay forma de distinguir "instaló" de "canceló".
     *
     * El APK se comparte con una URI de `FileProvider`, nunca `file://`: una
     * ruta privada de la app no se expone por fuera y el instalador la
     * rechazaría igual.
     */
    fun buildInstallerIntent(context: Context, apk: VerifiedApk): Intent? {
        if (!apk.file.exists()) return null
        val apkUri = runCatching {
            FileProvider.getUriForFile(context, "${context.packageName}.updateprovider", apk.file)
        }.getOrNull() ?: return null
        return Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(apkUri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    /**
     * Abre el instalador del sistema para el APK verificado.
     *
     * Es el camino sin `Activity` (used desde un servicio o un worker). La
     * `MainActivity` usa [buildInstallerIntent] para poder recibir el regreso.
     */
    fun openInstaller(context: Context, apk: VerifiedApk): InstallerLaunch {
        val intent = buildInstallerIntent(context, apk)
            ?: return InstallerLaunch.Error(
                if (!apk.file.exists()) "El archivo descargado ya no esta"
                else "No se pudo preparar el archivo para el instalador"
            )
        return runCatching {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            InstallerLaunch.Iniciado
        }.getOrElse { InstallerLaunch.Error("Ninguna app puede abrir el instalador") }
    }

    /** Si el teléfono todavía no autoriza a esta app a instalar paquetes. */
    fun canRequestInstall(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        return context.packageManager.canRequestPackageInstalls()
    }

    /** Pantalla del sistema para habilitar "instalar apps desconocidas". */
    fun installPermissionSettingsIntent(context: Context): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
            data = Uri.parse("package:" + context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

    /**
     * SHA-256 de un archivo, leído por bloques.
     *
     * Reutilizado por la verificación previa a instalar: es la misma
     * implementación que usa la descarga, así que no pueden discrepar.
     */
    fun sha256Of(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().toHexString()
    }

    sealed class InstallerLaunch {
        object Iniciado : InstallerLaunch()
        data class Error(val motivo: String) : InstallerLaunch()
    }
}

internal fun ByteArray.toHexString(): String =
    joinToString("") { byte -> "%02x".format(byte) }