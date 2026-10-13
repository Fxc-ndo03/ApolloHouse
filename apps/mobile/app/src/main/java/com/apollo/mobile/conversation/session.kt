package com.apollo.mobile.conversation

import com.apollo.mobile.session.reconnect.ReconnectScheduler
import com.apollo.mobile.transport.DeviceCredential
import com.apollo.mobile.transport.DeviceSocket
import com.apollo.mobile.transport.DeviceSocketFactory
import com.apollo.mobile.transport.DeviceSocketListener
import com.apollo.mobile.transport.DeviceSocketRequest

/**
 * Estados de la conversación. Distintos de [com.apollo.mobile.session.MobileSessionState]
 * porque esta sesión va contra otro DO y tiene otros riesgos: acá el rechazo por
 * identidad es terminal de otra manera.
 */
enum class ConversationState {
    DISCONNECTED,
    CONNECTING,
    AWAITING_HELLO,
    ONLINE,
    DENIED,
    RETRY_WAIT
}

/**
 * Sesión de conversación contra el Apollo DO de esta identidad.
 *
 * Es un socket **separado** del de capacidades. No se fusionan porque van a DOs
 * distintos, tienen credenciales por el mismo camino pero permisos distintos, y
 * una caída de uno no debe tumbar al otro: el teléfono puede seguir recibiendo
 * comandos aunque el Worker no esté listo para un turno de voz.
 *
 * Los dos caminos comparten la misma `DeviceSocketFactory` y el mismo
 * `DeviceCredential`, así que la credencial no se duplica ni se expone dos veces.
 */
class ConversationSession(
    private val workerHost: String,
    private val isDebugBuild: Boolean,
    private val socketFactory: DeviceSocketFactory,
    private val reconnectScheduler: ReconnectScheduler,
    private val nowMillisecondsPort: () -> Long = { System.currentTimeMillis() }
) {

    private var currentState: ConversationState = ConversationState.DISCONNECTED
    val state: ConversationState get() = currentState

    var stateListener: ((ConversationState) -> Unit)? = null
    var inboundListener: ((ConversationInbound) -> Unit)? = null

    /** Por qué se cerró, para mostrarlo. Nunca contiene el secreto. */
    var rejectionReason: String? = null
        private set

    private var socket: DeviceSocket? = null
    private var shouldStayConnected = false
    private var deviceId: String? = null
    private var attemptCount = 0

    /**
     * Si el servidor rechazó esta credencial para ESTE Apollo, reconectar en
     * loop no sirve: la identidad no va a cambiar sola. Igual que el cuerpo de
     * capacidades, pero el motivo es de identidad, no de enrollment.
     */
    private var isPermanentlyDenied = false

    val backoffDelayMillisecondList: List<Long> = listOf(
        1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L
    )

    fun start(deviceId: String, credential: DeviceCredential) {
        this.deviceId = deviceId
        this.shouldStayConnected = true
        this.isPermanentlyDenied = false
        connect(credential)
    }

    fun stop() {
        shouldStayConnected = false
        socket?.close()
        socket = null
        transitionTo(ConversationState.DISCONNECTED)
    }

    fun sendText(
        text: String,
        requestId: String? = null,
        clientTurnId: String? = null
    ): Boolean {
        val openSocket = socket ?: return false
        val trimmed = text.trim().take(ConversationContract.TEXT_INPUT_MAX_LENGTH)
        if (trimmed.isEmpty()) return false
        openSocket.send(
            ConversationOutbound.buildTextInputMessage(
                text = trimmed,
                atMilliseconds = nowMillisecondsPort(),
                requestId = requestId,
                clientTurnId = clientTurnId
            )
        )
        return true
    }

    fun sendAbort(): Boolean {
        val openSocket = socket ?: return false
        openSocket.send(ConversationOutbound.buildAbortMessage(nowMillisecondsPort()))
        return true
    }

    fun sendConfirm(approved: Boolean): Boolean {
        val openSocket = socket ?: return false
        openSocket.send(ConversationOutbound.buildConfirmMessage(approved, nowMillisecondsPort()))
        return true
    }

    private fun connect(credential: DeviceCredential) {
        if (!shouldStayConnected || isPermanentlyDenied) return
        val boundDeviceId = deviceId ?: return
        transitionTo(ConversationState.CONNECTING)

        val request = DeviceSocketRequest(
            url = when (credential) {
                is DeviceCredential.AccountSession -> ConversationContract.buildAccountConversationUrl(
                    workerHost = workerHost,
                    accountId = credential.accountId,
                    isDebugBuild = isDebugBuild,
                )
                else -> ConversationContract.buildConversationUrl(
                    workerHost = workerHost,
                    deviceId = boundDeviceId,
                    isDebugBuild = isDebugBuild,
                )
            },
            headerMap = buildHeaderMap(credential),
        )
        val newSocket = socketFactory.open(request, object : DeviceSocketListener {
            override fun onOpen() {
                // El Apollo DO no manda `hello_accepted`: confirma con `ui_state`.
                // Por eso el estado todavía no es ONLINE.
                transitionTo(ConversationState.AWAITING_HELLO)
                socket?.send(
                    ConversationOutbound.buildHelloMessage(boundDeviceId, nowMillisecondsPort())
                )
            }

            override fun onMessage(rawMessageText: String) {
                val inbound = ConversationInbound.parse(rawMessageText) ?: return
                if (inbound.type == ConversationContract.INBOUND_UI_STATE) {
                    transitionTo(ConversationState.ONLINE)
                }
                if (inbound.getIsError) {
                    rejectionReason = inbound.errorMessage ?: inbound.errorCode ?: "error_desconocido"
                }
                inboundListener?.invoke(inbound)
            }

            override fun onServerClose(code: Int, reason: String) {
                // 1008 = policy violation. El Apollo DO la usa cuando la identidad
                // autenticada no es ladueña de esta ruta: reconectar sería un loop.
                if (code == POLICY_VIOLATION_CLOSE_CODE) {
                    isPermanentlyDenied = true
                    rejectionReason = reason.ifEmpty { "identidad_rechazada" }
                    shouldStayConnected = false
                    transitionTo(ConversationState.DENIED)
                    return
                }
                scheduleReconnect(credential)
            }

            override fun onClosed() {
                if (shouldStayConnected && !isPermanentlyDenied) {
                    transitionTo(ConversationState.DISCONNECTED)
                }
            }

            override fun onFailure(reasonDetail: String) {
                rejectionReason = reasonDetail
                scheduleReconnect(credential)
            }
        })
        socket = newSocket
    }

    private fun buildHeaderMap(credential: DeviceCredential): Map<String, String> =
        when (credential) {
            is DeviceCredential.Enrolled -> mapOf(
                "Authorization" to "Bearer ${credential.credential}"
            )
            // La sesión de cuenta viaja igual de privada: header, nunca query.
            is DeviceCredential.AccountSession -> mapOf(
                "Authorization" to "Bearer ${credential.sessionToken}"
            )
            // El camino legacy del PC mete el secreto en la query. El teléfono
            // enrolado NUNCA lo usa: si no tiene credencial, no tiene sesión.
            is DeviceCredential.LegacySharedSecret -> emptyMap()
        }

    private fun scheduleReconnect(credential: DeviceCredential) {
        if (!shouldStayConnected || isPermanentlyDenied) return
        val delay = backoffDelayMillisecondList[
            attemptCount.coerceAtMost(backoffDelayMillisecondList.lastIndex)
        ]
        attemptCount += 1
        transitionTo(ConversationState.RETRY_WAIT)
        reconnectScheduler.scheduleOnce(delay) {
            connect(credential)
        }
    }

    private fun transitionTo(nextState: ConversationState) {
        if (currentState == nextState) return
        currentState = nextState
        stateListener?.invoke(nextState)
    }

    private companion object {
        const val POLICY_VIOLATION_CLOSE_CODE = 1008
    }
}
