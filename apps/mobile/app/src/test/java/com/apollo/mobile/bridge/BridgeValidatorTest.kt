package com.apollo.mobile.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

import com.apollo.mobile.bridge.ALLOWED_OPERATIONS
import com.apollo.mobile.bridge.BRIDGE_CONTRACT_VERSION

/**
 * Pruebas de [BridgeValidator] — la capa de parseo y validacion del puente.
 * Son puras (no dependen de Android Context ni de red), así que corren en
 * cualquier JVM sin emulador.
 */
class BridgeValidatorTest {

    private fun parseOk(json: String): BridgeRequest {
        return (BridgeValidator.parseRequest(json) as BridgeRequestResult.Valid).request
    }

    /** Parseo completo: estructura (parseRequest) + argumentos (validateArguments). */
    private fun fullValidate(json: String): BridgeRequestResult {
        return when (val parsed = BridgeValidator.parseRequest(json)) {
            is BridgeRequestResult.Invalid -> parsed
            is BridgeRequestResult.Valid -> BridgeValidator.validateArguments(parsed.request)
        }
    }

    private fun parseError(json: String): String {
        return (fullValidate(json) as BridgeRequestResult.Invalid).error
    }

    @Test
    fun allowedOperationsNoEstanVacias() {
        assertTrue(ALLOWED_OPERATIONS.isNotEmpty())
        assertTrue("auth.register" in ALLOWED_OPERATIONS)
        assertTrue("auth.login" in ALLOWED_OPERATIONS)
        assertTrue("auth.logout" in ALLOWED_OPERATIONS)
        assertTrue("auth.state" in ALLOWED_OPERATIONS)
        assertTrue("auth.verify" in ALLOWED_OPERATIONS)
        assertTrue("device.identity" in ALLOWED_OPERATIONS)
        assertTrue("capabilities.list" in ALLOWED_OPERATIONS)
        assertTrue("capabilities.state" in ALLOWED_OPERATIONS)
        assertTrue("conversation.send" in ALLOWED_OPERATIONS)
        assertTrue("conversation.cancel" in ALLOWED_OPERATIONS)
        assertTrue("notification.post" in ALLOWED_OPERATIONS)
        assertTrue("updates.check" in ALLOWED_OPERATIONS)
        assertTrue("updates.install" in ALLOWED_OPERATIONS)
        assertTrue("settings.read" in ALLOWED_OPERATIONS)
        assertTrue("settings.write" in ALLOWED_OPERATIONS)
        assertTrue("voice.start" in ALLOWED_OPERATIONS)
        assertTrue("voice.stop" in ALLOWED_OPERATIONS)
    }

    @Test
    fun operacionesAndroidNuevasAceptanArgumentosDelContrato() {
        listOf("settings.read", "updates.check", "updates.install", "voice.start", "voice.stop")
            .forEach { operation ->
                assertTrue(
                    "$operation debe aceptar argumentos vacios",
                    fullValidate("""{"operation":"$operation","arguments":{},"requestId":"r"}""")
                        is BridgeRequestResult.Valid,
                )
            }
        assertTrue(
            fullValidate("""{"operation":"settings.write","arguments":{"patch":{"mic_muted":true}},"requestId":"r"}""")
                is BridgeRequestResult.Valid,
        )
    }

    @Test
    fun versionPorDefectoEsUno() {
        assertEquals(1, BRIDGE_CONTRACT_VERSION)
    }

    @Test
    fun parsePeticionValidaAuthRegister() {
        val req = parseOk(
            """{"contractVersion":1,"operation":"auth.register","arguments":{"email":"a@b.c","password":"1234567890"},"requestId":"req-1"}"""
        )
        assertEquals("auth.register", req.operation)
        assertEquals("req-1", req.requestId)
        assertEquals("a@b.c", req.arguments["email"])
        assertEquals("1234567890", req.arguments["password"])
    }

    @Test
    fun parsePeticionValidaAuthStateSinArgumentos() {
        val req = parseOk("""{"operation":"auth.state","arguments":{},"requestId":"req-2"}""")
        assertEquals("auth.state", req.operation)
        assertTrue(req.arguments.isEmpty())
        assertEquals("req-2", req.requestId)
    }

    @Test
    fun parsePeticionValidaConversationSend() {
        val req = parseOk(
            """{"operation":"conversation.send","arguments":{"text":"Hola Apollo"},"requestId":"req-3"}"""
        )
        assertEquals("conversation.send", req.operation)
        assertEquals("Hola Apollo", req.arguments["text"])
    }

    @Test
    fun parsePeticionValidaNotificationPost() {
        val req = parseOk(
            """{"operation":"notification.post","arguments":{"title":"T","body":"B"},"requestId":"req-4"}"""
        )
        assertEquals("notification.post", req.operation)
        assertEquals("T", req.arguments["title"])
        assertEquals("B", req.arguments["body"])
    }

    @Test
    fun jsonInvalidoSeRechaza() {
        assertEquals(BridgeError.INVALID_ARGUMENTS, parseError("no es json"))
        assertEquals(BridgeError.INVALID_ARGUMENTS, parseError(""))
        assertEquals(BridgeError.INVALID_ARGUMENTS, parseError("[]"))
        // operation numerico no es un nombre de operacion valido
        assertEquals(BridgeError.UNSUPPORTED_OPERATION, parseError("""{"operation":123}"""))
    }

    @Test
    fun operacionDesconocidaSeRechaza() {
        assertEquals(
            BridgeError.UNSUPPORTED_OPERATION,
            parseError("""{"operation":"auth.inexistente","arguments":{},"requestId":"r"}""")
        )
    }

    @Test
    fun requestIdRequerido() {
        assertEquals(
            BridgeError.INVALID_ARGUMENTS,
            parseError("""{"operation":"auth.state","arguments":{}}""")
        )
        assertEquals(
            BridgeError.INVALID_ARGUMENTS,
            parseError("""{"operation":"auth.state","arguments":{},"requestId":""}""")
        )
    }

    @Test
    fun versionDeContratoIncorrectaSeRechaza() {
        assertEquals(
            BridgeError.INVALID_ARGUMENTS,
            parseError("""{"contractVersion":2,"operation":"auth.state","arguments":{},"requestId":"r"}""")
        )
        // contractVersion ausente es valido
        val req = parseOk("""{"operation":"auth.state","arguments":{},"requestId":"r"}""")
        assertEquals("auth.state", req.operation)
    }

    @Test
    fun camposExtraEnArgumentosSeRechazan() {
        assertEquals(
            BridgeError.INVALID_ARGUMENTS,
            parseError(
                """{"operation":"auth.state","arguments":{"extra":"x"},"requestId":"r"}"""
            )
        )
    }

    @Test
    fun emailInvalidoSeRechaza() {
        val longPwd = "a".repeat(257)
        assertEquals(
            BridgeError.INVALID_ARGUMENTS,
            parseError(
                """{"operation":"auth.register","arguments":{"email":"no-es-email","password":"1234567890"},"requestId":"r"}"""
            )
        )
        assertEquals(
            BridgeError.INVALID_ARGUMENTS,
            parseError(
                """{"operation":"auth.login","arguments":{"email":"","password":"1234567890"},"requestId":"r"}"""
            )
        )
        assertEquals(
            BridgeError.INVALID_ARGUMENTS,
            parseError(
                """{"operation":"auth.register","arguments":{"email":"a@b.c","password":"$longPwd"},"requestId":"r"}"""
            )
        )
    }

    @Test
    fun textoDeConversacionVacioOMuyLargoSeRechaza() {
        val longText = "a".repeat(4001)
        assertEquals(
            BridgeError.INVALID_ARGUMENTS,
            parseError("""{"operation":"conversation.send","arguments":{"text":""},"requestId":"r"}""")
        )
        assertEquals(
            BridgeError.INVALID_ARGUMENTS,
            parseError(
                """{"operation":"conversation.send","arguments":{"text":"$longText"},"requestId":"r"}"""
            )
        )
    }

    @Test
    fun notificationPostTituloYBodyConLimites() {
        val longBody = "x".repeat(501)
        // valido
        val req = parseOk(
            """{"operation":"notification.post","arguments":{"title":"T","body":"B"},"requestId":"r"}"""
        )
        assertEquals("T", req.arguments["title"])
        assertEquals("B", req.arguments["body"])
        // titulo vacio
        assertEquals(
            BridgeError.INVALID_ARGUMENTS,
            parseError("""{"operation":"notification.post","arguments":{"title":"","body":"B"},"requestId":"r"}""")
        )
        // body muy largo
        assertEquals(
            BridgeError.INVALID_ARGUMENTS,
            parseError(
                """{"operation":"notification.post","arguments":{"title":"T","body":"$longBody"},"requestId":"r"}"""
            )
        )
    }

    @Test
    fun respuestaDeExitoTieneCamposEsperados() {
        val resp = BridgeValidator.ok("req-1", mapOf("accountId" to "acct-123"))
        assertTrue(resp.ok)
        assertEquals("acct-123", resp.data!!["accountId"])
        assertNull(resp.error)
        assertEquals("req-1", resp.requestId)
        val json = resp.toJson()
        assertTrue(json.contains("\"ok\":true"))
        assertTrue(json.contains("\"requestId\":\"req-1\""))
    }

    @Test
    fun respuestaDeHandlerSeCorrelacionaConLaPeticionOriginal() {
        val handlerResponse = BridgeValidator.ok(null, mapOf("signedIn" to false))

        val response = BridgeValidator.correlate(handlerResponse, "auth-state-42")

        assertTrue(response.ok)
        assertEquals("auth-state-42", response.requestId)
        assertTrue(response.toJson().contains("\"requestId\":\"auth-state-42\""))
    }

    @Test
    fun respuestaDeErrorTieneCamposEsperados() {
        val resp = BridgeValidator.error("req-2", BridgeError.NOT_AUTHENTICATED)
        assertFalse(resp.ok)
        assertNull(resp.data)
        assertEquals(BridgeError.NOT_AUTHENTICATED, resp.error)
        assertEquals("req-2", resp.requestId)
        val json = resp.toJson()
        assertTrue(json.contains("\"ok\":false"))
        assertTrue(json.contains("\"error\":\"not_authenticated\""))
    }
}
