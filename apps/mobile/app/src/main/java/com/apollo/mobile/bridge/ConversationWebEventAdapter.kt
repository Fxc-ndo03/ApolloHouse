package com.apollo.mobile.bridge

import com.apollo.mobile.conversation.ConversationOwner
import com.apollo.mobile.conversation.ConversationState
import com.apollo.mobile.conversation.ConversationTurn
import com.apollo.mobile.conversation.TurnErrorNotice
import org.json.JSONObject

/** Adapts the existing conversation owner to the closed React event contract. */
class ConversationWebEventAdapter(
    private val owner: ConversationOwner,
    private val emit: (String, String) -> Unit,
    private val onAuthorizationRejected: () -> Unit = {},
) : ConversationOwner.Observer {

    private val emittedAssistantTurnIds = mutableSetOf<String>()
    private val emittedTurnsLock = Any()

    init {
        synchronized(emittedTurnsLock) {
            emittedAssistantTurnIds.addAll(owner.currentTurns().filter {
                it.role == ConversationTurn.TurnRole.APOLLO
            }.map { it.turnId })
        }
        owner.addObserver(this)
    }

    /** Used by both `conversation.send` and final SpeechRecognizer results. */
    fun send(text: String): String? {
        if (owner.state != ConversationState.ONLINE) return null
        emit("orb-state-change", JSONObject.quote("thinking"))
        val turnId = owner.send(text)
        if (turnId == null) emit("orb-state-change", JSONObject.quote("idle"))
        return turnId
    }

    fun release() = owner.removeObserver(this)

    override fun onStateChanged(state: ConversationState) {
        val status = when (state) {
            ConversationState.DISCONNECTED -> "disconnected"
            ConversationState.CONNECTING, ConversationState.AWAITING_HELLO,
            ConversationState.RETRY_WAIT -> "connecting"
            ConversationState.ONLINE -> "connected"
            ConversationState.DENIED -> "error"
        }
        val payload = JSONObject().put("status", status)
        if (state == ConversationState.DENIED) payload.put("error", "Apollo rechazó la autorización.")
        emit("connection-status", payload.toString())
        if (state == ConversationState.DENIED) {
            emitError("not_authorized", "Apollo rechazó la autorización.")
            emit("orb-state-change", JSONObject.quote("error"))
            onAuthorizationRejected()
        }
    }

    override fun onTurnsChanged(turns: List<ConversationTurn>) {
        val completed = synchronized(emittedTurnsLock) {
            turns.filter {
                it.role == ConversationTurn.TurnRole.APOLLO &&
                    it.state == ConversationTurn.TurnState.ANSWERED &&
                    emittedAssistantTurnIds.add(it.turnId)
            }
        }
        completed.forEach { turn ->
            emit("text-response-chunk", JSONObject.quote(turn.text))
            emit("text-response-end", "{}")
            emit("turn-end", "{\"expectsReply\":false}")
            emit("orb-state-change", JSONObject.quote("idle"))
        }
    }

    override fun onTurnError(notice: TurnErrorNotice) {
        emitError(notice.category.name.lowercase(), notice.text)
        emit("orb-state-change", JSONObject.quote("error"))
    }

    private fun emitError(code: String, message: String) {
        emit("error", JSONObject().put("code", code).put("message", message).toString())
    }
}
