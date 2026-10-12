package com.apollo.mobile.session

import com.apollo.mobile.session.reconnect.ReconnectScheduler
import com.apollo.mobile.session.reconnect.ReconnectTask
import com.apollo.mobile.session.reconnect.SystemReconnectScheduler
import com.apollo.mobile.session.reconnect.resolveReconnectDelayMilliseconds
import com.apollo.mobile.transport.DeviceCredential

/**
 * BLOCK 12.5.1: el unico dueno del ciclo de vida de la sesion.
 *
 * Que la sesion viviera en una variable local de `MainActivity.connect()` era
 * un accidente con dos consecuencias concretas:
 *
 *  1. Dos pulsaciones de "Conectar" creaban dos sesiones y dos sockets. Cada
 *     una con su propio heartbeat, y los comandos podian ejecutarse dos veces.
 *  2. No habia nadie que cerrara la sesion. `reconnectPlanner` se declaraba y se
 *     invocaba, pero no lo asignaba nadie en todo el repo: cuando el socket se
 *     caia, `handleClosed` calculaba el backoff y lo tiraba a la basura. O sea,
 *     que reconexion no habia, ni en primer plano.
 *
 * Esta clase es el dueno explicito. El alcance es deliberadamente pequeno:
 * arranca, observa, detiene y libera. No sabe de UI, ni de Activity, ni de
 * notificaciones.
 *
 * Que NO sea un singleton de Kotlin: vive en `ApolloApplication`, que en Android
 * es el dueno correcto del ciclo de vida del proceso. Asi el test puede
 * construir uno por test con un scheduler falso.
 */
open class MobileSessionOwner(
    private val sessionFactory: () -> MobileSession,
    private val reconnectScheduler: ReconnectScheduler = SystemReconnectScheduler,
    private val randomPort: () -> Double = { Math.random() }
) {

    private var session: MobileSession? = null
    private var wasReleased: Boolean = false
    private var pendingReconnectTask: ReconnectTask? = null
    private var listenerList: MutableList<SessionListener> = mutableListOf()

    /** El estado actual de la sesion, o `null` si no hay ninguna. */
    val currentState: MobileSessionState?
        get() = session?.state

    val isConnected: Boolean
        get() = currentState == MobileSessionState.ONLINE

    /** Cuantas veces se abrio un socket. Sirve para probar que no se duplica. */
    var startCount: Int = 0
        private set

    var reconnectCount: Int = 0
        private set

    /** Si hay un reintento esperando su momento. */
    val isReconnectPending: Boolean
        get() = pendingReconnectTask != null

    /**
     * Si una sesion ocupada se puede reemplazar por una nueva.
     *
     * Solo se reemplaza cuando ya no esta sirviendo: o la rechazo el servidor de
     * forma permanente (1008), o cayo a DISCONNECTED sin reintento pendiente.
     *
     * Una sesion en CONNECTING, RECONNECTING, AUTHENTICATED u ONLINE NO se
     * toca: ese es el caso que evita dos sockets cuando el usuario aprieta
     * "Conectar" dos veces.
     *
     * El caso de "DISCONNECTED sin reintento" es el que aparecio en el Moto G35:
     * el Worker se habia reiniciado, el socket no pudo completar el handshake,
     * la sesion cayo a DISCONNECTED pero NO fue rechazo permanente, y `start`
     * devolvia false para siempre. La UI decia "ya estas conectado" con el
     * telefono desconectado y sin forma de reintentar.
     */
    private fun isRestartable(currentSession: MobileSession): Boolean {
        if (currentSession.getIsAuthorizationPermanentlyRejected()) {
            return true
        }
        return currentSession.state == MobileSessionState.DISCONNECTED && !isReconnectPending
    }

    /**
     * Arranca la sesion, o no hace nada si ya hay una viva.
     *
     * Idempotente a proposito: es lo que evita el segundo socket cuando el
     * usuario aprieta "Conectar" dos veces, o cuando la Activity se recrea por
     * rotacion y el `onCreate` vuelve a pedir la sesion.
     *
     * BLOCK 12.5.2: la excepcion es una sesion rechazada de forma permanente. El
     * servidor la cerro con 1008 y reconectar no va a volver a funcionar nunca,
     * asi que esa sesion esta MUERTA de verdad y se reemplaza: es lo que permite
     * volver a conectar despues de un re-enrollment sin reiniciar la app. Sin
     * esto, `start` devolvia false para siempre y la UI decia "ya estas
     * conectado" con el telefono desconectado.
     *
     * Devuelve `false` si no arranco, para que la UI pueda decirlo en vez de
     * fingir que conecto.
     */
    open fun start(deviceId: String, credential: DeviceCredential): Boolean {
        if (wasReleased) {
            return false
        }
        val currentSession = session
        if (currentSession != null) {
            if (!isRestartable(currentSession)) {
                return false
            }
            // La sesion previa esta MUERTA (o muerta): se suelta para
            // que este `start` pueda abrir un socket limpio en vez de quedar
            // trabado con un boton que ya no hace nada.
            cancelPendingReconnect()
            currentSession.stop()
            session = null
        }
        // Solo la credencial enrolada. El secreto global no es un fallback: es
        // exactamente lo que el servidor rechaza para un movil no enrolado
        // (`device_not_enrolled`). Dejarlo como plan B seria un camino que
        // existe solo para fallar.
        if (credential !is DeviceCredential.Enrolled) {
            return false
        }
        val newSession = sessionFactory()
        newSession.reconnectPlanner = ::scheduleReconnect
        newSession.stateListener = ::publishState
        session = newSession
        newSession.start(deviceId, credential)
        startCount += 1
        return true
    }

    /**
     * Registra un observador del estado. Se usa para que la UI refleje la
     * sesion sin ser su duena.
     */
    open fun observe(listener: SessionListener) {
        listenerList.add(listener)
        session?.let { listener.onStateChanged(it.state) }
    }

    open fun unobserve(listener: SessionListener) {
        listenerList.remove(listener)
    }

    /**
     * Desconexion manual: el usuario dejo de querer estar conectado.
     *
     * Cancela el reintento pendiente, corta el socket y suelta la referencia de
     * la sesion. Soltar la referencia es parte del contrato, no un detalle: si
     * `start` la comprobara y la dejara puesta, apagar y volver a encender no
     * tendria efecto, que es justo lo contrario de lo que el boton promete.
     */
    open fun stop() {
        cancelPendingReconnect()
        session?.stop()
        session = null
    }

    /**
     * Cierre definitivo: ademas de [stop], suelta los observadores y marca al
     * dueno como liberado. Un dueno liberado no vuelve a arrancar; para eso esta
     * `stop`.
     */
    open fun release() {
        stop()
        listenerList.clear()
        wasReleased = true
    }

    /** Si el dueno ya fue liberado. Un dueno liberado no arranca de nuevo. */
    open val isReleased: Boolean
        get() = wasReleased

    /**
     * Programa una reconexion. La primera vez que el socket se cae.
     *
     * El scheduler se inyecta por constructor: con el real (`Handler` del looper
     * principal) espera de verdad; con el falso de los tests, el test decide
     * cuando se cumple. Endurecerlo a `SystemReconnectScheduler` aca romperia
     * toda la bateria de tests de reconexion.
     */
    open fun scheduleReconnect(delayMilliseconds: Long) {
        // Un reintento pendiente se reemplaza, no se acumula: si el socket se cae
        // dos veces seguidas no puede quedar agendadas dos reconexiones.
        cancelPendingReconnect()
        pendingReconnectTask = reconnectScheduler.scheduleOnce(
            resolveReconnectDelayMilliseconds(delayMilliseconds, randomPort)
        ) {
            pendingReconnectTask = null
            val activeSession = session ?: return@scheduleOnce
            if (activeSession.getIsAuthorizationPermanentlyRejected()) {
                // Una revocacion no se reintenta jamas: el mismo resultado con
                // mas bateria gastada.
                return@scheduleOnce
            }
            reconnectCount += 1
            activeSession.connect()
        }
    }

    private fun cancelPendingReconnect() {
        pendingReconnectTask?.let { reconnectScheduler.cancel(it) }
        pendingReconnectTask = null
    }

    private fun publishState(state: MobileSessionState) {
        // Copia defensiva: si un listener se da de baja mientras se notifica, la
        // lista que se esta recorriendo no debe cambiar debajo.
        for (listener in listenerList.toList()) {
            listener.onStateChanged(state)
        }
    }

    /** Quien quiera observar el estado sin ser el dueno. */
    interface SessionListener {
        fun onStateChanged(state: MobileSessionState)
    }
}
