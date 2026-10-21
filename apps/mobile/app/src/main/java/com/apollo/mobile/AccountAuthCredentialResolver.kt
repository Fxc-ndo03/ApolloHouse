package com.apollo.mobile

import com.apollo.mobile.transport.DeviceCredential

/**
 * Regla unica de credencial del cliente movil.
 *
 * Antes cada Activity resolvia la credencial por su cuenta y `DeviceActivity`
 * ya lo hacia con una precedencia propia. Dos copias de la misma regla son dos
 * reglas: con el tiempo divergen y aparece un fallo que solo se ve en un camino.
 *
 * La precedencia NO es negociable: una credencial enrolada gana siempre y nunca
 * se degrada al secreto global, porque degradarse seria el bypass (un telefono
 * revocado podria volver por `?token=`).
 */
object AccountAuthCredentialResolver {

    fun resolveForAccount(
        accountId: String,
        sessionToken: String,
        enrolledCredential: String?,
    ): DeviceCredential {
        val resolvedEnrolledCredential = enrolledCredential?.takeIf { it.isNotBlank() }
        if (resolvedEnrolledCredential != null) {
            return DeviceCredential.Enrolled(resolvedEnrolledCredential)
        }
        return DeviceCredential.AccountSession(
            accountId = accountId,
            sessionToken = sessionToken,
        )
    }
}
