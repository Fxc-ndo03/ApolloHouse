package com.apollo.mobile.conversation

import org.json.JSONObject

/**
 * Mensajes de la conversación, construidos desde el schema real del Worker
 * (`apps/agent/src/protocol/schema.ts`). Mismo criterio que
 * `protocol/OutboundMessage`: el `requestId` viaja como vino, no se genera otro.
 */
object ConversationOutbound {

    fun buildHelloMessage(deviceId: String, atMilliseconds: Long): String = JSONObject()
        .put("type", ConversationContract.OUTBOUND_HELLO)
        .put("deviceId", deviceId)
        .put("deviceType", ConversationContract.CONVERSATION_DEVICE_TYPE)
        .put("ts", atMilliseconds)
        .toString()

    /**
     * `text_input`: `{ text: min(1), ts: int>=0 }` y los tres campos de
     * correlación opcionales. El texto se recorta acá porque el schema no lo
     * acota y un texto infinito rompería el servidor.
     */
    fun buildTextInputMessage(
        text: String,
        atMilliseconds: Long,
        requestId: String? = null,
        clientTurnId: String? = null,
        generation: Int? = null
    ): String {
        val trimmed = text.trim().take(ConversationContract.TEXT_INPUT_MAX_LENGTH)
        require(trimmed.isNotEmpty()) { "text_input exige texto no vacio" }
        val message = JSONObject()
            .put("type", ConversationContract.OUTBOUND_TEXT_INPUT)
            .put("text", trimmed)
            .put("ts", atMilliseconds)
        requestId?.let { message.put("request_id", it) }
        clientTurnId?.let { message.put("client_turn_id", it) }
        generation?.let { message.put("generation", it) }
        return message.toString()
    }

    fun buildAbortMessage(atMilliseconds: Long): String = JSONObject()
        .put("type", ConversationContract.OUTBOUND_ABORT)
        .put("ts", atMilliseconds)
        .toString()

    fun buildConfirmMessage(approved: Boolean, atMilliseconds: Long): String = JSONObject()
        .put("type", ConversationContract.OUTBOUND_CONFIRM)
        .put("approved", approved)
        .put("ts", atMilliseconds)
        .toString()

    fun buildListenCancelMessage(atMilliseconds: Long): String = JSONObject()
        .put("type", ConversationContract.OUTBOUND_LISTEN_CANCEL)
        .put("ts", atMilliseconds)
        .toString()
}

/**
 * Lectura defensiva de lo que manda el servidor. Un campo desconocido no
 * rompe: `schema.ts` va a agregar tipos y el teléfono no debe caerse por eso.
 */
data class ConversationInbound(
    val type: String,
    val caption: String? = null,
    val errorCode: String? = null,
    val errorMessage: String? = null,
    val uiState: String? = null,
    val confirmId: String? = null,
    val confirmSummary: String? = null,
    val turnId: String? = null
) {
    val getIsError: Boolean get() = type == ConversationContract.INBOUND_ERROR

    companion object {
        fun parse(rawMessageText: String): ConversationInbound? {
            val json = runCatching { JSONObject(rawMessageText) }.getOrNull() ?: return null
            val type = json.optString("type").takeIf { it.isNotEmpty() } ?: return null
            return ConversationInbound(
                type = type,
                caption = json.optStringOrNull("caption") ?: json.optStringOrNull("text"),
                errorCode = json.optStringOrNull("code"),
                errorMessage = json.optStringOrNull("message"),
                uiState = json.optStringOrNull("state"),
                confirmId = json.optStringOrNull("confirmId") ?: json.optStringOrNull("id"),
                confirmSummary = json.optStringOrNull("summary"),
                turnId = json.optStringOrNull("turnId") ?: json.optStringOrNull("request_id")
            )
        }

        /** `optString` devuelve `""` para un ausente: eso no es un valor. */
        private fun JSONObject.optStringOrNull(fieldName: String): String? =
            if (has(fieldName) && !isNull(fieldName)) optString(fieldName).takeIf { it.isNotEmpty() }
            else null
    }
}
