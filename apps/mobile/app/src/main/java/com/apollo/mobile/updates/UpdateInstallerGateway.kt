package com.apollo.mobile.updates

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.os.Build
import androidx.core.content.FileProvider
import java.io.File

/**
 * FASE 3.5 — la frontera con Android.
 *
 * El resto del actualizador no debería necesitar un `Context` para funcionar:
 * descargar, verificar y decidir son lógica pura. Sólo DOS cosas tocan el
 * framework —abrir el instalador y leer la versión instalada— y por eso están
 * detrás de esta interfaz.
 *
 * La app usa [AndroidUpdateInstallerGateway]. Los tests usan una doble propia,
 * y así se pueden ejercitar de verdad los caminos de permiso, cancelación y
 * regreso, que antes no había forma de probar sin un dispositivo.
 */
interface UpdateInstallerGateway {

    /** Dónde se guardan las descargas. */
    val cacheDirectory: File

    /** Si el sistema autoriza a esta app a lanzar el instalador. */
    fun canRequestInstall(): Boolean

    /** Abre el instalador del sistema para un APK ya verificado. */
    fun openInstaller(apk: UpdateDownloader.VerifiedApk): UpdateDownloader.InstallerLaunch

    /** `versionCode` realmente instalado ahora mismo. */
    fun installedVersionCode(): Long

    /** `versionName` realmente instalado ahora mismo. */
    fun installedVersionName(): String
}

/**
 * Implementación real sobre Android.
 *
 * `openInstaller` comparte el APK con una URI de `FileProvider`, nunca con
 * `file://`: una ruta privada de la app no se expone por fuera y el instalador
 * la rechazaría igual.
 */
class AndroidUpdateInstallerGateway(private val context: Context) : UpdateInstallerGateway {

    override val cacheDirectory: File get() = context.cacheDir

    override fun canRequestInstall(): Boolean = UpdateDownloader.canRequestInstall(context)

    override fun openInstaller(apk: UpdateDownloader.VerifiedApk): UpdateDownloader.InstallerLaunch =
        UpdateDownloader.openInstaller(context, apk)

    override fun installedVersionCode(): Long = readInstalledVersionCode(context)

    override fun installedVersionName(): String = readInstalledVersionName(context)

    companion object {
        /**
         * `versionCode` instalado, compatible con `minSdk 25`.
         *
         * FASE 3.5: `longVersionCode` es API 28+. El proyecto declara `minSdk
         * 25`, así que en Android 7.x y 8.0 esa llamada lanzaba
         * `NoSuchMethodError` y el valor quedaba en 0 para siempre: cualquier
         * `minClientVersionCode` del manifiesto rechazaba a todos esos teléfonos.
         */
        fun readInstalledVersionCode(context: Context): Long {
            return runCatching {
                val info: PackageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    info.longVersionCode
                } else {
                    @Suppress("DEPRECATION")
                    info.versionCode.toLong()
                }
            }.getOrElse { 0L }
        }

        fun readInstalledVersionName(context: Context): String {
            return runCatching {
                context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "?"
            }.getOrElse { "?" }
        }
    }
}
