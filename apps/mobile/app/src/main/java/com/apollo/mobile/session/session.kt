package com.apollo.mobile.session

import com.apollo.mobile.command.CommandAllowlist
import com.apollo.mobile.command.CommandDispatcher
import com.apollo.mobile.contract.Contract
import com.apollo.mobile.protocol.InboundMessage
import com.apollo.mobile.protocol.InboundParser
import com.apollo.mobile.protocol.OutboundMessage
import com.apollo.mobile.transport.ClientConfig
import com.apollo.mobile.transport.DeviceCredential
import com.apollo.mobile.transport.DeviceSocket
import com.apollo.mobile.transport.DeviceSocketFactory
import com.apollo.mobile.transport.DeviceSocketListener

/**
 * Sesion mobile: handshake, heartbeat, dispatch y reconnect. No conoce registry,
 * target resolver, ToolDefinition ni routing de Apollo.
 */
class MobileSession(
    private val clientConfig: ClientConfig,
    private val deviceSocketFactory: DeviceSocketFactory,
    private val commandDispatcher: CommandDispatcher,
    private val nowMillisecondsPort: () -> Long = { System.currentTimeMillis() }
) {

    private var currentState: MobileSessionState = MobileSessionState.DISCONNECTED

    /**
     * BLOCK 12.5.1: el estado pasa por `transitionTo` para que el dueno de la
     * sesion pueda enterarse. Antes el estado se asignaba en cinco lugares y
     * nadie fuera de la clase podia observarlo, asi que la UI solo podia suponer.
     */
    val state: MobileSessionState
        get() = currentState

    /**
     * Quien observe el estado. Lo setea [MobileSessionOwner].
     *
     * Es un callback y no una lista de listeners porque hay exactamente un
     * dueno; agregar una lista de observers seria ceremonia para un caso que no
     * existe todavia.
     */
    var stateListener: ((MobileSessionState) -> Unit)? = null

    /**
     * BLOCK 12.5.1: el numero de generacion vive en su propia clase.
     *
     * Se extrajo porque `session.kt` estaba cruzando las 300 lineas del limite
     * del proyecto, y porque el concepto es separable de verdad: es "que tan
     * viejo es este socket", no "estado de la sesion".
     */
    private val connectionGeneration = ConnectionGeneration()

    var rejectionReason: String? = null
        private set

    var availableCapabilityList: List<String> = emptyList()
        private set

    var deviceId: String? = null
        private set

    private var credential: DeviceCredential? = null

    val heartbeatScheduler = HeartbeatScheduler()
    private val reconnectBackoff = ReconnectBackoff()

    private var socket: DeviceSocket? = null
    private var hasBeenAuthenticatedOnce = false
    private var shouldStayConnected = false
    /**
     * BLOCK 12 §6: el cierre por `onFailure` tells cuando el servidor rechazo la
     * credencial. Un telefono revocado NO se reintenta nunca mas: reconectar en
     * loop contra una credencial que ya no va a funcionar es un loop infinito
     * que ademas gasta bateria. La app queda esperando un nuevo enrollment.
     */
    private var isAuthorizationPermanentlyRejected = false
    /**
     * El detalle con el que cerro el servidor, para que el onboarding pueda
     * explicar por que. Nunca es el secreto.
     */
    var authorizationRejectionDetail: String? = null
        private set
    private var lastHeartbeatIntervalMilliseconds =
        Contract.FALLBACK_HEARTBEAT_INTERVAL_MILLISECONDS

    /** El planificador de reconnect vive afuera: la sesion solo pide el proximo delay. */
    var reconnectPlanner: ((Long) -> Unit)? = null

    /**
     * BLOCK 12: la sesion recibe una [DeviceCredential], no un string suelto. Asi
     * no hay forma de pasar la credencial individual por el camino del secreto
     * global, que es el bypass que §1 prohibe.
     */
    fun start(deviceId: String, credential: DeviceCredential) {
        this.deviceId = deviceId
        this.credential = credential
        shouldStayConnected = true
        isAuthorizationPermanentlyRejected = false
        authorizationRejectionDetail = null
        connect()
    }

    fun stop() {
        shouldStayConnected = false
        // Se invalida la generacion antes de cerrar: el `onClosed` del socket que
        // se esta cerrando llega despues, y con esto se ignora.
        connectionGeneration.invalidate()
        heartbeatScheduler.stop()
        socket?.close()
        socket = null
        transitionTo(MobileSessionState.DISCONNECTED)
    }

    /**
     * Reconectar con una credencial nueva. La usa el onboarding despues de un
     * enrollment: si el telefono estaba en un loop de reconexion por una
     * credencial revocada, `start` ya lo desmarco y esto es el camino limpio para
     *OKEN volver a intentar con la credencial fresca.
     */
    fun connect(credential: DeviceCredential) {
        this.credential = credential
        isAuthorizationPermanentlyRejected = false
        authorizationRejectionDetail = null
        shouldStayConnected = true
        connect()
    }

    fun connect() {
        val resolvedDeviceId = deviceId
            ?: throw IllegalStateException("el deviceId se resuelve antes de conectar")
        val resolvedCredential = credential
            ?: throw IllegalStateException("la credencial se resuelve antes de conectar")
        if (isAuthorizationPermanentlyRejected) {
            // §5: tras una revocacion el telefono no recupera acceso reconectando.
            transitionTo(MobileSessionState.DISCONNECTED)
            return
        }
        transitionTo(
            if (hasBeenAuthenticatedOnce) {
                MobileSessionState.RECONNECTING
            } else {
                MobileSessionState.CONNECTING
            }
        )
        this.deviceId = resolvedDeviceId
        // El numero de generacion viaja con el listener: es lo que permite
        // descartar los callbacks que lleguen tarde del socket anterior.
        connectionGeneration.invalidate()
        socket = deviceSocketFactory.open(
            clientConfig.buildSocketRequest(resolvedCredential),
            SessionSocketListener(connectionGeneration.read())
        )
    }

    /**
     * El servidor cerro el socket por una razon de autorizacion. Se marca para no
     * reconectar. Los motivos son los que manda el DO en `onConnect`.
     */
    fun onAuthorizationRejected(detail: String) {
        isAuthorizationPermanentlyRejected = true
        authorizationRejectionDetail = detail
        shouldStayConnected = false
        // Igual que en `stop`: revocar tambien invalida la generacion, para que
        // el cierre del socket no dispare una reconexion.
        connectionGeneration.invalidate()
        heartbeatScheduler.stop()
        socket?.close()
        socket = null
        transitionTo(MobileSessionState.DISCONNECTED)
    }

    fun getIsAuthorizationPermanentlyRejected(): Boolean = isAuthorizationPermanentlyRejected

    fun getCredential(): DeviceCredential? = credential

    fun sendHeartbeat() {
        socket?.send(OutboundMessage.buildHeartbeatMessage(nowMillisecondsPort()))
    }

    private fun sendHello() {
        val resolvedDeviceId = deviceId ?: return
        socket?.send(
            OutboundMessage.buildHelloMessage(
                deviceId = resolvedDeviceId,
                announcedCapabilityList = Contract.ANNOUNCED_CAPABILITY_LIST,
                atMilliseconds = nowMillisecondsPort()
            )
        )
    }

    private fun handleAccepted(accepted: InboundMessage.HelloAccepted) {
        availableCapabilityList = accepted.availableCapabilityList
        lastHeartbeatIntervalMilliseconds =
            if (accepted.heartbeatIntervalMilliseconds > 0) {
                accepted.heartbeatIntervalMilliseconds
            } else {
                Contract.FALLBACK_HEARTBEAT_INTERVAL_MILLISECONDS
            }
        transitionTo(MobileSessionState.AUTHENTICATED)
        hasBeenAuthenticatedOnce = true
        rejectionReason = null
        reconnectBackoff.reset()
        heartbeatScheduler.start(lastHeartbeatIntervalMilliseconds) { sendHeartbeat() }
        transitionTo(MobileSessionState.ONLINE)
    }

    private fun handleRejected(rejected: InboundMessage.HelloRejected) {
        rejectionReason = rejected.reason
        transitionTo(MobileSessionState.DISCONNECTED)
        socket?.close()
    }

    private fun handleCommand(command: InboundMessage.Command) {
        val resolvedDeviceId = deviceId ?: return
        // BLOCK 11 §4: si Apollo no mandó comando, se usa el canonico de la
        // capability (el primero del commandList). El peer nunca adivina.
        val resolvedCommandName = command.commandName
            ?: CommandAllowlist.listCommandFor(command.capabilityName).firstOrNull()
        if (resolvedCommandName == null) {
            sendCommandResult(
                command.requestId,
                command.capabilityName,
                wasPosted = false,
                errorDetail = "unsupported_command",
                commandResult = null
            )
            return
        }
        val outcome = commandDispatcher.dispatch(
            CommandDispatcher.DispatchInput(
                deviceId = resolvedDeviceId,
                requestId = command.requestId,
                capabilityName = command.capabilityName,
                commandName = resolvedCommandName,
                payload = command.payload,
                targetDeviceId = command.targetDeviceId,
                isAuthenticated = hasBeenAuthenticatedOnce && state == MobileSessionState.ONLINE
            )
        )
        sendCommandResult(
            command.requestId,
            command.capabilityName,
            wasPosted = outcome is CommandDispatcher.Outcome.Executed,
            errorDetail = (outcome as? CommandDispatcher.Outcome.Rejected)?.reason,
            commandResult = (outcome as? CommandDispatcher.Outcome.Executed)?.result
        )
    }

    private fun sendCommandResult(
        requestId: String,
        capabilityName: String,
        wasPosted: Boolean,
        errorDetail: String?,
        commandResult: Map<String, Any?>?
    ) {
        socket?.send(
            OutboundMessage.buildCommandResultMessage(
                requestId = requestId,
                capabilityName = capabilityName,
                wasPosted = wasPosted,
                errorDetail = errorDetail,
                commandResult = commandResult,
                atMilliseconds = nowMillisecondsPort()
            )
        )
    }

    private fun handleClosed() {
        heartbeatScheduler.stop()
        socket = null
        if (!shouldStayConnected) {
            transitionTo(MobileSessionState.DISCONNECTED)
            return
        }
        transitionTo(MobileSessionState.RECONNECTING)
        reconnectPlanner?.invoke(reconnectBackoff.nextDelayMilliseconds())
    }

    private fun transitionTo(newState: MobileSessionState) {
        currentState = newState
        stateListener?.invoke(newState)
    }

    private inner class SessionSocketListener(private val generation: Int) : DeviceSocketListener {

        /**
         * Un callback de un socket que ya no es el actual no hace nada. Es lo
         * que evita que el cierre tardio del socket viejo tumbe la sesion nueva.
         */
        private fun isFromStaleSocket(): Boolean = connectionGeneration.isStale(generation)

        override fun onOpen() {
            if (isFromStaleSocket()) {
                return
            }
            sendHello()
        }

        override fun onMessage(rawMessageText: String) {
            if (isFromStaleSocket()) {
                return
            }
            when (val inbound = InboundParser.parse(rawMessageText)) {
                is InboundMessage.HelloAccepted -> handleAccepted(inbound)
                is InboundMessage.HelloRejected -> handleRejected(inbound)
                is InboundMessage.Command -> handleCommand(inbound)
                is InboundMessage.HeartbeatProbe -> sendHeartbeat()
                is InboundMessage.Malformed -> Unit
            }
        }

        override fun onClosed() {
            if (isFromStaleSocket()) {
                return
            }
            handleClosed()
        }

        override fun onFailure(detail: String) {
            if (isFromStaleSocket()) {
                return
            }
            handleClosed()
        }

        override fun onServerClose(closeCode: Int, reason: String) {
            if (isFromStaleSocket()) {
                return
            }
            if (closeCode != DeviceSocketListener.POLICY_VIOLATION_CLOSURE_CODE) {
                return
            }
            // El DO cerro con 1008 porque la credencial no servia. Se marca
            // permanente: reconectar daria el mismo resultado, asi que la sesion
            // queda parada esperando un enrollment nuevo.
            onAuthorizationRejected(reason)
        }
    }
}
