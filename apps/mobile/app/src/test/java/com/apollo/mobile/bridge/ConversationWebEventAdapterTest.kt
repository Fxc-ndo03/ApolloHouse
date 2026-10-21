package com.apollo.mobile.bridge

import com.apollo.mobile.FakeReconnectScheduler
import com.apollo.mobile.ScriptedSocketFactory
import com.apollo.mobile.conversation.ConversationHistory
import com.apollo.mobile.conversation.ConversationOwner
import com.apollo.mobile.conversation.ConversationState
import com.apollo.mobile.transport.DeviceCredential
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConversationWebEventAdapterTest {
    @Test
    fun turnoCompletoEmiteEventosEnContratoYSoloUnaVez() {
        val sockets = ScriptedSocketFactory()
        val owner = ConversationOwner(
            workerHostPort = { "worker.example" },
            isDebugBuild = false,
            socketFactory = sockets,
            reconnectScheduler = FakeReconnectScheduler(),
            history = ConversationHistory(),
            nowMillisecondsPort = { 10L },
        )
        val events = mutableListOf<Pair<String, String>>()
        val adapter = ConversationWebEventAdapter(owner, emit = { name, payload -> events += name to payload })
        owner.start("mobile:test", DeviceCredential.AccountSession("acct-test", "session-test"))
        sockets.listenerOf(1).onOpen()
        sockets.deliverTo(1, """{"type":"ui_state","state":"idle"}""")
        events.clear()

        assertEquals("turn-10", adapter.send("Hola"))
        sockets.deliverTo(1, """{"type":"ui_state","caption":"Respuesta \"real\"","turnId":"answer-1"}""")
        sockets.deliverTo(1, """{"type":"ui_state","caption":"Respuesta \"real\"","turnId":"answer-1"}""")

        assertEquals(
            listOf(
                "orb-state-change" to "\"thinking\"",
                "text-response-chunk" to "\"Respuesta \\\"real\\\"\"",
                "text-response-end" to "{}",
                "turn-end" to "{\"expectsReply\":false}",
                "orb-state-change" to "\"idle\"",
            ),
            events,
        )
        adapter.release()
    }

    @Test
    fun conversationOwnerOnlySendsAfterAuthenticatedHelloAndStopsAfterDenial() {
        val sockets = ScriptedSocketFactory()
        val owner = ConversationOwner(
            workerHostPort = { "worker.example" },
            isDebugBuild = false,
            socketFactory = sockets,
            reconnectScheduler = FakeReconnectScheduler(),
            history = ConversationHistory(),
            nowMillisecondsPort = { 20L },
        )

        assertNull(owner.send("antes de iniciar"))
        owner.start("mobile:test", DeviceCredential.AccountSession("acct-test", "session-test"))
        sockets.listenerOf(1).onOpen()
        assertEquals(ConversationState.AWAITING_HELLO, owner.state)
        assertNull(owner.send("antes de autenticar el socket"))

        sockets.deliverTo(1, """{"type":"ui_state","state":"idle"}""")
        assertEquals(ConversationState.ONLINE, owner.state)
        assertEquals("turn-20", owner.send("sesión confirmada"))

        sockets.listenerOf(1).onServerClose(1008, "account_session_rejected")
        assertEquals(ConversationState.DENIED, owner.state)
        assertNull(owner.send("sesión rechazada"))
    }
}
