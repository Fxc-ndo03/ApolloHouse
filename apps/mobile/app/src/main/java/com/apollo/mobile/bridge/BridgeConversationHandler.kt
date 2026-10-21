package com.apollo.mobile.bridge

import com.apollo.mobile.ApolloApplication
import com.apollo.mobile.conversation.ConversationState

/**
 * FASE 6.3 · Etapa 4 — manejador de conversacion del puente.
 *
 * Delegacion honesta: usa [ConversationOwner] (socket separado al Apollo DO,
 * distinto del de capacidades). Solo expone `conversation.send` (texto);
 * `conversation.cancel` no existe en el cliente (se rechaza con
 * [BridgeError.UNSUPPORTED_OPERATION] en vez de fingir que funciona).
 *
 * No fabrica mensajes de asistente: el puente solo reenvia el texto del usuario
 * y devuelve el `turnId` que asigna el cliente, o un error si no hay sesion de
 * conversacion viva.
 */
class BridgeConversationHandler(
    private val application: ApolloApplication,
    private val eventAdapter: ConversationWebEventAdapter? = null,
) {

    fun handle(operation: String, arguments: Map<String, Any?>): BridgeResponse =
        when (operation) {
            "conversation.send" -> handleSend(arguments)
            "conversation.cancel" -> handleCancel()
            else -> BridgeValidator.error(null, BridgeError.UNSUPPORTED_OPERATION)
        }

    private fun handleSend(arguments: Map<String, Any?>): BridgeResponse {
        val conversationOwner = application.conversationOwner
        if (conversationOwner.state != ConversationState.ONLINE) {
            // No hay sesion de conversacion viva: no se puede enviar un turno.
            return BridgeValidator.error(null, BridgeError.UNAVAILABLE)
        }
        val text = arguments["text"] as? String
            ?: return BridgeValidator.error(null, BridgeError.INVALID_ARGUMENTS)
        val turnId = if (eventAdapter != null) eventAdapter.send(text) else conversationOwner.send(text)
        return if (turnId != null) {
            BridgeValidator.ok(null, mapOf("turnId" to turnId))
        } else {
            BridgeValidator.error(null, BridgeError.UNAVAILABLE)
        }
    }

    private fun handleCancel(): BridgeResponse =
        // No existe en el cliente: el backend no soporta cancelar un turno de
        // voz/texto desde el telefono en v1. Se rechaza honestamente.
        BridgeValidator.error(null, BridgeError.UNSUPPORTED_OPERATION)
}
