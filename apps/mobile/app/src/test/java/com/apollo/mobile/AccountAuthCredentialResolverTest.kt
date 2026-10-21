package com.apollo.mobile

import com.apollo.mobile.transport.DeviceCredential
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * La precedencia de credenciales es una regla de seguridad, no una preferencia:
 * una credencial enrolada gana siempre y nunca se degrada al secreto global.
 */
class AccountAuthCredentialResolverTest {

    @Test
    fun unaCredencialEnroladaGanaSobreLaSesionDeCuenta() {
        val resolved = AccountAuthCredentialResolver.resolveForAccount(
            accountId = "acc_abc",
            sessionToken = "token-de-cuenta",
            enrolledCredential = "credencial-enrolada",
        )
        assertEquals(DeviceCredential.Enrolled("credencial-enrolada"), resolved)
    }

    @Test
    fun sinEnrolamientoUsaLaSesionDeCuenta() {
        val resolved = AccountAuthCredentialResolver.resolveForAccount(
            accountId = "acc_abc",
            sessionToken = "token-de-cuenta",
            enrolledCredential = null,
        )
        assertEquals(
            DeviceCredential.AccountSession("acc_abc", "token-de-cuenta"),
            resolved,
        )
    }

    @Test
    fun unaCredencialEnroladaVaciaCuentaComoNoEnrolada() {
        val resolved = AccountAuthCredentialResolver.resolveForAccount(
            accountId = "acc_abc",
            sessionToken = "token-de-cuenta",
            enrolledCredential = "   ",
        )
        assertEquals(
            DeviceCredential.AccountSession("acc_abc", "token-de-cuenta"),
            resolved,
        )
    }
}
