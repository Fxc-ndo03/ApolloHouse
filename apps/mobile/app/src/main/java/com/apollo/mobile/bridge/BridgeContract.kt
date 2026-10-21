package com.apollo.mobile.bridge

import com.apollo.mobile.contract.Contract
import com.apollo.mobile.conversation.ConversationContract

/**
 * FASE 6.3 · Etapa 4 — contrato del puente React <-> Kotlin.
 *
 * Especificacion: `docs/02-contrato-puente.md` §3. No existe implementacion previa;
 * este archivo la materializa como una lista cerrada y validada en Kotlin.
 *
 * El puente nunca expone `sessionToken`, credenciales de enrolamiento, `Context`,
 * `Activity`, `WebView`, ni `SharedPreferences` a JavaScript. Cada operacion
 * permitida esta en [ALLOWED_OPERATIONS]; cualquier otra recibe
 * [BridgeError.UNSUPPORTED_OPERATION].
 *
 * Formato de mensaje (JS -> Kotlin y Kotlin -> JS), siempre JSON:
 *   request : { contractVersion, operation, arguments, requestId }
 *   response: { ok, data?, error?, requestId }
 *
 * La respuesta viaja de vuelta a la WebView mediante `webView.postMessage` desde
 * [ApolloNativeBridge]; la WebView la recibe en un listener de evento `message`
 * en JavaScript (Etapa 5).
 */

const val BRIDGE_CONTRACT_VERSION: Int = 1

/** Origen unico del contenido empaquetado, servido por WebViewAssetLoader. */
const val ALLOWED_ORIGIN: String = "https://appassets.androidplatform.net"

/** Limite de tamano de un mensaje de puente (evita abusos por mensaje masivo). */
const val MAX_MESSAGE_BYTES: Int = 64 * 1024

/**
 * Operaciones explicitamente permitidas. Cualquier operación no listada aqui se
 * rechaza con [BridgeError.UNSUPPORTED_OPERATION]. No hay lookup dinamico ni
 * reflection: el conjunto es estatico y se revisa a mano.
 */
val ALLOWED_OPERATIONS: Set<String> = setOf(
    // Autenticacion de cuenta (cuentas/do.ts, auth/routes.ts — EXISTE).
    "auth.register",
    "auth.login",
    "auth.logout",
    "auth.state",
    "auth.verify",
    // Dispositivo y capacidades (contract/contract.kt, session/owner.kt — EXISTE).
    "device.identity",
    "capabilities.list",
    "capabilities.state",
    // Conversacion (conversation/owner.kt — PARCIAL: solo texto, sin cancelar).
    "conversation.send",
    "conversation.cancel",
    // Notificaciones (notification/ — PARCIAL: existe el adaptador, sin invocacion local previa).
    "notification.post",
    // Ajustes (persistencia local en SharedPreferences, con allowlist de escritura).
    "settings.read",
    "settings.write",
    // Actualizaciones (updates/UpdateOwner.kt — comprobación e instalación nativas).
    "updates.check",
    "updates.install",
    // Voz (SpeechRecognizer local, captura puntual con acción explícita de usuario).
    "voice.start",
    "voice.stop",
)

/** Codos de error normalizados en ingles (docs/02-contrato-puente.md §2). Nunca
 * se envian motivos nativos en español a JavaScript. */
object BridgeError {
    const val INVALID_ARGUMENTS = "invalid_arguments"
    const val NOT_AUTHENTICATED = "not_authenticated"
    const val NOT_CONNECTED = "not_connected"
    const val INVALID_CREDENTIALS = "invalid_credentials"
    const val EMAIL_TAKEN = "email_taken"
    const val INVALID_INPUT = "invalid_input"
    const val PERMISSION_DENIED = "permission_denied"
    const val UNSUPPORTED_OPERATION = "unsupported_operation"
    const val INTERNAL_ERROR = "internal_error"
    const val UNAVAILABLE = "unavailable"
}

/** Eventos nativos permitidos por `docs/apollo-android-listo/07-contrato-puente-final.md`. */
object BridgeEventContract {
    val ALLOWED_NAMES: Set<String> = setOf(
        "text-response-chunk",
        "text-response-end",
        "turn-end",
        "error",
        "orb-state-change",
        "connection-status",
        "update://progress",
        "update://ready",
        "update://status",
        "alarm-ring",
    )

    /** Construye una llamada JS segura; un nombre ajeno a la lista se descarta. */
    fun javascriptInvocation(name: String, payloadJson: String): String? {
        if (name !in ALLOWED_NAMES) return null
        return "window.__apolloEvent(${org.json.JSONObject.quote(name)}, ${org.json.JSONObject.quote(payloadJson)})"
    }
}

/** Peticion entrante del puente. */
data class BridgeRequest(
    val operation: String,
    val arguments: Map<String, Any?>,
    val requestId: String?,
)

/** Respuesta de salida del puente. */
data class BridgeResponse(
    val ok: Boolean,
    val data: Map<String, Any?>? = null,
    val error: String? = null,
    val requestId: String? = null,
) {
    fun toJson(): String {
        val json = org.json.JSONObject()
        json.put("ok", ok)
        data?.let { json.put("data", org.json.JSONObject(it)) }
        error?.let { json.put("error", error) }
        requestId?.let { json.put("requestId", requestId) }
        return json.toString()
    }
}

/** Resultado de parsear y validar una peticion entrante. */
sealed class BridgeRequestResult {
    data class Valid(val request: BridgeRequest) : BridgeRequestResult()
    data class Invalid(val error: String, val requestId: String?) : BridgeRequestResult()
}

/**
 * Validador de la estructura de la peticion y de los argumentos de cada
 * operacion. Nunca confia en la entrada de JavaScript: valida tipos, rangos,
 * longitudes y rechaza campos extra. Los mensajes de error no revelan el
 * valor recibido (para no registrar datos sensibles).
 */
object BridgeValidator {

    private val EMAIL_REGEX = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")

    // Longitudes de argumento (docs/02-contrato-puente.md §3, contract/contract.kt).
    private const val EMAIL_MAX_LENGTH = 320
    private const val PASSWORD_MIN_LENGTH = 10
    private const val PASSWORD_MAX_LENGTH = 256
    private const val TEXT_INPUT_MAX_LENGTH = ConversationContract.TEXT_INPUT_MAX_LENGTH

    fun parseRequest(raw: String): BridgeRequestResult {
        if (raw.isEmpty() || raw.length > MAX_MESSAGE_BYTES) {
            return BridgeRequestResult.Invalid(BridgeError.INVALID_ARGUMENTS, null)
        }
        val json = runCatching { org.json.JSONObject(raw) }.getOrNull()
            ?: return BridgeRequestResult.Invalid(BridgeError.INVALID_ARGUMENTS, null)

        val operation = json.optString("operation").takeIf { it.isNotEmpty() }
            ?: return BridgeRequestResult.Invalid(BridgeError.INVALID_ARGUMENTS, null)
        if (operation !in ALLOWED_OPERATIONS) {
            return BridgeRequestResult.Invalid(BridgeError.UNSUPPORTED_OPERATION, null)
        }

        val requestId = json.optString("requestId").takeIf { it.isNotEmpty() }
            ?: return BridgeRequestResult.Invalid(BridgeError.INVALID_ARGUMENTS, null)

        // contractVersion, si viene, debe ser 1.
        val contractVersion = json.optInt("contractVersion", -1)
        if (contractVersion != -1 && contractVersion != BRIDGE_CONTRACT_VERSION) {
            return BridgeRequestResult.Invalid(BridgeError.INVALID_ARGUMENTS, requestId)
        }

        val arguments = readArguments(json.optJSONObject("arguments"))
        return BridgeRequestResult.Valid(BridgeRequest(operation, arguments, requestId))
    }

    private fun readArguments(argumentsJson: org.json.JSONObject?): Map<String, Any?> {
        if (argumentsJson == null) return emptyMap()
        val map = mutableMapOf<String, Any?>()
        val keys = argumentsJson.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            map[key] = argumentsJson.get(key)
        }
        return map
    }

    /** Valida los argumentos de una operacion permitida. */
    fun validateArguments(request: BridgeRequest): BridgeRequestResult {
        return when (request.operation) {
            "auth.register", "auth.login" -> validateAuthCredentials(request)
            "auth.logout", "auth.state", "auth.verify" -> validateNoArguments(request)
            "device.identity", "capabilities.list", "capabilities.state" -> validateNoArguments(request)
            "conversation.send" -> validateConversationSend(request)
            "conversation.cancel" -> validateNoArguments(request)
            "notification.post" -> validateNotificationPost(request)
            "updates.check" -> validateNoArguments(request)
            "updates.install" -> validateNoArguments(request)
            "voice.start", "voice.stop" -> validateNoArguments(request)
            "settings.read" -> validateNoArguments(request)
            "settings.write" -> validateSettingsWrite(request)
            else -> BridgeRequestResult.Invalid(BridgeError.UNSUPPORTED_OPERATION, request.requestId)
        }
    }

    private fun validateSettingsWrite(request: BridgeRequest): BridgeRequestResult {
        if (request.arguments.keys != setOf("patch")) {
            return BridgeRequestResult.Invalid(BridgeError.INVALID_ARGUMENTS, request.requestId)
        }
        val patch = when (val rawPatch = request.arguments["patch"]) {
            is org.json.JSONObject -> {
                val values = mutableMapOf<String, Any?>()
                val keys = rawPatch.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    values[key] = rawPatch.get(key)
                }
                values
            }
            is Map<*, *> -> {
                if (rawPatch.keys.any { it !is String }) {
                    return BridgeRequestResult.Invalid(BridgeError.INVALID_ARGUMENTS, request.requestId)
                }
                rawPatch.entries.associate { it.key as String to it.value }
            }
            else -> return BridgeRequestResult.Invalid(BridgeError.INVALID_ARGUMENTS, request.requestId)
        }
        return BridgeRequestResult.Valid(request.copy(arguments = mapOf("patch" to patch)))
    }

    private fun validateNoArguments(request: BridgeRequest): BridgeRequestResult {
        if (request.arguments.isNotEmpty()) {
            return BridgeRequestResult.Invalid(BridgeError.INVALID_ARGUMENTS, request.requestId)
        }
        return BridgeRequestResult.Valid(request)
    }

    private fun validateAuthCredentials(request: BridgeRequest): BridgeRequestResult {
        val email = request.arguments["email"]
        val password = request.arguments["password"]
        if (email !is String || email.isEmpty() || email.length > EMAIL_MAX_LENGTH || !EMAIL_REGEX.matches(email)) {
            return BridgeRequestResult.Invalid(BridgeError.INVALID_ARGUMENTS, request.requestId)
        }
        if (password !is String || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
            return BridgeRequestResult.Invalid(BridgeError.INVALID_ARGUMENTS, request.requestId)
        }
        return BridgeRequestResult.Valid(request)
    }

    private fun validateConversationSend(request: BridgeRequest): BridgeRequestResult {
        val text = request.arguments["text"]
        if (text !is String || text.isEmpty() || text.length > TEXT_INPUT_MAX_LENGTH) {
            return BridgeRequestResult.Invalid(BridgeError.INVALID_ARGUMENTS, request.requestId)
        }
        return BridgeRequestResult.Valid(request)
    }

    private fun validateNotificationPost(request: BridgeRequest): BridgeRequestResult {
        val title = request.arguments["title"]
        val body = request.arguments["body"]
        val titleStr = title.takeIf { it is String && it.isNotEmpty() && it.length <= 120 }
            ?: return BridgeRequestResult.Invalid(BridgeError.INVALID_ARGUMENTS, request.requestId)
        val bodyStr = body.takeIf { it is String && it.isNotEmpty() && it.length <= 500 }
            ?: return BridgeRequestResult.Invalid(BridgeError.INVALID_ARGUMENTS, request.requestId)
        return BridgeRequestResult.Valid(
            BridgeRequest(request.operation, mapOf("title" to titleStr, "body" to bodyStr), request.requestId)
        )
    }

    /** Respuesta de exito. */
    fun ok(requestId: String?, data: Map<String, Any?>? = null): BridgeResponse =
        BridgeResponse(ok = true, data = data, requestId = requestId)

    /** Respuesta de error. */
    fun error(requestId: String?, code: String): BridgeResponse =
        BridgeResponse(ok = false, error = code, requestId = requestId)

    /** Asocia la respuesta de un handler con la petición que la originó. */
    fun correlate(response: BridgeResponse, requestId: String?): BridgeResponse =
        response.copy(requestId = requestId)
}
