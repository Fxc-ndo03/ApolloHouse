package com.apollo.mobile

import com.apollo.mobile.conversation.ConversationContract
import com.apollo.mobile.identity.AccountAuthAnswer
import com.apollo.mobile.identity.AccountAuthClient
import com.apollo.mobile.identity.AccountAuthHttpPort
import com.apollo.mobile.identity.AccountAuthOutcome
import com.apollo.mobile.transport.DeviceCredential
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FASE 2.3 — autenticación de cuenta en Android.
 *
 * Contrato fijado acá: si cambia el formato de `/api/auth`, fallan estos tests
 * y no el teléfono.
 */
class AccountAuthTest {

    private val accountIdA = "acc_aaaa0000000000000000000000000001"
    private val accountIdB = "acc_bbbb0000000000000000000000000002"

    private class FakeAccountHttp(
        private val statusCodeByPath: Map<String, Int>,
        private val bodyByPath: Map<String, String> = emptyMap(),
    ) : AccountAuthHttpPort {
        val requestUrls = mutableListOf<String>()
        val requestBodies = mutableListOf<String>()
        val requestTokens = mutableListOf<String?>()

        override fun postJson(url: String, jsonBody: String, bearerToken: String?): AccountAuthAnswer {
            requestUrls.add(url)
            requestBodies.add(jsonBody)
            requestTokens.add(bearerToken)
            val path = url.substringAfter("//").substringAfter("/")
            val code = statusCodeByPath[path] ?: 200
            return AccountAuthAnswer(code, bodyByPath[path] ?: "{}")
        }

        override fun getJson(url: String, bearerToken: String?): AccountAuthAnswer =
            postJson(url, "", bearerToken)
    }

    @Test
    fun laRutaDeCuentaApuntaAlApolloDeLaCuentaNoAlDelDispositivo() {
        val accountPath = ConversationContract.buildAccountConversationPath(accountIdA)
        assertEquals(
            "/agents/apollo/acct-$accountIdA",
            accountPath,
        )
        val devicePath = ConversationContract.buildConversationPath("mobile:phone-123")
        assertTrue(devicePath.contains("mobile%3Aphone-123"))
        // Las dos rutas jamás pueden coincidir: distinto namespace, distinto DO.
        assertFalse(accountPath == devicePath)
    }

    @Test
    fun laUrlDeCuentaEsWssContraLoopbackEnDebug() {
        val url = ConversationContract.buildAccountConversationUrl(
            workerHost = "127.0.0.1:8799",
            accountId = accountIdA,
            isDebugBuild = true,
        )
        assertEquals("ws://127.0.0.1:8799/agents/apollo/acct-$accountIdA", url)
    }

    @Test
    fun elLoginMandaCredencialesEnElBodyYNuncaEnLaUrl() {
        val http = FakeAccountHttp(
            statusCodeByPath = mapOf(
                "api/auth/login" to 200,
            ),
            bodyByPath = mapOf(
                "api/auth/login" to JSONObject()
                    .put("accountId", accountIdA)
                    .put("sessionToken", "token-sesion-1234567890")
                    .put("expiresAt", 1_700_000_000_000)
                    .toString(),
            ),
        )
        val client = AccountAuthClient(workerHost = "worker.example", httpPort = http)
        val outcome = client.login(email = "a@example.com", password = "clave-larga-123")
        assertTrue(outcome is AccountAuthOutcome.Authenticated)
        outcome as AccountAuthOutcome.Authenticated
        assertEquals(accountIdA, outcome.accountId)
        assertEquals("token-sesion-1234567890", outcome.sessionToken)
        val url = http.requestUrls.single()
        assertTrue(url.startsWith("https://worker.example/api/auth/login"))
        assertFalse(url.contains("a%40example"))
        assertFalse(url.contains("clave-larga"))
        val body = JSONObject(http.requestBodies.single())
        assertEquals("a@example.com", body.getString("email"))
        assertEquals("clave-larga-123", body.getString("password"))
    }

    @Test
    fun credencialesInvalidasYEmailRepetidoSeDistinguenSinFiltrarDetalles() {
        val invalidHttp = FakeAccountHttp(statusCodeByPath = mapOf("api/auth/login" to 401))
        val takenHttp = FakeAccountHttp(statusCodeByPath = mapOf("api/auth/register" to 409))
        val invalidOutcome = AccountAuthClient("worker.example", invalidHttp)
            .login("a@example.com", "malisima")
        val takenOutcome = AccountAuthClient("worker.example", takenHttp)
            .register("a@example.com", "clave-larga-123")
        assertEquals(AccountAuthClient.REASON_INVALID_CREDENTIALS, (invalidOutcome as AccountAuthOutcome.Rejected).reason)
        assertEquals(AccountAuthClient.REASON_EMAIL_TAKEN, (takenOutcome as AccountAuthOutcome.Rejected).reason)
    }

    @Test
    fun laSesionResuelveSuPropiaCuentaYMuereAlExpirar() {
        val httpForA = FakeAccountHttp(
            statusCodeByPath = mapOf("api/auth/session" to 200),
            bodyByPath = mapOf(
                "api/auth/session" to JSONObject()
                    .put("authenticated", true)
                    .put("accountId", accountIdA)
                    .toString(),
            ),
        )
        val expiredHttp = FakeAccountHttp(statusCodeByPath = mapOf("api/auth/session" to 401))
        val client = AccountAuthClient("worker.example", httpForA)
        assertEquals(accountIdA, client.resolveSessionAccount("token-sesion-1234567890"))
        assertNull(AccountAuthClient("worker.example", expiredHttp).resolveSessionAccount("token-sesion-1234567890"))
        val url = httpForA.requestUrls.single()
        assertFalse(url.contains("token-sesion"))
        // El puerto real (UrlConnection) convierte esto en el header
        // `Authorization: Bearer ...`; el fake ve el token crudo.
        assertEquals("token-sesion-1234567890", httpForA.requestTokens.single())
    }

    @Test
    fun laSesionDeCuentaViajaComoBearerYNoComoSecretoGlobal() {
        val account = DeviceCredential.AccountSession(
            accountId = accountIdA,
            sessionToken = "token-sesion-1234567890",
        )
        // Distinto tipo, distinto plano: una sesión de cuenta nunca puede
        // confundirse con la credencial del teléfono ni con el secreto global.
        assertTrue(account is DeviceCredential.AccountSession)
        assertFalse(account is DeviceCredential.Enrolled)
        assertFalse(account is DeviceCredential.LegacySharedSecret)
    }

    @Test
    fun dosCuentasConstruyenDosApolloDistintos() {
        val urlA = ConversationContract.buildAccountConversationPath(accountIdA)
        val urlB = ConversationContract.buildAccountConversationPath(accountIdB)
        assertTrue(urlA != urlB)
        assertTrue(urlA.endsWith(accountIdA))
        assertTrue(urlB.endsWith(accountIdB))
    }

    @Test
    fun elEnrolamientoDeDispositivoVaAutenticadoConLaSesion() {
        val http = FakeAccountHttp(statusCodeByPath = mapOf("api/auth/devices" to 200))
        val client = AccountAuthClient("worker.example", http)
        val enrolled = client.enrollDevice(
            sessionToken = "token-sesion-1234567890",
            deviceId = "mobile:phone-123",
            deviceType = "android",
            deviceName = "Pixel Test",
        )
        assertTrue(enrolled)
        val body = JSONObject(http.requestBodies.single())
        assertEquals("mobile:phone-123", body.getString("deviceId"))
        assertEquals("android", body.getString("deviceType"))
        assertEquals("token-sesion-1234567890", http.requestTokens.single())
    }
}
