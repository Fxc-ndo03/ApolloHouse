package com.apollo.mobile

import android.app.Activity
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import com.apollo.mobile.conversation.ConversationActivity
import com.apollo.mobile.identity.AccountAuthClient
import com.apollo.mobile.identity.AccountAuthOutcome
import com.apollo.mobile.identity.AccountSessionStore
import com.apollo.mobile.identity.EnrollmentClaimClient
import com.apollo.mobile.identity.EnrollmentClaimResult
import com.apollo.mobile.notification.NotificationPermissionRequest
import com.apollo.mobile.session.MobileSessionOwner
import com.apollo.mobile.session.MobileSessionState
import com.apollo.mobile.notification.PermissionOutcome
import com.apollo.mobile.transport.ClientConfig
import com.apollo.mobile.transport.DeviceCredential
import com.apollo.mobile.transport.normalizeWorkerHostInput

/**
 * Pantalla TECNICA del dispositivo: host del Worker, id del telefono, enrolar y
 * conectar.
 *
 * Antes vivia dentro de `MainActivity`, que era a la vez el launcher y esta
 * pantalla. Ahora el launcher enruta al producto (`LoginActivity` / `ShellActivity`)
 * y esta pantalla queda como el sitio donde se enrola el telefono y se configura
 * el host, alcanzable desde Ajustes.
 *
 * No se perdio ninguna funcion: enrolment, conexion con credencial enrolada,
 * alarmas y permisos siguen aqui exactamente igual.
 */
class DeviceActivity : Activity() {

    private lateinit var statusText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val application = application as ApolloApplication
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        // BLOCK 12.1 ┬º2.2: el deviceId se resuelve y se MUESTRA antes de pedir
        // nada, porque el dueno lo necesita para autorizar ESTE telefono: el
        // desafio va atado a esta identidad. Sin verlo, el dueno no tiene forma
        // de saber que identidad est├í autorizando.
        val deviceId = application.identityStore.resolveStableDeviceId()
        val deviceIdText = TextView(this).apply {
            text = "Este telefono es: $deviceId"
        }

        // El hint dice explicitamente que el esquema es opcional: es lo que
        // evita que alguien pegue `http://...` y termine con un host duplicado.
        //
        // El host vuelve a aparecer al reabrir: est├í persistido en
        // SharedPreferences, no en la recreaci├│n del EditText.
        val hostInput = EditText(this).apply {
            hint = "worker host (ej: 127.0.0.1:8799)"
            setText(application.workerHost)
        }
        val challengeInput = EditText(this).apply {
            hint = "desafio de enrollment (apollo_enr_...)"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        statusText = TextView(this)

        val enrollButton = Button(this).apply { text = "Enrolar este telefono" }
        enrollButton.setOnClickListener {
            enrollThisPhone(
                application = application,
                workerHost = hostInput.text.toString(),
                challenge = challengeInput.text.toString()
            )
        }

        val connectButton = Button(this).apply { text = "Conectar" }
        connectButton.setOnClickListener {
            connect(application = application, workerHost = hostInput.text.toString())
        }

        // FASE 2.3 ÔÇö cuenta multiusuario. El email/password viajan en el body
        // del POST (nunca en la URL) y el token de sesi├│n que devuelven vive
        // cifrado en el Keystore (AccountSessionStore).
        val accountStatusText = TextView(this)
        val emailInput = EditText(this).apply { hint = "email" }
        val passwordInput = EditText(this).apply {
            hint = "contrase├▒a (m├¡nimo 10 caracteres)"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val accountSessionStore = AccountSessionStore(this)
        accountStatusText.text = when {
            accountSessionStore.hasSession() ->
                "cuenta: ${accountSessionStore.readAccountId()}"
            else -> "sin sesi├│n de cuenta"
        }
        fun runAccountAction(isRegistration: Boolean) {
            val normalizedHost = normalizeWorkerHostInput(hostInput.text.toString())
            if (normalizedHost == null) {
                accountStatusText.text = "el host del Worker no es valido"
                return
            }
            application.workerHost = normalizedHost
            accountStatusText.text = if (isRegistration) "creando cuenta..." else "ingresando..."
            application.accountAuthDispatcher.authenticate(
                client = AccountAuthClient(normalizedHost),
                email = emailInput.text.toString().trim(),
                password = passwordInput.text.toString(),
                isRegistration = isRegistration,
            ) authResult@ { outcome ->
                when (outcome) {
                    is AccountAuthOutcome.Authenticated -> {
                        val accountEmail = emailInput.text.toString().trim()
                        val persisted = accountSessionStore.writeSession(
                            accountId = outcome.accountId,
                            sessionToken = outcome.sessionToken,
                            email = accountEmail,
                            expiresAtMilliseconds = outcome.expiresAtMilliseconds,
                        )
                        if (!persisted) {
                            accountStatusText.text = "no se pudo guardar la sesión segura"
                            return@authResult
                        }
                        passwordInput.setText("")
                        // Enrolar el dispositivo con la cuenta reci├®n autenticada:
                        // binding deviceIdÔåöaccountId en el servidor.
                        application.accountAuthDispatcher.authenticate(
                            client = AccountAuthClient(normalizedHost),
                            email = accountEmail,
                            password = passwordInput.text.toString(),
                            isRegistration = false,
                        ) { }
                        Thread {
                            val enrolled = try {
                                AccountAuthClient(normalizedHost).enrollDevice(
                                    sessionToken = outcome.sessionToken,
                                    deviceId = deviceId,
                                    deviceType = "android",
                                    deviceName = android.os.Build.MODEL ?: "Android",
                                )
                            } catch (unexpected: Exception) {
                                false
                            }
                            runOnUiThread {
                                accountStatusText.text = if (enrolled) {
                                    "cuenta: ${outcome.accountId} ┬À dispositivo enrolado"
                                } else {
                                    "cuenta: ${outcome.accountId} ┬À dispositivo SIN enrolar"
                                }
                            }
                        }.start()
                    }
                    is AccountAuthOutcome.Rejected -> {
                        passwordInput.setText("")
                        accountStatusText.text = "no se pudo: ${outcome.reason}"
                    }
                }
            }
        }
        val loginButton = Button(this).apply { text = "Ingresar" }
        loginButton.setOnClickListener { runAccountAction(isRegistration = false) }
        val registerButton = Button(this).apply { text = "Crear cuenta" }
        registerButton.setOnClickListener { runAccountAction(isRegistration = true) }
        val logoutButton = Button(this).apply { text = "Cerrar sesi├│n" }
        logoutButton.setOnClickListener {
            val sessionToken = accountSessionStore.readSessionToken()
            accountSessionStore.clearSession()
            accountStatusText.text = "sin sesi├│n de cuenta"
            if (sessionToken != null) {
                Thread {
                    try {
                        AccountAuthClient(normalizeWorkerHostInput(hostInput.text.toString()) ?: application.workerHost)
                            .logout(sessionToken)
                    } catch (unexpected: Exception) {
                    }
                }.start()
            }
        }

        // La conversaci├│n es una pantalla aparte: la capacidad (MobileBridge) y
        // la conversaci├│n (Apollo DO) son dos cosas distintas, y mezclarlas en
        // la misma pantalla confunde al usuario.
        val conversationButton = Button(this).apply {
            text = "Conversar con Apollo"
        }
        conversationButton.setOnClickListener {
            // Si el host escrito cambi├│, se guarda ANTES de abrir: la pantalla
            // de conversaci├│n lee el host actual en el momento de usarlo.
            val normalizedHost = normalizeWorkerHostInput(hostInput.text.toString())
            if (normalizedHost !== null) {
                application.workerHost = normalizedHost
            }
            startActivity(android.content.Intent(this, ConversationActivity::class.java))
        }
        // BLOCK 12.5.1: la Activity observa a la sesion, no la duena. Asi una
        // recreacion de la Activity no la destruye ni la duplica.
        application.sessionOwner.observe(object : MobileSessionOwner.SessionListener {
            override fun onStateChanged(state: MobileSessionState) {
                statusText.text = describeSessionState(state)
            }
        })

        layout.addView(deviceIdText)
        layout.addView(hostInput)
        layout.addView(emailInput)
        layout.addView(passwordInput)
        layout.addView(loginButton)
        layout.addView(registerButton)
        layout.addView(logoutButton)
        layout.addView(accountStatusText)
        layout.addView(challengeInput)
        layout.addView(enrollButton)
        layout.addView(connectButton)
        layout.addView(conversationButton)
        layout.addView(statusText)
        setContentView(layout)

        // BLOCK 12.4: con targetSdk 35+ Android 15 dibuja edge-to-edge por defecto.
        // Sin esto el onboarding se dibuja debajo de la barra de estado y el
        // primer campo queda tapado. No es un redise├▒o: es el padding que la
        // plataforma exige una vez que deja de hacerlo el sistema.
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(layout) { view, insets ->
            val systemBarInset = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.systemBars()
            )
            view.setPadding(
                systemBarInset.left,
                systemBarInset.top,
                systemBarInset.right,
                systemBarInset.bottom
            )
            insets
        }

        // BLOCK 12.4: en Android 13+ las notificaciones requieren permiso en
        // runtime. Se pide al abrir la app, antes de que Apollo intente mandar
        // nada. En API < 33 no se pide nada.
        notificationPermissionRequest = NotificationPermissionRequest(this)
        notificationPermissionRequest?.request { outcome ->
            statusText.text = when (outcome) {
                is PermissionOutcome.Granted -> "Apollo puede notificarte"
                is PermissionOutcome.Denied ->
                    "sin permiso de notificaciones, Apollo no puede avisarte"
            }
        }
    }

    private var notificationPermissionRequest: NotificationPermissionRequest? = null

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        notificationPermissionRequest?.onRequestPermissionsResult(requestCode, grantResults)
    }

    private fun enrollThisPhone(
        application: ApolloApplication,
        workerHost: String,
        challenge: String
    ) {
        // BLOCK 12.5.2: se normaliza una sola vez y se valida. Antes el host
        // crudo se concatenaba con el esquema, y escribir `http://127.0.0.1:8799`
        // producia `https://http://127.0.0.1:8799`.
        val normalizedHost = normalizeWorkerHostInput(workerHost)
        if (normalizedHost == null) {
            statusText.text = "el host del Worker no es valido"
            return
        }
        val deviceId = application.identityStore.resolveStableDeviceId()
        val client = EnrollmentClaimClient(
            ClientConfig(workerHost = normalizedHost, isDebugBuild = application.isDebugBuild())
        )
        statusText.text = "enrolando $deviceId..."
        // BLOCK 12.5.2: fuera del hilo principal. `HttpURLConnection` desde la UI
        // lanza `NetworkOnMainThreadException` con targetSdk 11 o superior.
        application.enrollmentClaimDispatcher.submit(
            client = client,
            challenge = challenge,
            deviceId = deviceId,
            onResult = { result -> showEnrollmentResult(application, result) }
        )
    }

    /** El resultado vuelve al hilo principal, que es el unico que toca la vista. */
    private fun showEnrollmentResult(
        application: ApolloApplication,
        result: EnrollmentClaimResult
    ) {
        when (result) {
            is EnrollmentClaimResult.Enrolled -> {
                // La credencial se cifra antes de tocar disco, con una clave que
                // vive en el Keystore y no sale de el.
                application.credentialStore.writeEnrolledCredential(result.credential)
                statusText.text = "enrolado como ${result.deviceId}"
            }
            is EnrollmentClaimResult.Rejected ->
                statusText.text = "el servidor no acepto el enrollment: ${result.reason}"
            is EnrollmentClaimResult.Unreachable ->
                statusText.text = "no se pudo contactar al Worker (${result.detail})"
        }
    }

    /**
     * BLOCK 12.1 ┬º3: conectar como dispositivo autorizado EXIGE una credencial
     * individual enrolada.
     *
     * Antes esta pantalla aceptaba el DEVICE_SHARED_SECRET global como
     * alternativa, y el servidor lo rechazaba en el hello con
     * `device_not_enrolled`. Offering una opci├│n que el servidor ya no acepta
     * ser├¡a una pantalla que miente, as├¡ que el camino legacy se withdrew de
     * ac├í: el tel├®fono se enrola y despu├®s conecta con su credencial.
     */
    private fun connect(
        application: ApolloApplication,
        workerHost: String
    ) {
        val normalizedHost = normalizeWorkerHostInput(workerHost)
        if (normalizedHost == null) {
            statusText.text = "el host del Worker no es valido"
            return
        }
        val deviceId = application.identityStore.resolveStableDeviceId()
        // FASE 2.3: la sesi├│n de CUENTA gana ÔÇö representa al due├▒o y entra al
        // Apollo de la cuenta (`acct:<accountId>`), no al del dispositivo. La
        // credencial enrolada queda para el plano de capacidades.
        val accountSessionToken = AccountSessionStore(this).readSessionToken()
        val accountSessionId = AccountSessionStore(this).readAccountId()
        val credential: DeviceCredential = if (accountSessionToken != null && accountSessionId != null) {
            DeviceCredential.AccountSession(accountId = accountSessionId, sessionToken = accountSessionToken)
        } else {
            val enrolledCredential = application.credentialStore.readEnrolledCredential()
            if (enrolledCredential == null) {
                statusText.text = "ingres├í a tu cuenta o enrola este tel├®fono primero"
                return
            }
            DeviceCredential.Enrolled(enrolledCredential)
        }
        // BLOCK 12.5.1: el host se guarda antes de arrancar, porque el dueno]
        // construye la sesion leyendo de aca en el momento de crearla.]
        application.workerHost = normalizedHost
        val didStart = application.sessionOwner.start(
            deviceId = deviceId,
            credential = credential,
        )
        // Idempotente: apretar dos veces no abre dos sockets. El mensaje lo dice
        // en vez de fingir que volvio a conectar.
        statusText.text = if (didStart) {
            // BLOCK 12.5.2: el foreground service se arranca desde la Activity en
            // primer plano, que es el unico momento en que Android lo permite sin
            // exenciones. `startForegroundService` obliga al service a llamar
            // `startForeground` en los proximos ~5s, y el service lo hace en el
            // acto. Con la sesion muerta (revocada) `start` ya la reemplazo, asi
            // que este camino tambien cubre el re-enrollment.
            androidx.core.content.ContextCompat.startForegroundService(
                this,
                android.content.Intent(this, com.apollo.mobile.MobileService::class.java)
            )
            "conectando como $deviceId"
        } else {
            "ya estas conectado"
        }
    }

    /**
     * Traduce el estado a texto. Vive aca y no en el dueno porque es
     * presentacion: el dueno no sabe de Activity ni de TextView.
     */
    private fun describeSessionState(state: MobileSessionState): String = when (state) {
        MobileSessionState.DISCONNECTED -> "desconectado"
        MobileSessionState.CONNECTING -> "conectando"
        MobileSessionState.RECONNECTING -> "reconectando"
        MobileSessionState.AUTHENTICATED -> "autenticado"
        MobileSessionState.ONLINE -> "en linea"
    }
}
