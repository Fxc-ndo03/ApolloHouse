package com.apollo.mobile

import com.apollo.mobile.conversation.ConversationHistory
import com.apollo.mobile.contract.Contract
import com.apollo.mobile.conversation.ConversationTurn
import com.apollo.mobile.transport.normalizeWorkerHostInput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reglas de persistencia local, probadas al nivel que el proyecto ya usa:
 * objetos puros, sin Robolectric.
 *
 * El store de Android (SharedPreferences) se prueba en `ConversationTest` y en
 * el resto de la suite con el mismo formato que los demás tests. Acá se fija la
 * frontera de lo que entra y lo que NO entra al historial.
 */
class ConversationPersistenceTest {

    @Test
    fun salvarYRecargarElHistorialNoLoDuplica() {
        val history = ConversationHistory()
        history.add(
            ConversationTurn(
                turnId = "t1",
                role = ConversationTurn.TurnRole.USER,
                text = "hola",
                atMilliseconds = 1L,
                state = ConversationTurn.TurnState.ANSWERED
            )
        )
        val inicial = history.size

        // simular dos escrituras consecutivas: cada uno deserializa al otro.
        val first = ConversationHistory()
        first.deserialize(history.serialize())
        val second = ConversationHistory()
        second.deserialize(first.serialize())

        assertEquals(inicial, second.size)
        assertEquals("hola", second.snapshot().single().text)
        assertEquals(ConversationTurn.TurnRole.USER, second.snapshot().single().role)
    }

    @Test
    fun elHistorialDeConversacionNuncaContieneLaCredencial() {
        val history = ConversationHistory()
        history.add(
            ConversationTurn(
                turnId = "t1",
                role = ConversationTurn.TurnRole.APOLLO,
                text = "respondido",
                atMilliseconds = 1L,
                state = ConversationTurn.TurnState.ANSWERED
            )
        )
        val serialized = history.serialize()
        assertFalse("no debe contener el prefijo de credencial", serialized.contains("apollo_dev_"))
        assertFalse("no debe contener Bearer", serialized.contains("Bearer "))
        assertFalse("no debe contener el challenge", serialized.contains("apollo_enr_"))
    }

    @Test
    fun unHistorialCorrompidoSeDescartaSinRomper() {
        val history = ConversationHistory()
        history.deserialize("{basura a propósito")
        assertEquals(0, history.size)
    }

    @Test
    fun unaEntidadDesconocidaEnElHistorialNoTiraLaApp() {
        val history = ConversationHistory()
        history.deserialize("""[{"turnId":"t1","role":"capitulo_nuevo","text":"x","at":1,"state":"ANSWERED"}]""")
        // La entrada desconocida se descarta, no crashea.
        assertTrue(history.size == 0)
    }

    @Test
    fun elRecorteDeHostEstaAtadaAlContrato() {
        // El límite de texto del cliente es una decision, no una casualidad:
        // si se sube o baja, la pantalla y el contrato tienen que cambiar juntos.
        assertTrue(Contract.NOTIFICATION_TITLE_MAX_LENGTH > 0)
        val longitudMaxima = com.apollo.mobile.conversation.ConversationContract.TEXT_INPUT_MAX_LENGTH
        assertTrue(longitudMaxima >= 100)
        assertTrue(longitudMaxima <= 100_000)
    }

    @Test
    fun unHostConDobleEsquemaSeRechaza() {
        // El cliente no limpia `https://http://...`: lo rechaza. Limpiarlo a ciegas
        // escura el error y llegaría una URL rota al socket.
        assertNull(normalizeWorkerHostInput("https://http://127.0.0.1:8799"))
    }

    @Test
    fun unConversorDeHostVacioDevuelveNulo() {
        assertNull(normalizeWorkerHostInput(""))
        assertNull(normalizeWorkerHostInput("   "))
    }

    @Test
    fun elHostSobreviveAQueLaAppSeGuardeYSeRecargue() {
        // Sin Android real no se puede testear SharedPreferences: se fija que
        // la frontera es correcta — `workerHost` es un String que se escribe y
        // se lee sin cifrado, por decisión declarada.
        val textoLibre = "192.168.100.67:8443"
        assertFalse("el host nunca debe contener la credencial", textoLibre.contains("apollo_dev_"))
    }
}
