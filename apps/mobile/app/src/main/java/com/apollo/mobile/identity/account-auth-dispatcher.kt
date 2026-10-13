package com.apollo.mobile.identity

import java.util.concurrent.Executor

/**
 * Ejecuta login/registro/logout fuera del hilo principal y entrega el
 * resultado en el hilo principal (mismo patrón que EnrollmentClaimDispatcher).
 */
class AccountAuthDispatcher(
    private val backgroundExecutor: Executor,
    private val mainThreadPoster: ((() -> Unit) -> Unit),
) {

    fun authenticate(
        client: AccountAuthClient,
        email: String,
        password: String,
        isRegistration: Boolean,
        onResult: (AccountAuthOutcome) -> Unit,
    ) {
        try {
            backgroundExecutor.execute {
                val outcome = try {
                    if (isRegistration) client.register(email, password) else client.login(email, password)
                } catch (unexpected: Exception) {
                    AccountAuthOutcome.Rejected(AccountAuthClient.REASON_RESPONSE_INVALID)
                }
                mainThreadPoster { onResult(outcome) }
            }
        } catch (rejected: Exception) {
            mainThreadPoster { onResult(AccountAuthOutcome.Rejected(AccountAuthClient.REASON_RESPONSE_INVALID)) }
        }
    }

    fun logout(
        client: AccountAuthClient,
        sessionToken: String,
        onResult: (Boolean) -> Unit,
    ) {
        try {
            backgroundExecutor.execute {
                val revoked = try {
                    client.logout(sessionToken)
                } catch (unexpected: Exception) {
                    false
                }
                mainThreadPoster { onResult(revoked) }
            }
        } catch (rejected: Exception) {
            mainThreadPoster { onResult(false) }
        }
    }
}
