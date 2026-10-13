package com.apollo.mobile

import android.app.Application
import com.apollo.mobile.command.CommandDispatcher
import com.apollo.mobile.conversation.ConversationHistory
import com.apollo.mobile.conversation.ConversationHistoryStore
import com.apollo.mobile.conversation.ConversationOwner
import com.apollo.mobile.identity.AccountAuthDispatcher
import com.apollo.mobile.identity.EnrollmentClaimDispatcher
import com.apollo.mobile.identity.IdentityStore
import com.apollo.mobile.notification.AndroidMobilePlatform
import com.apollo.mobile.notification.AndroidNotificationAdapter
import com.apollo.mobile.session.MobileSession
import com.apollo.mobile.session.MobileSessionOwner
import com.apollo.mobile.session.reconnect.SystemReconnectScheduler
import com.apollo.mobile.transport.ClientConfig
import com.apollo.mobile.transport.CredentialStore
import com.apollo.mobile.transport.OkHttpSocketFactory
import java.util.concurrent.Executors

// Workaround for Kotlin 2.x bug: "scheduler" in class names causes resolution issues
// Using a type alias to avoid the "scheduler" substring issue

class ApolloApplication : Application() {

    val credentialStore: CredentialStore by lazy { CredentialStore(this) }
    val identityStore: IdentityStore by lazy { IdentityStore(this) }

    private val preferenceStore by lazy {
        applicationContext.getSharedPreferences(PREFERENCES_FILE_NAME, android.content.Context.MODE_PRIVATE)
    }

    /**
     * BLOCK 12.5.1: el dueño explicito de la sesion.
     *
     * Vive en la `Application` y no en la `Activity` por una razon concreta: la
     * `Activity` se recrea (rotacion, navegacion, restauracion del sistema) y
     * una sesion guardada ahi se pierde o se duplica. La `Application` es el
     * dueno que corresponde a algo con ciclo de vida de proceso.
     *
     * El `workerHost` se guarda en SharedPreferences y no sólo en memoria: la
     * app debe sobrevivir a un reinicio sin que el usuario tenga que reescribir
     * el host, y reiniciar el telefono no debe dejarte sin WhatsApp del asistente.
     * No es un secreto, es una direccion: por eso es plano y no cifrado.
     *
     * NUNCA va la credencial aca: esa vive en el Keystore.
     */
    var workerHost: String
        get() = preferenceStore.getString(PREFERENCE_WORKER_HOST, "") ?: ""
        set(newWorkerHost) {
            preferenceStore.edit().putString(PREFERENCE_WORKER_HOST, newWorkerHost).apply()
        }

    /**
     * BLOCK 12.5.2: el claim del enrollment corre aqui.
     *
     * Un solo hilo, no un pool: el claim es una llamada puntual y no hay trabajo
     * concurrente que lo justifique. El executor vive en la `Application` para
     * que sobreviva a la recreacion de la Activity; si viviera en la Activity,
     * rotar el telefono mataria el claim a medio camino.
     */
    val enrollmentClaimDispatcher: EnrollmentClaimDispatcher by lazy {
        EnrollmentClaimDispatcher(
            backgroundExecutor = Executors.newSingleThreadExecutor(),
            mainThreadPoster = { action -> android.os.Handler(android.os.Looper.getMainLooper()).post(action) }
        )
    }

    /** FASE 2.3: login/registro/logout fuera del hilo principal. */
    val accountAuthDispatcher: AccountAuthDispatcher by lazy {
        AccountAuthDispatcher(
            backgroundExecutor = Executors.newSingleThreadExecutor(),
            mainThreadPoster = { action -> android.os.Handler(android.os.Looper.getMainLooper()).post(action) }
        )
    }

    val sessionOwner: MobileSessionOwner by lazy {
        MobileSessionOwner(
            sessionFactory = { buildMobileSession(workerHost) },
            reconnectScheduler = SystemReconnectScheduler
        )
    }

    /**
     * Historial de la conversación. Vive en la `Application` y no en la Activity
     * para que rotar el teléfono no borre lo que el usuario ya leyó.
     */
    val conversationHistory: ConversationHistory by lazy { ConversationHistory() }

    /**
     * La persistencia del historial es un store aparte, no un método de la
     * Application: guardarlo aca mezclaria responsabilidades y haría cada test
     * de historial depender del contexto Android.
     */
    val conversationHistoryStore: ConversationHistoryStore by lazy {
        ConversationHistoryStore(this, conversationHistory)
    }

    /**
     * El historial se carga una vez, con el primer acceso. Leerlo en cada
     * `start` repetiría la lectura y podría pisar turnos agregados en memoria.
     */
    private var didLoadConversationHistory = false

    fun loadConversationHistoryOnce() {
        if (didLoadConversationHistory) return
        didLoadConversationHistory = true
        conversationHistoryStore.readHistory()
    }

    /**
     * Owner de la conversación.
     *
     * Es un socket **distinto** al de `sessionOwner`: aquél va al
     * `MobileBridge` y transporta capacidades; éste va al Apollo DO de esta
     * identidad y transporta turnos de conversación. Comparten la credencial
     * pero no el socket, porque son dos permisos distintos y una caída de uno no
     * debe tumbar al otro.
     */
    val conversationOwner: ConversationOwner by lazy {
        ConversationOwner(
            // Se lee en el momento de abrir la sesión, no al construir el owner:
            // así un cambio de host posterior no deja la conversación apuntando
            // a la direccion vieja.
            workerHostPort = { workerHost },
            isDebugBuild = isDebugBuild(),
            socketFactory = OkHttpSocketFactory(),
            reconnectScheduler = SystemReconnectScheduler,
            history = conversationHistory
        )
    }

    /**
     * Si esta build es debug.
     *
     * Lo lee `BuildConfig`, que genera AGP, y no un flag propio: asi release
     * compila con `false` sin que nadie pueda olvidarse de apagarlo. Es la mitad
     * de la condicion que permite cleartext; la otra mitad es que el host sea
     * loopback, y esa se evalua en `resolveIsSecureTransport`.
     */
    fun isDebugBuild(): Boolean = BuildConfig.DEBUG

    companion object {
        const val PREFERENCES_FILE_NAME = "apollo_mobile_preferences"
        const val PREFERENCE_WORKER_HOST = "worker_host"
    }

    fun buildMobileSession(workerHost: String): MobileSession = MobileSession(
        clientConfig = ClientConfig(
            workerHost = workerHost,
            isDebugBuild = isDebugBuild()
        ),
        deviceSocketFactory = OkHttpSocketFactory(),
        commandDispatcher = CommandDispatcher(
            notificationAdapter = AndroidNotificationAdapter(this),
            platform = AndroidMobilePlatform(this)
        )
    )
}