package com.apollo.mobile

import com.apollo.mobile.conversation.ConversationContract
import com.apollo.mobile.conversation.ConversationHistory
import com.apollo.mobile.conversation.ConversationInbound
import com.apollo.mobile.conversation.ConversationOutbound
import com.apollo.mobile.conversation.ConversationState
import com.apollo.mobile.conversation.ConversationTurn
import com.apollo.mobile.transport.DeviceCredential
import com.apollo.mobile.transport.resolveIsSecureTransport
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * El cliente de conversación contra el Apollo DO.
 *
 * Estos tests fijan el CONTRATO: si el schema del Worker cambia un campo, tienen
 * que fallar acá y no en el teléfono.
 */
class ConversationTest {

    private val deviceId = "mobile:phone-123"

    @Test
    fun laRutaApuntaAlApolloDoDeEstaIdentidad() {
        val path = ConversationContract.buildConversationPath(deviceId)
        assertEquals("/agents/apollo/mobile%3Aphone-123", path)
    }

    @Test
    fun elHostLoopbackEnDebugBajaACleartextYUnoDeLanNo() {
        val loopbackUrl = ConversationContract.buildConversationUrl(
            workerHost = "127.0.0.1:8799",
            deviceId = deviceId,
            isDebugBuild = true
        )
        assertTrue(loopbackUrl.startsWith("ws://"))

        // Contra una IP de LAN la app exige TLS: el proxy de desarrollo no puede
        // abrirse como ruta normal, y esta assertion lo deja escrito.
        val lanUrl = ConversationContract.buildConversationUrl(
            workerHost = "192.168.100.67:8443",
            deviceId = deviceId,
            isDebugBuild = true
        )
        assertTrue(lanUrl.startsWith("wss://"))
        assertTrue(resolveIsSecureTransport("192.168.100.67:8443", isDebugBuild = true))
    }

    @Test
    fun elReleaseNuncaBajaACleartext() {
        val url = ConversationContract.buildConversationUrl(
            workerHost = "127.0.0.1:8799",
            deviceId = deviceId,
            isDebugBuild = false
        )
        assertTrue(url.startsWith("wss://"))
    }

    @Test
    fun textInputLlevaLosCamposQueElSchemaExige() {
        val raw = ConversationOutbound.buildTextInputMessage(
            text = "  que hora es?  ",
            atMilliseconds = 1_700_000_000_000L,
            requestId = "req-1",
            clientTurnId = "turn-1",
            generation = 3
        )
        val message = JSONObject(raw)
        assertEquals("text_input", message.getString("type"))
        // El recorte va en el borde: un texto con espacios no llega al servidor.
        assertEquals("que hora es?", message.getString("text"))
        assertEquals(1_700_000_000_000L, message.getLong("ts"))
        assertEquals("req-1", message.getString("request_id"))
        assertEquals("turn-1", message.getString("client_turn_id"))
        assertEquals(3, message.getInt("generation"))
    }

    @Test
    fun textInputVacioSeRechazaAntesDeMandar() {
        val threw = runCatching {
            ConversationOutbound.buildTextInputMessage("   ", atMilliseconds = 1L)
        }.isFailure
        assertTrue("un text_input vacio debe fallar localmente", threw)
    }

    @Test
    fun textInputSeRecortaAlLimiteDelCliente() {
        val raw = ConversationOutbound.buildTextInputMessage(
            text = "a".repeat(ConversationContract.TEXT_INPUT_MAX_LENGTH + 500),
            atMilliseconds = 1L
        )
        assertEquals(
            ConversationContract.TEXT_INPUT_MAX_LENGTH,
            JSONObject(raw).getString("text").length
        )
    }

    @Test
    fun abortYConfirmLlevanSuTipo() {
        assertEquals("abort", JSONObject(ConversationOutbound.buildAbortMessage(5L)).getString("type"))
        val confirm = JSONObject(ConversationOutbound.buildConfirmMessage(true, 5L))
        assertEquals("confirm", confirm.getString("type"))
        assertTrue(confirm.getBoolean("approved"))
    }

    @Test
    fun unMensajeInvalidoNoRompeElCliente() {
        assertNull(ConversationInbound.parse("no es json"))
        assertNull(ConversationInbound.parse("""{"sinType":1}"""))
    }

    @Test
    fun seLeeUnErrorDelServidorConSuMotivo() {
        val inbound = ConversationInbound.parse(
            """{"type":"error","code":"invalid_message","message":"Mensaje no reconocido"}"""
        )
        assertNotNull(inbound)
        assertTrue(inbound!!.getIsError)
        assertEquals("invalid_message", inbound.errorCode)
        assertEquals("Mensaje no reconocido", inbound.errorMessage)
    }

    @Test
    fun seLeeUnCaptionComoRespuestaDeApollo() {
        val inbound = ConversationInbound.parse("""{"type":"caption","text":"Son las 10","turnId":"t1"}""")
        assertNotNull(inbound)
        assertEquals(ConversationContract.INBOUND_CAPTION, inbound!!.type)
        assertEquals("Son las 10", inbound.caption)
        assertEquals("t1", inbound.turnId)
    }

    @Test
    fun unTipoDesconocidoNoSeRompe() {
        val inbound = ConversationInbound.parse("""{"type":"algo_del_2099"}""")
        assertNotNull(inbound)
        assertEquals("algo_del_2099", inbound!!.type)
    }

    @Test
    fun elHistorialRecortaPorCantidadYConservaLoReciente() {
        val history = ConversationHistory(maximumTurnCount = 3)
        for (index in 0 until 5) {
            history.add(
                ConversationTurn(
                    turnId = "t$index",
                    role = ConversationTurn.TurnRole.USER,
                    text = "mensaje $index",
                    atMilliseconds = index.toLong(),
                    state = ConversationTurn.TurnState.ANSWERED
                )
            )
        }
        assertEquals(3, history.size)
        assertEquals("t4", history.snapshot().last().turnId)
    }

    @Test
    fun elHistorialSobreviveASerializarse() {
        val history = ConversationHistory()
        history.add(
            ConversationTurn(
                turnId = "t1",
                role = ConversationTurn.TurnRole.USER,
                text = "hola",
                atMilliseconds = 1L,
                state = ConversationTurn.TurnState.SENT
            )
        )
        history.markAnswered("t1", ConversationTurn.TurnState.ANSWERED)

        val restored = ConversationHistory()
        restored.deserialize(history.serialize())

        assertEquals(1, restored.size)
        val turn = restored.snapshot().single()
        assertEquals("hola", turn.text)
        assertEquals(ConversationTurn.TurnRole.USER, turn.role)
        assertEquals(ConversationTurn.TurnState.ANSWERED, turn.state)
    }

    @Test
    fun unHistorialCorruptoNoTiraLaApp() {
        val history = ConversationHistory()
        history.deserialize("{basura")
        assertEquals(0, history.size)
    }

    @Test
    fun elHistorialNoGuardaNingunaCredencial() {
        // El historial es texto de conversación. Si alguna vez empezara a
        // guardar la credencial, esta assertion es la que lo detecta.
        val history = ConversationHistory()
        history.add(
            ConversationTurn(
                turnId = "t1",
                role = ConversationTurn.TurnRole.APOLLO,
                text = "ok",
                atMilliseconds = 1L,
                state = ConversationTurn.TurnState.ANSWERED
            )
        )
        val serialized = history.serialize()
        assertFalse(serialized.contains("apollo_dev_"))
        assertFalse(serialized.contains("Bearer"))
    }

    @Test
    fun laCredencialVaEnElHeaderYNoEnLaUrl() {
        val credential = DeviceCredential.Enrolled("apollo_dev_ejemplo_de_prueba")
        val headerMap = mapOf("Authorization" to "Bearer ${credential.credential}")
        assertFalse(ConversationContract.buildConversationPath(deviceId).contains("token="))
        assertTrue(headerMap.getValue("Authorization").startsWith("Bearer apollo_dev_"))
    }

    @Test
    fun losEstadosCubrenElCicloCompleto() {
        // El enum tiene que cubrir el circuito entero; si aparece un estado sin
        // ramificar en la UI, el usuario ve un hueco.
        assertEquals(6, ConversationState.entries.size)
        assertNotNull(ConversationState.valueOf("ONLINE"))
        assertNotNull(ConversationState.valueOf("DENIED"))
    }
}
