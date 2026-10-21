package com.apollo.mobile.identity

import android.content.Context
import android.content.SharedPreferences
import com.apollo.mobile.transport.CredentialCipher
import com.apollo.mobile.transport.KeystoreCredentialCipher

/** Native-only persistence boundary used by the WebView bridge and unit fakes. */
interface AccountSessionPersistence {
    fun readSessionToken(): String?
    fun readAccountId(): String?
    fun readEmail(): String
    fun hasSession(): Boolean
    fun writeSession(
        accountId: String,
        sessionToken: String,
        email: String = "",
        expiresAtMilliseconds: Long? = null,
    ): Boolean
    fun clearSession(): Boolean
}

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
    private val nowMillisecondsPort: () -> Long = { System.currentTimeMillis() },
) : AccountSessionPersistence {

    private val preferences: SharedPreferences =
        context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun readSessionToken(): String? {
        val stored = preferences.getString(SESSION_TOKEN_KEY, null) ?: return null
        val expiresAt = preferences.getLong(SESSION_EXPIRY_KEY, 0L)
        if (expiresAt > 0L && nowMillisecondsPort() >= expiresAt) {
            clearSession()
            return null
        }
        val token = runCatching { cipher.decrypt(stored) }.getOrNull()
            ?.takeIf { it.isNotBlank() }
        if (token == null) clearSession()
        return token
    }

    override fun writeSession(
        accountId: String,
        sessionToken: String,
        email: String,
        expiresAtMilliseconds: Long?,
    ): Boolean {
        if (accountId.isBlank() || sessionToken.isBlank() ||
            (expiresAtMilliseconds != null && expiresAtMilliseconds <= nowMillisecondsPort())
        ) {
            clearSession()
            return false
        }

        val encryptedToken = runCatching { cipher.encrypt(sessionToken) }.getOrNull()
            ?.takeIf { it.isNotBlank() }
        if (encryptedToken == null) {
            clearSession()
            return false
        }

        val editor = preferences.edit()
            .remove(SESSION_TOKEN_KEY)
            .remove(ACCOUNT_ID_KEY)
            .remove(EMAIL_KEY)
            .remove(SESSION_EXPIRY_KEY)
            .putString(SESSION_TOKEN_KEY, encryptedToken)
            .putString(ACCOUNT_ID_KEY, accountId)
        if (email.isNotBlank()) editor.putString(EMAIL_KEY, email.trim().lowercase())
        if (expiresAtMilliseconds != null) editor.putLong(SESSION_EXPIRY_KEY, expiresAtMilliseconds)

        val committed = runCatching { editor.commit() }.getOrDefault(false)
        if (!committed) clearSession()
        return committed
    }

    override fun readAccountId(): String? = preferences.getString(ACCOUNT_ID_KEY, null)

    override fun readEmail(): String = preferences.getString(EMAIL_KEY, "").orEmpty()

    override fun hasSession(): Boolean {
        val token = readSessionToken()
        if (token == null) return false
        if (readAccountId().isNullOrBlank()) {
            clearSession()
            return false
        }
        return true
    }

    /** Cambio de usuario / logout: cero trazas de la sesión anterior. */
    override fun clearSession(): Boolean = runCatching {
        preferences.edit()
            .remove(SESSION_TOKEN_KEY)
            .remove(ACCOUNT_ID_KEY)
            .remove(EMAIL_KEY)
            .remove(SESSION_EXPIRY_KEY)
            .commit()
    }.getOrDefault(false)

    private companion object {
        const val PREFERENCES_NAME = "apollo_mobile_account"
        const val SESSION_TOKEN_KEY = "session_token"
        const val ACCOUNT_ID_KEY = "account_id"
        const val EMAIL_KEY = "account_email"
        const val SESSION_EXPIRY_KEY = "session_expires_at"
    }
}
