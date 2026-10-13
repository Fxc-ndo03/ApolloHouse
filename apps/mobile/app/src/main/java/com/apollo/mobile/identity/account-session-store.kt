package com.apollo.mobile.identity

import android.content.Context
import android.content.SharedPreferences
import com.apollo.mobile.transport.CredentialCipher
import com.apollo.mobile.transport.KeystoreCredentialCipher

/**
 * Sesión de CUENTA (no credencial de dispositivo).
 *
 * El token de sesión es un secreto: vive cifrado con la misma clave Keystore
 * que la credencial enrolada. El `accountId` no es secreto (lo muestra la UI)
 * y vive en preferencias privadas junto al deviceId.
 *
 * Logout = borrar token + accountId locales. NO toca la cuenta del servidor,
 * NO toca la credencial del dispositivo y NO toca otros dispositivos.
 */
class AccountSessionStore(
    context: Context,
    private val cipher: CredentialCipher = KeystoreCredentialCipher(),
) {

    private val preferences: SharedPreferences =
        context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun readSessionToken(): String? {
        val stored = preferences.getString(SESSION_TOKEN_KEY, null) ?: return null
        return runCatching { cipher.decrypt(stored) }.getOrNull()
    }

    fun writeSession(accountId: String, sessionToken: String) {
        preferences.edit()
            .putString(SESSION_TOKEN_KEY, cipher.encrypt(sessionToken))
            .putString(ACCOUNT_ID_KEY, accountId)
            .apply()
    }

    fun readAccountId(): String? = preferences.getString(ACCOUNT_ID_KEY, null)

    fun hasSession(): Boolean = readSessionToken() != null

    /** Cambio de usuario / logout: cero trazas de la sesión anterior. */
    fun clearSession() {
        preferences.edit().remove(SESSION_TOKEN_KEY).remove(ACCOUNT_ID_KEY).apply()
    }

    private companion object {
        const val PREFERENCES_NAME = "apollo_mobile_account"
        const val SESSION_TOKEN_KEY = "session_token"
        const val ACCOUNT_ID_KEY = "account_id"
    }
}
