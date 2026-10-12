package com.apollo.mobile

import com.apollo.mobile.contract.Contract
import com.apollo.mobile.identity.EnrollmentClaimClient
import com.apollo.mobile.identity.EnrollmentClaimResult
import com.apollo.mobile.identity.EnrollmentHttpAnswer
import com.apollo.mobile.identity.EnrollmentHttpPort
import com.apollo.mobile.transport.ClientConfig
import com.apollo.mobile.transport.DeviceCredential
import com.apollo.mobile.transport.isLoopbackWorkerHost
import com.apollo.mobile.transport.normalizeWorkerHostInput
import com.apollo.mobile.transport.resolveIsSecureTransport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BLOCK 12.5.2: el transporte local sin debilitar produccion.
 *
 * El bug que estos tests cubren: con el default seguro, escribir
 * `127.0.0.1:8799` en el formulario producia `https://127.0.0.1:8799`, que
 * falla dos veces — Android veta el cleartext en targetSdk 36, y Wrangler local
 * no habla TLS. Y si el usuario pegaba el esquema, la concatenacion daba
 * `https://http://127.0.0.1:8799`.
 */
class LocalTransportTest {

    // ── Normalizacion del host ────────────────────────────────────────────

    @Test
    fun aHostWithPortIsAcceptedAsIs() {
        assertEquals("127.0.0.1:8799", normalizeWorkerHostInput("127.0.0.1:8799"))
    }

    @Test
    fun aHostWrittenWithASchemeIsAcceptedWithoutDuplicatingIt() {
        // Lo que la persona escribe y lo que usa el cliente tienen que coincidir:
        // pegar `http://...` no puede terminar en `https://http://...`.
        for (typed in listOf("http://127.0.0.1:8799", "https://127.0.0.1:8799")) {
            assertEquals("127.0.0.1:8799", normalizeWorkerHostInput(typed))
        }
    }

    @Test
    fun surroundingWhitespaceAndTrailingSlashAreTrimmed() {
        assertEquals("127.0.0.1:8799", normalizeWorkerHostInput("  127.0.0.1:8799/  "))
        assertEquals("apollo.example", normalizeWorkerHostInput("apollo.example/"))
    }

    @Test
    fun anUnusableHostIsRejectedInsteadOfBuiltIntoABrokenUrl() {
        assertNull(normalizeWorkerHostInput(""))
        assertNull(normalizeWorkerHostInput("   "))
        assertNull(normalizeWorkerHostInput("http://"))
        // Una barra en medio significa que no es un host: no se adivina.
        assertNull(normalizeWorkerHostInput("127.0.0.1:8799/enrollment"))
    }

    // ── Seleccion de transporte ───────────────────────────────────────────

    @Test
    fun onlyLoopbackCountsAsLoopback() {
        assertTrue(isLoopbackWorkerHost("127.0.0.1:8799"))
        assertTrue(isLoopbackWorkerHost("localhost"))
        assertTrue(isLoopbackWorkerHost("LOCALHOST:8799"))
        assertTrue(isLoopbackWorkerHost("10.0.2.2"))
        assertFalse(isLoopbackWorkerHost("apollo.example"))
        // Un host que empieza igual no es loopback: es la diferencia entre
        // `127.0.0.1` y `127.0.0.1.attacker.example`.
        assertFalse(isLoopbackWorkerHost("127.0.0.1.attacker.example"))
        assertFalse(isLoopbackWorkerHost("192.168.1.10:8799"))
    }

    @Test
    fun productionHostsAlwaysUseTls() {
        for (productionHost in listOf("apollo.example", "192.168.1.10:8799", "api.apollo.dev")) {
            assertTrue(
                "$productionHost debe usar TLS en release",
                resolveIsSecureTransport(productionHost, isDebugBuild = false)
            )
        }
    }

    @Test
    fun aLoopbackHostDropsToCleartextOnlyInDebug() {
        // Esta es la excepcion, y son las DOS condiciones.
        assertFalse(resolveIsSecureTransport("127.0.0.1:8799", isDebugBuild = true))
        // En release el mismo host vuelve a TLS: la excepcion no se compila.
        assertTrue(resolveIsSecureTransport("127.0.0.1:8799", isDebugBuild = false))
    }

    @Test
    fun debugAloneIsNotEnoughToDropToCleartext() {
        // Si el build de debug bastara, un host de produccion en una build de
        // desarrollo bajaria a http sin querer. La segunda condicion es el host.
        assertTrue(resolveIsSecureTransport("apollo.example", isDebugBuild = true))
    }

    @Test
    fun theDefaultOfClientConfigIsSecure() {
        // Un `ClientConfig` recien creado, sin decir nada, va con TLS.
        val clientConfig = ClientConfig(workerHost = "127.0.0.1:8799")
        assertTrue(clientConfig.useSecureWebSocket)
    }

    // ── La URL de enrollment ──────────────────────────────────────────────

    @Test
    fun theClaimUrlUsesTheFullMobileBridgeRoute() {
        val client = EnrollmentClaimClient(
            ClientConfig(workerHost = "127.0.0.1:8799", isDebugBuild = true)
        )
        assertEquals(
            "http://127.0.0.1:8799" + Contract.MOBILE_BRIDGE_PATH + "/enrollment/claim",
            client.buildClaimUrl()
        )
    }

    @Test
    fun theClaimUrlHasNoDuplicatedSchemeAndNoTrailingGarbage() {
        val client = EnrollmentClaimClient(
            ClientConfig(workerHost = "apollo.example", isDebugBuild = false)
        )
        val url = client.buildClaimUrl()
        assertTrue("debe arrancar con https", url.startsWith("https://"))
        assertFalse("no puede haber dos esquemas", url.contains("://https://"))
        assertFalse("no puede haber http://https://", url.contains("http://https://"))
        assertEquals(
            "https://apollo.example" + Contract.MOBILE_BRIDGE_PATH + "/enrollment/claim",
            url
        )
    }

    @Test
    fun enrollmentAndSocketAgreeOnTheTransport() {
        // Si los dos caminos calcularan el transporte por su cuenta, tarde o
        // temprano discreparian. Se comprueba con la misma config.
        for ((host, isDebug) in listOf(
            "127.0.0.1:8799" to true,
            "127.0.0.1:8799" to false,
            "apollo.example" to true,
            "apollo.example" to false
        )) {
            val clientConfig = ClientConfig(workerHost = host, isDebugBuild = isDebug)
            val claimUrl = EnrollmentClaimClient(clientConfig).buildClaimUrl()
            val socketUrl = clientConfig
                .buildSocketRequest(DeviceCredential.Enrolled("apollo_dev_credencial"))
                .url
            val claimIsCleartext = claimUrl.startsWith("http://")
            val socketIsCleartext = socketUrl.startsWith("ws://")
            assertEquals(
                "host=$host debug=$isDebug: enrollment y socket discrepan",
                claimIsCleartext,
                socketIsCleartext
            )
        }
    }

    // ── La credencial no viaja en la query ────────────────────────────────

    @Test
    fun theIndividualCredentialNeverTravelsInTheQueryString() {
        val socketRequest = ClientConfig(workerHost = "apollo.example")
            .buildSocketRequest(DeviceCredential.Enrolled("apollo_dev_credencial-secreta"))
        assertFalse(
            "la credencial debe viajar en el header, no en la URL",
            socketRequest.url.contains("apollo_dev_credencial-secreta")
        )
        assertFalse(socketRequest.url.contains("?token="))
        assertEquals(
            "Bearer apollo_dev_credencial-secreta",
            socketRequest.headerMap[ClientConfig.AUTHORIZATION_HEADER]
        )
    }

    @Test
    fun theSocketUsesWsWhenCleartextIsAllowedAndWssOtherwise() {
        val loopback = ClientConfig(workerHost = "127.0.0.1:8799", isDebugBuild = true)
            .buildSocketRequest(DeviceCredential.Enrolled("apollo_dev_x")).url
        val production = ClientConfig(workerHost = "apollo.example")
            .buildSocketRequest(DeviceCredential.Enrolled("apollo_dev_x")).url
        assertTrue(loopback.startsWith("ws://127.0.0.1:8799"))
        assertTrue(production.startsWith("wss://apollo.example"))
        assertTrue(loopback.endsWith(Contract.MOBILE_BRIDGE_PATH))
    }

    // ── Respuestas del claim ──────────────────────────────────────────────

    private class RecordingHttpPort(
        private val answer: EnrollmentHttpAnswer,
        private val thrown: Exception? = null
    ) : EnrollmentHttpPort {
        var lastUrl: String? = null
            private set
        var lastBody: String? = null
            private set

        override fun postJson(url: String, jsonBody: String): EnrollmentHttpAnswer {
            lastUrl = url
            lastBody = jsonBody
            thrown?.let { throw it }
            return answer
        }
    }

    @Test
    fun anEnrolledAnswerCarriesTheCredentialAndDeviceId() {
        val port = RecordingHttpPort(
            EnrollmentHttpAnswer(
                statusCode = 200,
                body = """{"status":"enrolled","deviceId":"mobile:abc","credential":"apollo_dev_x"}"""
            )
        )
        val result = EnrollmentClaimClient(ClientConfig(workerHost = "apollo.example"), port)
            .claim(challenge = "apollo_enr_c", deviceId = "mobile:abc")

        assertEquals(
            EnrollmentClaimResult.Enrolled(deviceId = "mobile:abc", credential = "apollo_dev_x"),
            result
        )
    }

    @Test
    fun aRejectedAnswerReportsTheServersReason() {
        val port = RecordingHttpPort(
            EnrollmentHttpAnswer(statusCode = 403, body = """{"reason":"challenge_consumed"}""")
        )
        val result = EnrollmentClaimClient(ClientConfig(workerHost = "apollo.example"), port)
            .claim(challenge = "apollo_enr_c", deviceId = "mobile:abc")

        assertEquals(EnrollmentClaimResult.Rejected("challenge_consumed"), result)
    }

    @Test
    fun aConnectionFailureIsReportedAsUnreachableAndNotAsARejection() {
        // La distincion importa: un rechazo del servidor y un problema de red
        // llevan a acciones distintas del lado del dueno.
        val port = RecordingHttpPort(
            answer = EnrollmentHttpAnswer(statusCode = 0, body = ""),
            thrown = java.net.SocketTimeoutException("timeout")
        )
        val result = EnrollmentClaimClient(ClientConfig(workerHost = "apollo.example"), port)
            .claim(challenge = "apollo_enr_c", deviceId = "mobile:abc")

        assertTrue(result is EnrollmentClaimResult.Unreachable)
    }

    @Test
    fun anEmptyChallengeNeverReachesTheNetwork() {
        val port = RecordingHttpPort(EnrollmentHttpAnswer(statusCode = 200, body = "{}"))
        val result = EnrollmentClaimClient(ClientConfig(workerHost = "apollo.example"), port)
            .claim(challenge = "   ", deviceId = "mobile:abc")

        assertEquals(EnrollmentClaimResult.Rejected("challenge_missing"), result)
        assertNull("no se debe haber abierto ninguna conexion", port.lastUrl)
    }

    @Test
    fun theClaimBodyCarriesChallengeAndDeviceIdAndNoCredential() {
        val port = RecordingHttpPort(
            EnrollmentHttpAnswer(
                statusCode = 200,
                body = """{"status":"enrolled","deviceId":"mobile:abc","credential":"apollo_dev_x"}"""
            )
        )
        EnrollmentClaimClient(ClientConfig(workerHost = "apollo.example"), port)
            .claim(challenge = "apollo_enr_c", deviceId = "mobile:abc")

        val body = port.lastBody!!
        assertTrue(body.contains("apollo_enr_c"))
        assertTrue(body.contains("mobile:abc"))
        // El claim no se autentica con nada: lo autoriza el desafio.
        assertFalse(body.contains("Authorization"))
        assertFalse(body.contains("apollo_dev_"))
    }
}
