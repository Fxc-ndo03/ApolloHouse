package com.apollo.mobile.bridge

import android.net.Uri
import android.app.Activity
import android.os.Handler
import android.util.Log
import android.os.Looper
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebMessageCompat
import com.apollo.mobile.ApolloApplication
import com.apollo.mobile.AccountAuthCredentialResolver
import com.apollo.mobile.identity.AccountAuthClient
import com.apollo.mobile.identity.AccountSessionValidation
import com.apollo.mobile.identity.AccountSessionStore
import com.apollo.mobile.webview.ApolloWebNavigationPolicy
import java.util.concurrent.Executors

/**
 * FASE 6.3 · Etapa 4 — puente React <-> Kotlin.
 *
 * Unico punto de entrada de mensajes desde la WebView. No usa
 * [addJavascriptInterface] (prohibido: expone el objeto a toda pagina cargada y
 * permite reflection arbitraria). En su lugar usa
 * [WebViewCompat.addWebMessageListener], que solo entrega mensajes cuyo origen
 * esta en la allowlist y cuyo marco es el principal.
 *
 * Flujo de un mensaje:
 *   1. JS envia `window.ApolloNative.postMessage(JSON, ALLOWED_ORIGIN)`.
 *   2. `onPostMessage` recibe `(message, sourceUrl, isMainFrame, replyProxy)` en
 *      el hilo UI.
 *   3. Se valida origen + marco principal.
 *   4. Se parsea, valida y despacha en un executor en segundo plano (las
 *      operaciones de auth son HTTP bloqueante y nunca tocan el hilo UI).
 *   5. La respuesta JSON se publica de vuelta mediante
 *      [replyProxy.postMessage] (desde hilo UI).
 *   6. JS la recibe en un listener de evento `message` (Etapa 5) y resuelve la
 *      promesa del `requestId`.
 *
 * Nunca expone el token de sesion, credenciales ni Context a JavaScript.
 */
class ApolloNativeBridge(
    private val application: ApolloApplication,
    private val context: android.content.Context,
    private val webView: WebView,
) {

    private val mainThreadPoster: (Runnable) -> Unit = {
        Handler(Looper.getMainLooper()).post(it)
    }

    private val backgroundExecutor = Executors.newSingleThreadExecutor()
    private val accountAuthClient = AccountAuthClient(application.workerHost)
    private val accountSessionStore = AccountSessionStore(context)
    private val conversationEvents = ConversationWebEventAdapter(
        application.conversationOwner,
        ::emitToWeb,
        onAuthorizationRejected = ::verifySessionAfterConversationRejection,
    )
    private val audioPlayer = AndroidPcmAudioPlayer(context)
    private val authHandler = BridgeAuthHandler(
        accountAuthClient = accountAuthClient,
        accountSessionStore = accountSessionStore,
        onSessionAuthenticated = { accountId, sessionToken ->
            mainThreadPoster { startAuthenticatedConversation(accountId, sessionToken) }
        },
        onSessionCleared = {
            mainThreadPoster { stopAuthenticatedConnections() }
        },
    )
    private val voiceController = (context as? Activity)?.let { activity ->
        AndroidVoiceRecognitionController(activity, { text ->
            conversationEvents.send(text) != null
        }, ::emitToWeb)
    }
    private val conversationHandler: BridgeConversationHandler =
        BridgeConversationHandler(application, conversationEvents)
    private val capabilityHandler: BridgeCapabilityHandler =
        BridgeCapabilityHandler(
            application,
            context,
            eventEmitter = ::emitToWeb,
            voiceOperation = { operation ->
                when (operation) {
                    "voice.start" -> voiceController?.start()
                    "voice.stop" -> voiceController?.stop()
                }
            },
        )

    init {
        application.conversationOwner.addObserver(audioPlayer)
    }

    /**
     * Entrada desde la WebView. Se invoca en el hilo de UI.
     *
     * @param messageJson cuerpo JSON de la peticion (extraído de [WebMessageCompat.data]).
     * @param sourceUrl origen de la pagina que envio el mensaje.
     * @param isMainFrame verdadero solo si proviene del marco principal (no subframes).
     * @param replyProxy proxy para enviar la respuesta de vuelta a JS.
     */
    fun handlePostMessage(
        messageJson: String,
        sourceUrl: String,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        // vuelve a comprobar en Kotlin. Nunca se procesa un mensaje de subframe
        // ni de origen inesperado.
        if (!isMainFrame || !ApolloWebNavigationPolicy.isAllowedUrl(sourceUrl)) {
            replyProxy.postMessage(BridgeValidator.error(null, BridgeError.INVALID_ARGUMENTS).toJson())
            return
        }

        backgroundExecutor.execute {
            try {
                val response = buildResponse(messageJson)
                val responseJson = response.toJson()
                mainThreadPoster {
                    replyProxy.postMessage(responseJson)
                }
            } catch (e: Throwable) {
                Log.e("ApolloNativeBridge", "handler exception type=${e.javaClass.simpleName}")
                val errorJson = BridgeValidator.error(null, BridgeError.INTERNAL_ERROR).toJson()
                mainThreadPoster { replyProxy.postMessage(errorJson) }
            }
        }
    }

    /** Libera recursos del puente (llamado en onDestroy de la actividad). */
    fun release() {
        conversationEvents.release()
        application.conversationOwner.removeObserver(audioPlayer)
        audioPlayer.release()
        voiceController?.destroy()
        backgroundExecutor.shutdown()
    }

    /** Replays only the current connection state after the local React page is ready. */
    fun syncConversationState() {
        conversationEvents.onStateChanged(application.conversationOwner.state)
    }

    fun onRequestPermissionsResult(requestCode: Int, grantResults: IntArray) {
        voiceController?.onRequestPermissionsResult(requestCode, grantResults)
    }

    /** Emits only allowlisted events and always evaluates JavaScript on main. */
    internal fun emitToWeb(name: String, payloadJson: String) {
        val invocation = BridgeEventContract.javascriptInvocation(name, payloadJson) ?: return
        mainThreadPoster { webView.evaluateJavascript(invocation, null) }
    }

    /** Starts the existing account-authenticated conversation socket after native validation. */
    private fun startAuthenticatedConversation(accountId: String, sessionToken: String) {
        val owner = application.conversationOwner
        if (owner.state != com.apollo.mobile.conversation.ConversationState.DISCONNECTED) return
        val deviceId = application.identityStore.resolveStableDeviceId()
        val credential = AccountAuthCredentialResolver.resolveForAccount(
            accountId = accountId,
            sessionToken = sessionToken,
            enrolledCredential = application.credentialStore.readEnrolledCredential(),
        )
        owner.start(deviceId = deviceId, credential = credential)
    }

    private fun stopAuthenticatedConnections() {
        application.conversationOwner.stop()
        application.sessionOwner.stop()
    }

    /** A 1008 conversation rejection is checked against the account-session endpoint. */
    private fun verifySessionAfterConversationRejection() {
        val sessionToken = accountSessionStore.readSessionToken()?.takeIf { it.isNotBlank() } ?: return
        val expectedAccountId = accountSessionStore.readAccountId()?.takeIf { it.isNotBlank() } ?: return
        runCatching {
            backgroundExecutor.execute {
                val validation = accountAuthClient.validateSession(sessionToken)
                val invalid = when (validation) {
                    AccountSessionValidation.Invalid -> true
                    is AccountSessionValidation.Authenticated -> validation.accountId != expectedAccountId
                    AccountSessionValidation.Unavailable -> false
                }
                if (invalid && accountSessionStore.readSessionToken() == sessionToken) {
                    accountSessionStore.clearSession()
                    mainThreadPoster { stopAuthenticatedConnections() }
                }
            }
        }
    }

    private fun buildResponse(messageJson: String): BridgeResponse {
        return when (val parsed = BridgeValidator.parseRequest(messageJson)) {
            is BridgeRequestResult.Invalid ->
                BridgeValidator.error(parsed.requestId, parsed.error)
            is BridgeRequestResult.Valid -> when (val validated = BridgeValidator.validateArguments(parsed.request)) {
                is BridgeRequestResult.Invalid ->
                    BridgeValidator.error(validated.requestId, validated.error)
                is BridgeRequestResult.Valid -> BridgeValidator.correlate(
                    dispatchHandlers(validated.request),
                    validated.request.requestId,
                )
            }
        }
    }

    private fun dispatchHandlers(request: BridgeRequest): BridgeResponse {
        return when (request.operation) {
            "auth.register", "auth.login", "auth.logout", "auth.state", "auth.verify" ->
                authHandler.handle(request.operation, request.arguments)
            "conversation.send", "conversation.cancel" ->
                conversationHandler.handle(request.operation, request.arguments)
            else ->
                capabilityHandler.handle(request.operation, request.arguments)
        }
    }

    companion object {
        /** Nombre bajo el que JS accede al puente: `window.ApolloNative.postMessage(...)`. */
        const val BRIDGE_NAME: String = "ApolloNative"
    }
}
