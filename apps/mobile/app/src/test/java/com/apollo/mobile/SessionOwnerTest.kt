package com.apollo.mobile

import com.apollo.mobile.command.CommandDispatcher
import com.apollo.mobile.contract.Contract
import com.apollo.mobile.notification.PermissionOutcome
import com.apollo.mobile.session.MobileSession
import com.apollo.mobile.session.MobileSessionOwner
import com.apollo.mobile.session.MobileSessionState
import com.apollo.mobile.session.reconnect.resolveReconnectDelayMilliseconds
import com.apollo.mobile.transport.ClientConfig
import com.apollo.mobile.transport.DeviceCredential
import com.apollo.mobile.transport.DeviceSocketListener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BLOCK 12.5.1: dueno unico de la sesion y reconexion fiable.
 *
 * Todo el tiempo es falso. El scheduler no corre solo: el test decide cuando se
 * cumple un reintento, asi que "esperar el backoff" no es esperar de verdad y
 * estas pruebas no dependen de la carga de la maquina.
 */
class SessionOwnerTest {

    private val socketFactory = ScriptedSocketFactory()
    private val reconnectScheduler = FakeReconnectScheduler()

    /** Jitter fijo en 0: los retrasos esperados se pueden escribir exactos. */
    private fun buildOwner(
        randomPort: () -> Double = { 0.0 }
    ): MobileSessionOwner = MobileSessionOwner(
        sessionFactory = {
            MobileSession(
                clientConfig = ClientConfig(workerHost = TEST_WORKER_HOST),
                deviceSocketFactory = socketFactory,
                commandDispatcher = CommandDispatcher(
                    FakeNotificationAdapter(PermissionOutcome.Granted),
                    RecordingMobilePlatform()
                ),
                nowMillisecondsPort = { 1_700_000_000_000L }
            )
        },
        reconnectScheduler = reconnectScheduler,
        randomPort = randomPort
    )

    private fun startOwner(
        owner: MobileSessionOwner,
        credential: DeviceCredential = enrolledTestCredential()
    ): Boolean = owner.start(TEST_DEVICE_ID, credential)

    private fun acceptHelloAt(socketIndex: Int) {
        socketFactory.deliverTo(socketIndex, buildHelloAcceptedMessage())
    }

    // ── 1. Cierre inesperado y reconexion programada ───────────────────────

    @Test
    fun anUnexpectedCloseSchedulesAReconnect() {
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)
        assertEquals(MobileSessionState.ONLINE, owner.currentState)

        // Se cae la red sin que nadie lo haya pedido.
        socketFactory.dropSocketAt(1)

        assertEquals(MobileSessionState.RECONNECTING, owner.currentState)
        assertTrue("debe quedar un reintento agendado", owner.isReconnectPending)
        assertEquals(1, reconnectScheduler.getPendingCount())
        // Todavia no reconectó: el reintento espera su momento.
        assertEquals(1, socketFactory.openCount)
    }

    @Test
    fun theReconnectHappensOnlyWhenTheScheduledMomentArrives() {
        val owner = buildOwner()
        startOwner(owner)
        socketFactory.dropSocketAt(1)

        assertTrue(reconnectScheduler.runPending())

        assertEquals(2, socketFactory.openCount)
        assertEquals(1, owner.reconnectCount)
    }

    // ── 2. Backoff creciente con tope ──────────────────────────────────────

    @Test
    fun theBackoffGrowsAndStopsAtTheCap() {
        val owner = buildOwner()
        startOwner(owner)
        val observedDelayList = mutableListOf<Long>()

        // Cada caida agenda un reintento; se corre y se vuelve a caer.
        // Los sockets son 1-based: el primero lo abre el start.
        repeat(Contract.RECONNECT_BACKOFF_MILLISECOND_LIST.size + 4) { attemptIndex ->
            socketFactory.dropSocketAt(attemptIndex + 1)
            reconnectScheduler.readNextPendingDelayMilliseconds()?.let { observedDelayList.add(it) }
            reconnectScheduler.runPending()
        }

        // Creciente...
        for (index in 1 until observedDelayList.size) {
            assertTrue(
                "el backoff decrecio en la posicion $index: $observedDelayList",
                observedDelayList[index] >= observedDelayList[index - 1]
            )
        }
        // ...y topado: la tabla del contrato tiene 6 valores y el tope se repite.
        val capDelay = observedDelayList.last()
        val occurrences = observedDelayList.count { it == capDelay }
        assertTrue("esperaba repeticiones del tope, hubo $occurrences", occurrences >= 4)
    }

    @Test
    fun theJitterAddsAtMostTwentyPercentOfTheBase() {
        // Con el jitter al maximo (0.9999...) el retraso se acerca al tope del
        // 20%, nunca lo pasa.
        val base = 1_000L
        val maximumJittered = resolveReconnectDelayMilliseconds(base) { 0.999_999 }
        assertTrue(
            "el jitter no puede exceder el 20%: $maximumJittered",
            maximumJittered <= base + 200
        )
        assertTrue(maximumJittered > base)
    }

    @Test
    fun theJitterIsInjectedSoTheDelayIsTestableWithoutChance() {
        // La tabla del contrato es un contrato compartido; el jitter es politica
        // local. Con puerto fijo, el retraso es exactamente el esperado.
        assertEquals(1_000L, resolveReconnectDelayMilliseconds(1_000L) { 0.0 })
        assertEquals(1_100L, resolveReconnectDelayMilliseconds(1_000L) { 0.5 })
        assertEquals(4_000L, resolveReconnectDelayMilliseconds(4_000L) { 0.0 })
    }

    // ── 3. Conexion recuperada sin duplicar sesiones ──────────────────────

    @Test
    fun recoveringDoesNotDuplicateSessionsOrSockets() {
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)
        socketFactory.dropSocketAt(1)
        reconnectScheduler.runPending()
        acceptHelloAt(2)

        assertEquals(MobileSessionState.ONLINE, owner.currentState)
        assertEquals("debe haber exactamente dos sockets, uno por intento", 2, socketFactory.openCount)
        assertEquals("una sola sesion arrancada", 1, owner.startCount)
        // Y el heartbeat quedoandando solo una vez, en la sesion viva.
        assertFalse(owner.isReconnectPending)
    }

    @Test
    fun pressingConnectTwiceNeverOpensASecondSocket() {
        val owner = buildOwner()

        assertTrue("el primer start arranca", startOwner(owner))
        assertFalse("el segundo start es no-op", startOwner(owner))
        assertFalse("el tercero tambien", startOwner(owner))

        assertEquals(1, owner.startCount)
        assertEquals(1, socketFactory.openCount)
    }

    @Test
    fun theBackoffResetsAfterRecovering() {
        val owner = buildOwner()
        startOwner(owner)
        // Se cae dos veces: el backoff ya subio.
        socketFactory.dropSocketAt(1)
        val firstDelay = reconnectScheduler.readNextPendingDelayMilliseconds()
        reconnectScheduler.runPending()
        socketFactory.dropSocketAt(2)
        val secondDelay = reconnectScheduler.readNextPendingDelayMilliseconds()

        assertTrue(secondDelay!! > firstDelay!!)

        // Se recupera: el backoff vuelve a cero. Recien ahi existe el socket 3,
        // porque abrirlo es lo que hace el reintento que estaba agendado.
        reconnectScheduler.runPending()
        acceptHelloAt(3)
        socketFactory.dropSocketAt(3)

        assertEquals(
            "tras reconectar, el proximo backoff arranca de nuevo en el piso",
            Contract.RECONNECT_BACKOFF_MILLISECOND_LIST.first(),
            reconnectScheduler.readNextPendingDelayMilliseconds()
        )
    }

    @Test
    fun theSameSocketReportingTwiceSchedulesOnlyOneReconnect() {
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)

        // OkHttp puede reportar la misma caida por dos caminos: `onClosing`/
        // `onClosed` y despues `onFailure`. Los dos terminan en `handleClosed`.
        // Sin reemplazar el reintento pendiente, quedarian DOS reconexiones
        // agendadas y al vencer el plazo abririan dos sockets.
        socketFactory.dropSocketAt(1)
        socketFactory.failSocketAt(1, "timeout")

        assertEquals(
            "una sola caida, un solo reintento pendiente",
            1,
            reconnectScheduler.getPendingCount()
        )
        reconnectScheduler.runPending()
        reconnectScheduler.runPending()
        assertEquals("y un solo socket nuevo", 2, socketFactory.openCount)
    }

    // ── 4. Desconexion manual cancela los reintentos ──────────────────────

    @Test
    fun manualStopCancelsThePendingReconnect() {
        val owner = buildOwner()
        val observedStateList = mutableListOf<MobileSessionState>()
        owner.observe(object : MobileSessionOwner.SessionListener {
            override fun onStateChanged(state: MobileSessionState) {
                observedStateList.add(state)
            }
        })
        startOwner(owner)
        socketFactory.dropSocketAt(1)
        assertTrue(owner.isReconnectPending)

        owner.stop()

        assertFalse("stop() cancela el reintento", owner.isReconnectPending)
        assertEquals(1, reconnectScheduler.cancelledTaskIdList.size)
        assertEquals("no debe reconectar", false, reconnectScheduler.runPending())
        assertEquals(1, socketFactory.openCount)
        // `stop` suelta la sesion, asi que no queda ninguna viva. Lo que la UI
        // ve es la transicion a DESCONNECTED que se publico antes de soltarla:
        // por eso se comprueba la observacion y no `currentState`.
        assertEquals(null, owner.currentState)
        assertEquals(MobileSessionState.DISCONNECTED, observedStateList.last())
    }

    @Test
    fun aManualStopThenAConnectStartsCleanlyAgain() {
        val owner = buildOwner()
        startOwner(owner)
        socketFactory.dropSocketAt(1)
        owner.stop()

        // Volver a arrancar despues de parar abre un socket nuevo y limpio.
        assertTrue(owner.start(TEST_DEVICE_ID, enrolledTestCredential()))

        assertEquals(2, socketFactory.openCount)
        assertEquals(2, owner.startCount)
        assertEquals(MobileSessionState.CONNECTING, owner.currentState)
    }

    // ── 5. Revocacion: sin bucle de reconexion ────────────────────────────

    @Test
    fun aRevokedCredentialNeverReconnects() {
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)

        // El DO cierra con 1008 porque la credencial no sirve.
        socketFactory.listenerOf(1).onServerClose(
            DeviceSocketListener.POLICY_VIOLATION_CLOSURE_CODE,
            "credential_revoked"
        )

        assertEquals(MobileSessionState.DISCONNECTED, owner.currentState)
        assertEquals(0, reconnectScheduler.getPendingCount())
        assertEquals("no debe agendar ningun reintento", false, owner.isReconnectPending)
    }

    @Test
    fun evenIfAReconnectIsPendingARevocationStopsIt() {
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)
        socketFactory.dropSocketAt(1)
        assertTrue(owner.isReconnectPending)

        // La revocacion llega mientras el reintento espera.
        socketFactory.listenerOf(1).onServerClose(
            DeviceSocketListener.POLICY_VIOLATION_CLOSURE_CODE,
            "credential_revoked"
        )
        reconnectScheduler.runPending()

        assertEquals("no debe reconectar contra una credencial revocada", 1, socketFactory.openCount)
        assertEquals(0, owner.reconnectCount)
    }

    // ── 6. Callbacks atrasados de una conexion anterior ───────────────────

    @Test
    fun aLateCloseFromTheOldSocketDoesNotBreakTheNewOne() {
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)
        socketFactory.dropSocketAt(1)
        reconnectScheduler.runPending()
        acceptHelloAt(2)
        assertEquals(MobileSessionState.ONLINE, owner.currentState)

        // El socket viejo todavia tiene un callback en la cola de OkHttp y
        // dispara tarde. Si no se filtra por generacion, tumbaria la sesion
        // nueva que ya esta ONLINE.
        socketFactory.dropSocketAt(1)

        assertEquals(
            "un cierre tardio no puede desconectar la sesion viva",
            MobileSessionState.ONLINE,
            owner.currentState
        )
        assertFalse("ni agendar un reintento espurio", owner.isReconnectPending)
    }

    @Test
    fun aLateMessageFromTheOldSocketIsIgnored() {
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)
        socketFactory.dropSocketAt(1)
        reconnectScheduler.runPending()
        acceptHelloAt(2)

        val availabilityBefore = owner.currentState
        // Un `hello_accepted` tardio del socket viejo no debe tocar el estado.
        socketFactory.deliverTo(1, buildHelloAcceptedMessage())

        assertEquals(availabilityBefore, owner.currentState)
        assertEquals(MobileSessionState.ONLINE, owner.currentState)
    }

    @Test
    fun aLateFailureFromTheOldSocketIsIgnored() {
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)
        socketFactory.dropSocketAt(1)
        reconnectScheduler.runPending()
        acceptHelloAt(2)

        socketFactory.failSocketAt(1, "timeout del socket viejo")

        assertEquals(MobileSessionState.ONLINE, owner.currentState)
        assertFalse(owner.isReconnectPending)
    }

    @Test
    fun aLateRevocationFromTheOldSocketDoesNotKillTheNewSession() {
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)
        socketFactory.dropSocketAt(1)
        reconnectScheduler.runPending()
        acceptHelloAt(2)

        // Este es el caso peligroso: un 1008 tardio del socket viejo marcaría la
        // sesion nueva como revocada para siempre.
        socketFactory.listenerOf(1).onServerClose(
            DeviceSocketListener.POLICY_VIOLATION_CLOSURE_CODE,
            "credential_revoked"
        )

        assertEquals(MobileSessionState.ONLINE, owner.currentState)
        socketFactory.dropSocketAt(2)
        assertTrue("la sesion nueva sigue pudiendo reconectar", owner.isReconnectPending)
    }

    // ── 7. Liberacion de recursos ──────────────────────────────────────────

    @Test
    fun releaseClosesEverythingAndLetsTheSessionGo() {
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)
        socketFactory.dropSocketAt(1)
        assertTrue(owner.isReconnectPending)

        owner.release()

        assertEquals("no queda ninguna sesion viva", null, owner.currentState)
        assertFalse(owner.isConnected)
        assertFalse("no queda ningun reintento", owner.isReconnectPending)
        assertFalse("el reintento fue cancelado", reconnectScheduler.runPending())
    }

    @Test
    fun releaseAlsoStopsTheHeartbeatOfTheSessionItOwned() {
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)
        assertEquals(MobileSessionState.ONLINE, owner.currentState)

        owner.release()

        // Sin sesion no queda ningun heartbeat vivo: el socket se cerro al
        // soltar la referencia.
        assertEquals(null, owner.currentState)
        socketFactory.dropSocketAt(1)
        assertEquals(null, owner.currentState)
    }

    @Test
    fun startAfterAPermanentRejectionReplacesTheDeadSession() {
        // El caso real del Moto G35: el servidor roto la credencial (re-enrollment
        // desde otra parte) y cerro con 1008. El telefono queda con una sesion
        // muerta que `start` se negaba a reemplazar, y la UI decia "ya estas
        // conectado" con el telefono desconectado.
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)
        assertEquals(MobileSessionState.ONLINE, owner.currentState)

        socketFactory.listenerOf(1).onServerClose(
            DeviceSocketListener.POLICY_VIOLATION_CLOSURE_CODE,
            "credential_revoked"
        )
        assertEquals(MobileSessionState.DISCONNECTED, owner.currentState)

        // Un nuevo intento con la misma credencial: la sesion muerta se reemplaza
        // en vez de devolver false para siempre.
        assertTrue("la sesion rechazada es muerta: start debe reemplazarla", startOwner(owner))
        assertEquals(2, socketFactory.openCount)
        assertEquals(2, owner.startCount)

        // Y la sesion nueva no hereda el rechazo de la vieja: manda hello.
        socketFactory.deliverTo(2, buildHelloAcceptedMessage())
        assertEquals(MobileSessionState.ONLINE, owner.currentState)
    }

    @Test
    fun theOwnerRefusesTheLegacyGlobalSecret() {
        val owner = buildOwner()

        val didStart = startOwner(owner, legacyTestCredential())

        assertFalse("el secreto global no es un camino de entrada", didStart)
        assertEquals("y no abre ningun socket", 0, socketFactory.openCount)
        assertEquals(0, owner.startCount)
    }

    /**
     * Regresion del hardware: con el Worker reiniciado el socket no completo el
     * handshake y la sesion queda muerta. Con el `start` idempotente de antes, un
     * socket abierto que no llega a ONLINE dejaba al dueno con una sesion que
     * `start` se negaba a reemplazar, y "Conectar" no hacia nada.
     *
     * La regla que se fija: una sesion CON reintento pendiente NO se toca (si no,
     * se pelea con el backoff y duplica sockets); una sesion parada si.
     */
    @Test
    fun aDeadSessionWithAPendingReconnectIsNotReplacedButOneStoppedIs() {
        val owner = buildOwner()
        startOwner(owner)

        // El socket se abre pero el handshake nunca ocurre: se cae.
        socketFactory.dropSocketAt(1)
        assertTrue(owner.isReconnectPending)
        assertEquals(MobileSessionState.RECONNECTING, owner.currentState)

        assertFalse("con un reintento pendiente, no se toca", startOwner(owner))
        assertEquals("ni se abre un socket nuevo", 1, socketFactory.openCount)

        // `stop` es lo que corta el reintento y suelta la sesion.
        owner.stop()
        assertFalse(owner.isReconnectPending)

        assertTrue("con la sesion liberada, Conectar tiene que arrancar", startOwner(owner))
        assertEquals(2, owner.startCount)
        assertEquals(MobileSessionState.CONNECTING, owner.currentState)
    }

    @Test
    fun aSessionRejectedByTheServerIsReplacedOnTheNextConectar() {
        // El servidor cerro con 1008: reconectar no va a funcionar nunca, asi que
        // esa sesion se reemplaza en vez de quedar ocupando el dueno.
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)

        socketFactory.listenerOf(1).onServerClose(
            DeviceSocketListener.POLICY_VIOLATION_CLOSURE_CODE,
            "credential_revoked"
        )
        assertEquals(MobileSessionState.DISCONNECTED, owner.currentState)

        // Es exactamente lo que hace falta tras un re-enrollment.
        assertTrue(startOwner(owner))

        assertEquals(2, owner.startCount)
        assertEquals(2, socketFactory.openCount)
    }

    /**
     * La otra mitad del bug, y la que se vio en el Moto G35.
     *
     * Cuando el servidor responde `hello_rejected` (no un cierre 1008), la
     * sesion queda DISCONNECTED, NO se agenda reintento y NO es rechazo
     * permanente. Con el `start` viejo, esa sesion ocupaba al dueno para
     * siempre y "Conectar" no hacia nada.
     */
    @Test
    fun aHelloRejectedSessionIsReplacedOnTheNextConectar() {
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)

        // El DO rechaza el hello. Ojo: NO es el cierre 1008 del DO.
        socketFactory.deliverTo(
            1,
            org.json.JSONObject()
                .put("type", "hello_rejected")
                .put("reason", "device_not_enrolled")
                .toString()
        )

        assertEquals(MobileSessionState.DISCONNECTED, owner.currentState)
        assertFalse(
            "un hello_rejected no es rechazo permanente por 1008",
            owner.currentState == MobileSessionState.DISCONNECTED &&
                owner.isReconnectPending
        )
        assertFalse("tampoco quedo un reintento que lo ate", owner.isReconnectPending)

        // Este es el boton que, antes, no hacia nada.
        assertTrue("Conectar tiene que poder reemplazar la sesion muerta", startOwner(owner))

        assertEquals(2, owner.startCount)
        assertEquals(2, socketFactory.openCount)
        assertEquals(MobileSessionState.CONNECTING, owner.currentState)
    }

    @Test
    fun aLiveSessionIsStillNotDuplicated() {
        // La contraparte exacta del caso anterior: no se puede relajar tanto la
        // idempotencia como para abrir un segundo socket sobre uno vivo.
        val owner = buildOwner()
        startOwner(owner)
        acceptHelloAt(1)
        assertEquals(MobileSessionState.ONLINE, owner.currentState)

        assertFalse("una sesion ONLINE no se reemplaza", startOwner(owner))

        assertEquals(1, owner.startCount)
        assertEquals(1, socketFactory.openCount)
    }

    @Test
    fun aConnectingSessionIsAlsoNotDuplicated() {
        // El hueco peligroso: el socket abrio y el hello todavia no volvio.
        val owner = buildOwner()
        startOwner(owner)

        assertFalse("una sesion CONNECTING no se reemplaza", startOwner(owner))

        assertEquals(1, owner.startCount)
        assertEquals(1, socketFactory.openCount)
    }
}
