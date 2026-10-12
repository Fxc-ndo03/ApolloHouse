package com.apollo.mobile.transport

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Cifrador de la credencial. Es un puerto a proposito: `AndroidKeyStore` no
 * existe en la JVM de los tests unitarios, asi que la sesion y el onboarding se
 * prueban enteros con un cifrador falso. Lo que se prueba en el dispositivo real
 * es el otro lado de la misma interfaz.
 */
interface CredentialCipher {
    fun encrypt(plainText: String): String
    fun decrypt(cipherText: String): String
}

/**
 * BLOCK 12 §3: la credencial individual se guarda cifrada con una clave AES-GCM
 * que vive en el Android Keystore y NUNCA sale de el.
 *
 * Lo que se guarda en las preferencias NO es la credencial: es el ciphertext. La
 * clave se referencia por alias. Asi, un dump de las preferencias del paquete no
 * sirve para autenticarse, ni aunque la app se roote sin el Keystore.
 *
 * API 25: AES/GCM y AndroidKeyStore existen desde API 23, asi que no hace falta
 * la excepcion de API 26 que si hace falta para `NotificationChannel`.
 */
class KeystoreCredentialCipher(
    private val keyAlias: String = DEFAULT_KEY_ALIAS
) : CredentialCipher {

    private fun resolveKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existingKey = keyStore.getKey(keyAlias, null)
        if (existingKey is SecretKey) {
            return existingKey
        }
        val keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            ANDROID_KEYSTORE
        )
        keyGenerator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return keyGenerator.generateKey()
    }

    override fun encrypt(plainText: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, resolveKey())
        val cipherText = cipher.doFinal(plainText.toByteArray(Charsets.UTF_8))
        // El IV va junto al ciphertext: GCM lo necesita para descifrar y no es
        // secreto. Se concatena con "|" y no se escapa, porque base64 no lo usa.
        return listOf(
            Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
            Base64.encodeToString(cipherText, Base64.NO_WRAP)
        ).joinToString(SEPARATOR)
    }

    override fun decrypt(cipherText: String): String {
        val partList = cipherText.split(SEPARATOR)
        check(partList.size == 2) { "el ciphertext guardado no tiene la forma esperada" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            resolveKey(),
            GCMParameterSpec(
                GCM_TAG_LENGTH_BITS,
                Base64.decode(partList[0], Base64.NO_WRAP)
            )
        )
        return String(
            cipher.doFinal(Base64.decode(partList[1], Base64.NO_WRAP)),
            Charsets.UTF_8
        )
    }

    companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val DEFAULT_KEY_ALIAS = "apollo_mobile_enrollment_key"
        const val GCM_TAG_LENGTH_BITS = 128
        const val SEPARATOR = "|"
    }
}

/**
 * BLOCK 12 §2 y §6: donde vive la identidad del telefono.
 *
 * `enrolled_credential` es la credencial individual, CIFRADA. El
 * `device_shared_secret` sigue soportado y es el camino legacy de desarrollo,
 * para no romper el cliente que ya esta instalado.
 *
 * `toString()` no se overridea a proposito: el default de una data class de Kotlin
 * imprime sus campos, asi que si esta clase llegara a un log por interpolacion
 * filtraria el secreto. Los metodos de lectura devuelven el valor, no lo
 * imprimen, y ningun log de esta app los imprime.
 */
class CredentialStore(
    context: Context,
    private val cipher: CredentialCipher = KeystoreCredentialCipher()
) {

    private val preferences: SharedPreferences =
        context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    /** Credencial individual del enrollment, descifrada. Null si no se enroló. */
    fun readEnrolledCredential(): String? = readDecrypted(ENROLLED_CREDENTIAL_KEY)

    fun writeEnrolledCredential(credential: String) {
        preferences.edit()
            .putString(ENROLLED_CREDENTIAL_KEY, cipher.encrypt(credential))
            .apply()
    }

    fun hasEnrolledCredential(): Boolean = readEnrolledCredential() != null

    /**
     * Borra la credencial enrolada. Se usa cuando el servidor la revoca: el
     * telefono no debe quedarse con un valor que ya no sirve, y menos intentar
     * con el.
     */
    fun clearEnrolledCredential() {
        preferences.edit().remove(ENROLLED_CREDENTIAL_KEY).apply()
    }

    /**
     * La credencial con la que conectar, o null si el telefono no tiene ninguna.
     * La resolucion vive en [DeviceCredential.resolve] para que la regla sea una
     * sola y testeable sin Android.
     */
    fun resolveDeviceCredential(): DeviceCredential? = DeviceCredential.resolve(
        readEnrolledCredential(),
        readDeviceSharedSecret()
    )

    // ── Legacy, sin cambios: el camino de desarrollo que ya existía ───────────

    fun readDeviceSharedSecret(): String? =
        preferences.getString(DEVICE_SHARED_SECRET_KEY, null)?.takeIf { it.isNotBlank() }

    fun writeDeviceSharedSecret(deviceSharedSecret: String) {
        preferences.edit().putString(DEVICE_SHARED_SECRET_KEY, deviceSharedSecret).apply()
    }

    fun hasDeviceSharedSecret(): Boolean = readDeviceSharedSecret() != null

    private fun readDecrypted(key: String): String? {
        val cipherText = preferences.getString(key, null) ?: return null
        if (cipherText.isBlank()) {
            return null
        }
        return try {
            cipher.decrypt(cipherText).takeIf { it.isNotBlank() }
        } catch (failedToDecrypt: Exception) {
            // La clave del Keystore pudo rotarse (o el dato corromperse). Un valor
            // que no se puede descifrar es indistinguible de "no hay nada", y
            //不清arlo hace que el telefono vuelva a pedir enrollment en vez de
            // fallar con un error de crypto.
            null
        }
    }

    private companion object {
        const val PREFERENCES_NAME = "apollo_mobile_credentials"
        const val ENROLLED_CREDENTIAL_KEY = "enrolled_credential"
        const val DEVICE_SHARED_SECRET_KEY = "device_shared_secret"
    }
}
