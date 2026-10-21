package com.apollo.mobile.bridge

import com.apollo.mobile.identity.AccountAuthClient
import com.apollo.mobile.identity.AccountAuthOutcome
import com.apollo.mobile.identity.AccountSessionPersistence
import com.apollo.mobile.identity.AccountSessionValidation

/** Routes account auth through the existing client and native encrypted store. */
class BridgeAuthHandler(
    private val accountAuthClient: AccountAuthClient,
    private val accountSessionStore: AccountSessionPersistence,
    private val nowMillisecondsPort: () -> Long = { System.currentTimeMillis() },
    private val onSessionAuthenticated: (accountId: String, sessionToken: String) -> Unit = { _, _ -> },
    private val onSessionCleared: () -> Unit = {},
) {

    fun handle(operation: String, arguments: Map<String, Any?>): BridgeResponse =
        when (operation) {
            "auth.register" -> handleAuthentication(arguments, isRegistration = true)
            "auth.login" -> handleAuthentication(arguments, isRegistration = false)
            "auth.logout" -> handleLogout()
            "auth.state" -> handleState()
            "auth.verify" -> handleVerify()
            else -> BridgeValidator.error(null, BridgeError.UNSUPPORTED_OPERATION)
        }

    private fun handleAuthentication(
        arguments: Map<String, Any?>,
        isRegistration: Boolean,
    ): BridgeResponse {
        val email = (arguments["email"] as? String)?.trim()?.lowercase()
            ?.takeIf { it.isNotBlank() }
            ?: return BridgeValidator.error(null, BridgeError.INVALID_ARGUMENTS)
        val password = arguments["password"] as? String
            ?: return BridgeValidator.error(null, BridgeError.INVALID_ARGUMENTS)

        val outcome = runCatching {
            if (isRegistration) accountAuthClient.register(email, password)
            else accountAuthClient.login(email, password)
        }.getOrElse { return BridgeValidator.error(null, BridgeError.UNAVAILABLE) }

        return when (outcome) {
            is AccountAuthOutcome.Authenticated -> {
                if (outcome.accountId.isBlank() || outcome.sessionToken.isBlank() ||
                    outcome.expiresAtMilliseconds <= nowMillisecondsPort()
                ) {
                    return BridgeValidator.error(null, BridgeError.UNAVAILABLE)
                }
                val persisted = runCatching {
                    accountSessionStore.writeSession(
                        accountId = outcome.accountId,
                        sessionToken = outcome.sessionToken,
                        email = email,
                        expiresAtMilliseconds = outcome.expiresAtMilliseconds,
                    )
                }.getOrDefault(false)
                if (!persisted) {
                    clearLocalSession()
                    return BridgeValidator.error(null, BridgeError.INTERNAL_ERROR)
                }

                // The token stays native: this callback starts the native socket and
                // only accountId is returned to JavaScript.
                runCatching { onSessionAuthenticated(outcome.accountId, outcome.sessionToken) }
                BridgeValidator.ok(null, mapOf("accountId" to outcome.accountId))
            }
            is AccountAuthOutcome.Rejected -> BridgeValidator.error(null, mapAuthError(outcome.reason))
        }
    }

    private fun handleState(): BridgeResponse {
        val sessionToken = accountSessionStore.readSessionToken()
        val accountId = accountSessionStore.readAccountId()
        val email = accountSessionStore.readEmail()
        if (sessionToken.isNullOrBlank() || accountId.isNullOrBlank() || email.isBlank()) {
            // Also stops a socket if readSessionToken() just expired and cleared
            // the persisted value before this handler could observe it.
            clearLocalSession()
            return signedOutState()
        }

        return when (val validation = validateStoredSession(sessionToken, accountId)) {
            is AccountSessionValidation.Authenticated -> {
                runCatching { onSessionAuthenticated(accountId, sessionToken) }
                BridgeValidator.ok(
                    null,
                    mapOf("signedIn" to true, "accountId" to accountId, "email" to email),
                )
            }
            AccountSessionValidation.Invalid -> {
                clearLocalSession()
                signedOutState()
            }
            AccountSessionValidation.Unavailable -> BridgeValidator.error(null, BridgeError.UNAVAILABLE)
        }
    }

    private fun handleVerify(): BridgeResponse {
        val sessionToken = accountSessionStore.readSessionToken()
        val accountId = accountSessionStore.readAccountId()
        if (sessionToken.isNullOrBlank() || accountId.isNullOrBlank()) {
            clearLocalSession()
            return BridgeValidator.ok(null, mapOf("valid" to false))
        }

        return when (validateStoredSession(sessionToken, accountId)) {
            is AccountSessionValidation.Authenticated -> {
                runCatching { onSessionAuthenticated(accountId, sessionToken) }
                BridgeValidator.ok(null, mapOf("valid" to true))
            }
            AccountSessionValidation.Invalid -> {
                clearLocalSession()
                BridgeValidator.ok(null, mapOf("valid" to false))
            }
            AccountSessionValidation.Unavailable -> BridgeValidator.error(null, BridgeError.UNAVAILABLE)
        }
    }

    private fun validateStoredSession(
        sessionToken: String,
        expectedAccountId: String,
    ): AccountSessionValidation = when (val validation = accountAuthClient.validateSession(sessionToken)) {
        is AccountSessionValidation.Authenticated ->
            if (validation.accountId == expectedAccountId) validation else AccountSessionValidation.Invalid
        AccountSessionValidation.Invalid -> AccountSessionValidation.Invalid
        AccountSessionValidation.Unavailable -> AccountSessionValidation.Unavailable
    }

    private fun handleLogout(): BridgeResponse {
        val sessionToken = accountSessionStore.readSessionToken()
        if (!clearLocalSession()) return BridgeValidator.error(null, BridgeError.INTERNAL_ERROR)
        if (sessionToken.isNullOrBlank()) return BridgeValidator.ok(null)

        val remotelyRevoked = runCatching { accountAuthClient.logout(sessionToken) }.getOrDefault(false)
        return if (remotelyRevoked) BridgeValidator.ok(null)
        else BridgeValidator.error(null, BridgeError.UNAVAILABLE)
    }

    private fun clearLocalSession(): Boolean {
        val cleared = runCatching { accountSessionStore.clearSession() }.getOrDefault(false)
        runCatching { onSessionCleared() }
        return cleared
    }

    private fun signedOutState(): BridgeResponse =
        BridgeValidator.ok(null, mapOf("signedIn" to false))

    private fun mapAuthError(reason: String): String = when (reason) {
        AccountAuthClient.REASON_INVALID_CREDENTIALS -> BridgeError.INVALID_CREDENTIALS
        AccountAuthClient.REASON_EMAIL_TAKEN -> BridgeError.EMAIL_TAKEN
        AccountAuthClient.REASON_INVALID_INPUT -> BridgeError.INVALID_INPUT
        else -> BridgeError.UNAVAILABLE
    }
}
