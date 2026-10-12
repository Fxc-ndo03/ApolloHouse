package com.apollo.mobile.conversation

import com.apollo.mobile.contract.Contract
import com.apollo.mobile.transport.resolveIsSecureTransport

/**
 * Contrato de wire de la conversación con el Apollo DO.
 *
 * Es OTRO protocolo que el de capacidades. El de capacidades va contra
 * `MobileBridge` ([Contract.MOBILE_BRIDGE_PATH]) y sólo transporta
 * `hello`/`heartbeat`/`command_result`. Este va contra el DO `Apollo`, que es
 * donde vive el turno de conversación, y comparte el vocabulario de
 * `apps/agent/src/protocol/schema.ts` (`deviceToServerMessageSchema`).
 *
 * No se inventa ningún mensaje: cada constante de acá tiene su `z.literal` en el
 * schema del Worker. Lo que no existe en el Worker no se manda.
 */
object ConversationContract {

    /** Plantilla de la ruta del Apollo DO de una identidad. */
    const val APOLLO_AGENT_NAME: String = "apollo"

    /** Un Apollo DO por identidad: `/agents/apollo/<deviceId>`. */
    fun buildConversationPath(deviceId: String): String =
        "/agents/$APOLLO_AGENT_NAME/${java.net.URLEncoder.encode(deviceId, "UTF-8")}"

    /**
     * URL completa del socket de conversación.
     *
     * El esquema no se elige acá: lo decide la misma función que ya usa el
     * cuerpo de capacidades ([resolveIsSecureTransport]), para que las dos rutas
     * no puedan discrepar. En debug cae a `ws` sólo contra loopback; contra una
     * IP de LAN exige TLS, igual que el resto de la app.
     */
    fun buildConversationUrl(workerHost: String, deviceId: String, isDebugBuild: Boolean): String {
        val scheme = if (resolveIsSecureTransport(workerHost, isDebugBuild)) "wss" else "ws"
        return "$scheme://$workerHost${buildConversationPath(deviceId)}"
    }

    /**
     * El DO Apollo espera `deviceType` para distinguir un cuerpo de un escritorio.
     * Un teléfono que llega por esta ruta sigue siendo `mobile`: enrollarse con
     * credencial individual no convierte al teléfono en un escritorio.
     */
    const val CONVERSATION_DEVICE_TYPE: String = "mobile"

    /** `text_input.text` es `z.string().min(1)` sin max; el recorte es del cliente. */
    const val TEXT_INPUT_MAX_LENGTH: Int = 4_000

    /** `schema.ts`: `hello` exige `ts` entero no negativo. */
    const val PROTOCOL_VERSION: Int = Contract.PROTOCOL_VERSION

    // ---- tipos que el cliente envia (deviceToServerMessageSchema) ----

    const val OUTBOUND_HELLO: String = "hello"
    const val OUTBOUND_TEXT_INPUT: String = "text_input"
    const val OUTBOUND_ABORT: String = "abort"
    const val OUTBOUND_CONFIRM: String = "confirm"
    const val OUTBOUND_LISTEN_CANCEL: String = "listen_cancel"

    // ---- tipos que el servidor manda (serverToDeviceMessageSchema) ----

    const val INBOUND_ERROR: String = "error"
    const val INBOUND_UI_STATE: String = "ui_state"
    const val INBOUND_CAPTION: String = "caption"
    const val INBOUND_TTS_START: String = "tts_start"
    const val INBOUND_TTS_END: String = "tts_end"
    const val INBOUND_TTS_ABORTED: String = "tts_aborted"
    const val INBOUND_CONFIRM_REQUEST: String = "confirm_request"
    const val INBOUND_CONFIRM_CLOSE: String = "confirm_close"

    /** Tag de conexión que el Apollo DO exige para procesar mensajes. */
    const val DEVICE_CONNECTION_TAG: String = "device"

    /** Rol nuevo para un nodo enrolado que habla por el Apollo DO. */
    const val ENROLLED_DEVICE_ROLE: String = "enrolled_device"
}
