package com.apollo.mobile.conversation

import org.json.JSONArray
import org.json.JSONObject

/**
 * Un turno de la conversación, tal como lo ve la persona.
 *
 * `isSecret` no existe a propósito: acá no se guarda ninguna credencial. El
 * historial vive en el almacenamiento de la app y sólo contiene texto que el
 * usuario escribió y texto que Apollo devolvió.
 */
data class ConversationTurn(
    val turnId: String,
    val role: TurnRole,
    val text: String,
    val atMilliseconds: Long,
    val state: TurnState
) {
    enum class TurnRole { USER, APOLLO }

    enum class TurnState {
        /** Enviado, esperando que Apollo responda. */
        SENT,
        /** Apollo respondió. */
        ANSWERED,
        /** El servidor lo rechazó. */
        FAILED
    }
}

/**
 * Historial de la conversación, en memoria y serializable.
 *
 * Se serializa a JSON para poder persistirlo. NO se usa Keystore ni cifrado
 * acá: es texto de conversación, no un secreto, y el usuario tiene que poder
 * leerlo aunque el almacenamiento de la app cambie.
 */
class ConversationHistory(private val maximumTurnCount: Int = 200) {

    private val turnList = mutableListOf<ConversationTurn>()

    val size: Int get() = turnList.size

    fun add(turn: ConversationTurn): ConversationTurn {
        turnList.add(turn)
        // El recorte es por cantidad, no por tiempo: una conversación de un año
        // no debe hacer la app lento, y lo reciente es lo que importa.
        while (turnList.size > maximumTurnCount) {
            turnList.removeAt(0)
        }
        return turn
    }

    fun snapshot(): List<ConversationTurn> = turnList.toList()

    fun clear() {
        turnList.clear()
    }

    /**
     * Actualiza el estado del último turno del usuario. Se busca por `turnId` y
     * no por posición: puede haber un turno de Apollo ya encolado cuando llega la
     * respuesta del anterior.
     */
    fun markAnswered(turnId: String, state: ConversationTurn.TurnState) {
        val index = turnList.indexOfLast { it.turnId == turnId }
        if (index >= 0) {
            turnList[index] = turnList[index].copy(state = state)
        }
    }

    fun findByTurnId(turnId: String): ConversationTurn? =
        turnList.lastOrNull { it.turnId == turnId }

    fun serialize(): String {
        val turnArray = JSONArray()
        for (turn in turnList) {
            turnArray.put(
                JSONObject()
                    .put("turnId", turn.turnId)
                    .put("role", turn.role.name)
                    .put("text", turn.text)
                    .put("at", turn.atMilliseconds)
                    .put("state", turn.state.name)
            )
        }
        return turnArray.toString()
    }

    fun deserialize(serialized: String) {
        turnList.clear()
        val turnArray = runCatching { JSONArray(serialized) }.getOrNull() ?: return
        for (index in 0 until turnArray.length()) {
            val turnJson = turnArray.optJSONObject(index) ?: continue
            val role = runCatching {
                ConversationTurn.TurnRole.valueOf(turnJson.optString("role"))
            }.getOrNull() ?: continue
            val state = runCatching {
                ConversationTurn.TurnState.valueOf(turnJson.optString("state"))
            }.getOrNull() ?: ConversationTurn.TurnState.SENT
            turnList.add(
                ConversationTurn(
                    turnId = turnJson.optString("turnId"),
                    role = role,
                    text = turnJson.optString("text"),
                    atMilliseconds = turnJson.optLong("at"),
                    state = state
                )
            )
        }
        while (turnList.size > maximumTurnCount) {
            turnList.removeAt(0)
        }
    }
}
