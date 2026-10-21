package com.apollo.mobile.updates

/**
 * FASE 3.1 — manifiesto de actualización de Apollo para Android.
 *
 * Es el MISMO formato que consume el actualizador de escritorio (`latest.json`),
 * para que un solo artefacto publicado sirva a los dos clientes y no haya dos
 * fuentes de verdad que se puedan desincronizar.
 *
 * Android NO permite instalación silenciosa en un teléfono normal: este objeto
 * sólo describe QUÉ hay disponible. La instalación la confirma la persona a
 * través del instalador del sistema.
 *
 * Honestidad criptográfica: el SHA-256 de acá verifica INTEGRIDAD (que el
 * archivo no se corrompió en tránsito). La AUTENTICIDAD la da la firma del
 * artefacto: Android la comprueba el propio sistema al instalar, y exige que
 * el APK esté firmado con el MISMO certificado que la app instalada.
 *
 * `minSigningCertificateSha256` es INFORMATIVO y hoy no se verifica: el
 * generador no lo publica, así que siempre llega `null`. No se simula ninguna
 * comprobación de certificado: la única que vale es la del sistema al instalar.
 */
import com.apollo.mobile.BuildConfig
import org.json.JSONObject

data class UpdateManifest(
    val versionName: String,
    val versionCode: Long,
    val channel: String,
    val notes: String,
    val publishedAt: String,
    val apkUrl: String,
    val sizeBytes: Long,
    val sha256: String,
    val minSdkInt: Int,
    val minClientVersionCode: Long,
    val minSigningCertificateSha256: String?
) {
    companion object {
        const val SCHEMA_VERSION = 1
        const val CHANNEL_STABLE = "stable"
        const val CHANNEL_STAGING = "staging"

        /**
         * Canal de ESTA build.
         *
         * FASE 3.5: sale de `BuildConfig.UPDATE_CHANNEL`, que el flavor fija de
         * forma explícita. Antes se deducía buscando la palabra "staging" dentro
         * de la URL del Worker: con un host mal escrito o vacío, el canal
         * cambiaba en silencio y una build de pruebas podía pedir el manifiesto
         * de producción. Acá no hay nada que interpretar.
         *
         * Cualquier valor que no sea uno de los dos canales se trata como
         * `stable`, que es el destino conservador: ante la duda, el canal de
         * producción, cuya actualización exige la firma de producción.
         */
        fun channelOfThisBuild(): String = when (BuildConfig.UPDATE_CHANNEL) {
            CHANNEL_STAGING -> CHANNEL_STAGING
            CHANNEL_STABLE -> CHANNEL_STABLE
            else -> CHANNEL_STABLE
        }

        /**
         * Endpoint del manifiesto de este canal.
         *
         * FASE 3.5: son las MISMAS direcciones que usa el pipeline de
         * publicación, escritas una sola vez. Son URLs públicas de releases de
         * GitHub: no son secretos.
         */
        fun manifestUrlFor(channel: String): String = when (channel) {
            CHANNEL_STAGING -> "https://github.com/Fxc-ndo03/ApolloHouse/releases/download/staging/android.json"
            else -> "https://github.com/Fxc-ndo03/ApolloHouse/releases/latest/download/android.json"
        }

        /**
         * Lee el manifiesto y devuelve `null` si está incompleto o mal formado.
         *
         * Se valida TODO lo que se puede validar sin red: un manifiesto a medias
         * es peor que no tener ninguno, porque haría offering una instalación
         * que va a fallar.
         */
        fun parse(jsonText: String): UpdateManifest? {
            val json = runCatching { JSONObject(jsonText) }.getOrNull() ?: return null
            val versionName = json.optString("version").takeIf { it.isNotBlank() } ?: return null
            val versionCode = json.optLong("versionCode", 0L)
            if (versionCode <= 0L) return null
            val channel = json.optString("channel").takeIf { it.isNotBlank() } ?: return null
            if (channel != CHANNEL_STABLE && channel != CHANNEL_STAGING) return null
            val apkUrl = json.optString("apkUrl").takeIf { it.isNotBlank() } ?: return null
            if (!apkUrl.startsWith("https://")) return null
            val sizeBytes = json.optLong("sizeBytes", 0L)
            if (sizeBytes <= 0L) return null
            val sha256 = json.optString("sha256").takeIf { it.isNotBlank() } ?: return null
            if (!sha256.matches(HEX_64)) return null
            return UpdateManifest(
                versionName = versionName,
                versionCode = versionCode,
                channel = channel,
                notes = json.optString("notes"),
                publishedAt = json.optString("publishedAt"),
                apkUrl = apkUrl,
                sizeBytes = sizeBytes,
                sha256 = sha256.lowercase(),
                // El generador publica `minSdkInt`; se acepta también `minSdk`
                // por manifiestos ya publicados. Antes sólo se leía `minSdk`, así
                // que la compatibilidad con el teléfono nunca llegaba desde el
                // manifiesto y siempre valía el 25 por defecto.
                minSdkInt = when {
                    json.has("minSdkInt") -> json.optInt("minSdkInt", 33)
                    json.has("minSdk") -> json.optInt("minSdk", 33)
                    else -> 33
                },
                minClientVersionCode = json.optLong("minClientVersionCode", 0L),
                minSigningCertificateSha256 = json
                    .optString("minSigningCertificateSha256")
                    .takeIf { it.isNotBlank() }
            )
        }

        private val HEX_64 = Regex("^[0-9a-fA-F]{64}$")
    }
}

/**
 * Por qué no se ofrece una actualización.
 *
 * El caso importante es [CanalDistinto]: es lo que impide que la app normal
 * instale una build de pruebas, y viceversa, aunque alguien apunte el
 * manifiesto equivocado.
 */
sealed class UpdateRejection(val message: String) {
    object NoDisponible : UpdateRejection("Apollo esta al dia")
    data class CanalDistinto(val esperado: String, val recibido: String) :
        UpdateRejection("El manifiesto es del canal $recibido y esta app es $esperado")

    data class NoEsMasNueva(val instalada: Long, val publicada: Long) :
        UpdateRejection("La version publicada no es mas nueva que la instalada")

    data class ClienteAntiguo(val minimo: Long, val actual: Long) :
        UpdateRejection("Esta app es anterior al minimo requerido: actualiza a mano")

    data class IncompatibleConElDispositivo(val minSdk: Int, val sdkDelDispositivo: Int) :
        UpdateRejection("El APK requiere Android $minSdk y este dispositivo es $sdkDelDispositivo")

    data class DescargaInvalida(val motivo: String) : UpdateRejection(motivo)
}

/** Lo que hay que hacer, ya validado. */
data class UpdateDecision(
    val manifest: UpdateManifest,
    val shouldInstall: Boolean
)

object UpdateEvaluator {

    /**
     * Decide si esta app debe instalar el artefacto del manifiesto.
     *
     * Reglas, en orden de importancia:
     *  1. Mismo canal. Sin esto nada más importa.
     *  2. `versionCode` estrictamente mayor (es lo que Android acepta).
     *  3. Este APK es compatible con el `minSdkInt` del teléfono.
     *  4. Esta app es al menos el `minClientVersionCode` del manifiesto.
     */
    fun evaluate(
        installedVersionCode: Long,
        deviceSdkInt: Int,
        appChannel: String,
        manifest: UpdateManifest
    ): UpdateDecision {
        val rejection = findRejection(installedVersionCode, deviceSdkInt, appChannel, manifest)
        return UpdateDecision(manifest, shouldInstall = rejection == null)
    }

    fun findRejection(
        installedVersionCode: Long,
        deviceSdkInt: Int,
        appChannel: String,
        manifest: UpdateManifest
    ): UpdateRejection? {
        if (!manifest.channel.equals(appChannel, ignoreCase = true)) {
            return UpdateRejection.CanalDistinto(appChannel, manifest.channel)
        }
        if (manifest.versionCode <= installedVersionCode) {
            return UpdateRejection.NoEsMasNueva(installedVersionCode, manifest.versionCode)
        }
        if (deviceSdkInt < manifest.minSdkInt) {
            return UpdateRejection.IncompatibleConElDispositivo(manifest.minSdkInt, deviceSdkInt)
        }
        if (installedVersionCode < manifest.minClientVersionCode) {
            return UpdateRejection.ClienteAntiguo(manifest.minClientVersionCode, installedVersionCode)
        }
        return null
    }
}
