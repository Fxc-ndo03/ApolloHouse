package com.apollo.mobile.conversation

import com.apollo.mobile.session.reconnect.ReconnectScheduler
import com.apollo.mobile.transport.DeviceCredential
import com.apollo.mobile.transport.DeviceSocketFactory

/**
 * Dueño único de la sesión de conversación.
 *
 * El mismo patrón que [com.apollo.mobile.session.MobileSessionOwner]: una sola
 * instancia viva, los callbacks de un socket viejo no pueden tocar una sesión
 * nueva, y la Activity sólo observa. Existe porque el servicio en segundo plano
 * y la pantalla compiten por el mismo socket si cada una puede crearlo.
 */
class ConversationOwner(
    private val workerHostPort: () -> String,
    private val isDebugBuild: Boolean,
    private val socketFactory: DeviceSocketFactory,
    private val reconnectScheduler: ReconnectScheduler,
    private val history: ConversationHistory,
    private val nowMillisecondsPort: () -> Long = { System.currentTimeMillis() }
) {

    private var currentSession: ConversationSession? = null
    /** El host con el que se abrió la sesión actual; `null` si nunca. */
    private var hostOfCurrentSession: String? = null

    var stateListener: ((ConversationState) -> Unit)? = null
    var turnListener: ((List<ConversationTurn>) -> Unit)? = null
    var noticeListener: ((String) -> Unit)? = null

    val state: ConversationState
        get() = currentSession?.state ?: ConversationState.DISCONNECTED

    private fun publishHistory() {
        turnListener?.invoke(history.snapshot())
    }

    fun start(deviceId: String, credential: DeviceCredential) {
        val workerHost = workerHostPort()
        // Si el host cambió, la sesión vieja apunta a otra direccion: hay que
        // cerrarla. El historial sobrevive: es memoria de la app, no del host.
        if (hostOfCurrentSession !== null && hostOfCurrentSession != workerHost) {
            stop()
        }
        if (currentSession !== null) {
            // El mismo host: sólo se cambia la credencial/identidad. Reuso el
            // socket abierto si esta sano; si no, `start` de la sesion lo reusa.
            if (this.state !== ConversationState.DISCONNECTED &&
                this.state !== ConversationState.DENIED
            ) {
                return
            }
            stop()
        }
        hostOfCurrentSession = workerHost
        val session = ConversationSession(
            workerHost = workerHost,
            isDebugBuild = isDebugBuild,
            socketFactory = socketFactory,
            reconnectScheduler = reconnectScheduler
        )
        session.stateListener = { nextState ->
            stateListener?.invoke(nextState)
            session.rejectionReason?.let { noticeListener?.invoke(it) }
        }
        session.inboundListener = { inbound ->
            when (inbound.type) {
                ConversationContract.INBOUND_CAPTION -> {
                    val captionText = inbound.caption
                    if (captionText != null) {
                        history.add(
                            ConversationTurn(
                                turnId = inbound.turnId ?: nextLocalTurnId(),
                                role = ConversationTurn.TurnRole.APOLLO,
                                text = captionText,
                                atMilliseconds = nowMillisecondsPort(),
                                state = ConversationTurn.TurnState.ANSWERED
                            )
                        )
                        markLastPendingAnswered()
                        publishHistory()
                    }
                }
                ConversationContract.INBOUND_TTS_END -> {
                    markLastPendingAnswered()
                    publishHistory()
                }
                ConversationContract.INBOUND_TTS_ABORTED -> {
                    markLastPendingAnswered(ConversationTurn.TurnState.FAILED)
                    publishHistory()
                }
                ConversationContract.INBOUND_CONFIRM_REQUEST -> {
                    noticeListener?.invoke(
                        "Apollo pide confirmacion: ${inbound.confirmSummary ?: "sin detalle"}"
                    )
                }
                ConversationContract.INBOUND_ERROR -> {
                    val detail = inbound.errorMessage ?: inbound.errorCode ?: "error"
                    markLastPendingAnswered(ConversationTurn.TurnState.FAILED)
                    noticeListener?.invoke("Apollo rechazo el mensaje: $detail")
                    publishHistory()
                }
            }
        }
        currentSession = session
        session.start(deviceId, credential)
    }

    /** FASE 2.4: motivo del rechazo vigente (sesión de cuenta revocada, etc.). */
    val rejectionReason: String?
        get() = currentSession?.rejectionReason

    fun stop() {
        currentSession?.stop()
        currentSession = null
    }

    fun send(text: String): String? {
        val session = currentSession ?: return null
        val turnId = nextLocalTurnId()
        val wasSent = session.sendText(text, clientTurnId = turnId)
        if (!wasSent) return null
        history.add(
            ConversationTurn(
                turnId = turnId,
                role = ConversationTurn.TurnRole.USER,
                text = text.trim().take(ConversationContract.TEXT_INPUT_MAX_LENGTH),
                atMilliseconds = nowMillisecondsPort(),
                state = ConversationTurn.TurnState.SENT
            )
        )
        publishHistory()
        return turnId
    }

    fun abort() {
        currentSession?.sendAbort()
    }

    fun answerConfirmation(approved: Boolean) {
        currentSession?.sendConfirm(approved)
    }

    private fun markLastPendingAnswered(
        state: ConversationTurn.TurnState = ConversationTurn.TurnState.ANSWERED
    ) {
        val pending = history.snapshot()
            .lastOrNull { it.role == ConversationTurn.TurnRole.USER && it.state == ConversationTurn.TurnState.SENT }
            ?: return
        history.markAnswered(pending.turnId, state)
    }

    private fun nextLocalTurnId(): String = "turn-${nowMillisecondsPort()}"
}
