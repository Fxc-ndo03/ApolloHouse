package com.apollo.mobile

import android.content.Intent
import android.app.AlertDialog
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import com.apollo.mobile.identity.AccountAuthClient
import com.apollo.mobile.identity.AccountAuthOutcome
import com.apollo.mobile.identity.AccountSessionStore
import com.apollo.mobile.ui.ApolloColors
import com.apollo.mobile.updates.UpdateOwner

/**
 * Acceso de Apollo: login y registro.
 *
 * Es el equivalente movil del `AuthGate` de escritorio. Sin sesion valida NO se
 * entra al producto: `ShellActivity` no se lanza hasta que hay sesion, y la
 * sesion se comprueba contra el backend real (`AccountAuthClient`), no contra un
 * dato local.
 *
 * Reutiliza la MISMA logica de autenticacion que ya existia en
 * `MainActivity` (`AccountAuthDispatcher` + `AccountSessionStore`): aqui no hay
 * un segundo sistema de sesiones, solo una pantalla que lo expone bien.
 */
class LoginActivity : android.app.Activity() {

    private lateinit var orb: View
    private lateinit var emailInput: EditText
    private lateinit var passwordInput: EditText
    private lateinit var errorText: TextView
    private lateinit var submitButton: Button
    private lateinit var switchButton: Button
    private lateinit var subtitle: TextView

    private var registrationMode = false
    private var updateOwnerObserved = false
    private var promptedUpdateVersion: String? = null
    private val updateListener = UpdateOwner.Listener { state ->
        val available = state as? UpdateOwner.State.Disponible
        val version = available?.manifest?.versionName
        if (!version.isNullOrBlank() && version != promptedUpdateVersion && !isFinishing) {
            promptedUpdateVersion = version
            AlertDialog.Builder(this)
                .setTitle("Actualización nueva de Apollo")
                .setMessage("La versión $version está disponible. Iniciá sesión y abrí Ajustes > Actualizaciones para instalarla.")
                .setPositiveButton("Entendido", null)
                .show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)

        orb = findViewById(R.id.login_orb)
        emailInput = findViewById(R.id.login_email)
        passwordInput = findViewById(R.id.login_password)
        errorText = findViewById(R.id.login_error)
        submitButton = findViewById(R.id.login_submit)
        switchButton = findViewById(R.id.login_switch_mode)
        subtitle = findViewById(R.id.login_subtitle)

        findViewById<TextView>(R.id.login_worker).text =
            "Servidor: ${(application as ApolloApplication).workerHost.ifBlank { "(sin configurar)" }}"

        submitButton.setOnClickListener { submit() }
        switchButton.setOnClickListener { toggleMode() }

        if (AccountSessionStore(this).hasSession()) {
            openProduct()
            return
        }
        applyTheme()
        val updateOwner = (application as ApolloApplication).updateOwner
        updateOwner.observe(updateListener)
        updateOwnerObserved = true
        updateOwner.comprobarAlIniciar()
    }

    override fun onResume() {
        super.onResume()
        applyTheme()
        (orb as? com.apollo.mobile.ui.ApolloOrbView)?.start()
        if (!AccountSessionStore(this).hasSession()) {
            (application as ApolloApplication).updateOwner.comprobarAlReanudar()
        }
    }

    override fun onDestroy() {
        if (updateOwnerObserved) {
            (application as ApolloApplication).updateOwner.unobserve(updateListener)
        }
        super.onDestroy()
    }

    private fun applyTheme() {
        val background = ApolloColors.background(this)
        findViewById<View>(R.id.login_root).setBackgroundColor(background)
        subtitle.setTextColor(ApolloColors.muted(this))
        errorText.setTextColor(0xFFFF6A4A.toInt())
    }

    private fun toggleMode() {
        registrationMode = !registrationMode
        subtitle.text = if (registrationMode) {
            "Creá tu cuenta. Un acceso para todos tus dispositivos."
        } else {
            "Iniciá sesión para conversar con tu asistente."
        }
        submitButton.text = if (registrationMode) "Crear cuenta" else "Ingresar"
        switchButton.text = if (registrationMode) "Ya tengo cuenta" else "Crear cuenta"
        errorText.visibility = View.GONE
    }

    private fun submit() {
        val application = application as ApolloApplication
        val configuredHost = application.workerHost.trim()
        val fallbackHost = if (com.apollo.mobile.BuildConfig.UPDATE_CHANNEL == "staging") com.apollo.mobile.BuildConfig.DEFAULT_WORKER_HOST else ""
        val candidateHost = if (com.apollo.mobile.transport.normalizeWorkerHostInput(configuredHost) == null) fallbackHost else configuredHost
        val host = com.apollo.mobile.transport.normalizeWorkerHostInput(candidateHost)
        if (host != null && configuredHost != candidateHost) {
            application.workerHost = host
        }
        if (host == null) {
            showError("El host del Worker no es válido.")
            return
        }

        val email = emailInput.text.toString().trim()
        val password = passwordInput.text.toString()
        if (email.isEmpty() || password.length < 10) {
            showError("Revisá el email y la contraseña (mínimo 10 caracteres).")
            return
        }

        setBusy(true)
        application.accountAuthDispatcher.authenticate(
            client = AccountAuthClient(host),
            email = email,
            password = password,
            isRegistration = registrationMode,
        ) { outcome ->
            setBusy(false)
            when (outcome) {
                is AccountAuthOutcome.Authenticated -> {
                    // El token va al Keystore; a la UI nunca llega.
                    val persisted = AccountSessionStore(this).writeSession(
                        accountId = outcome.accountId,
                        sessionToken = outcome.sessionToken,
                        email = email,
                        expiresAtMilliseconds = outcome.expiresAtMilliseconds,
                    )
                    if (!persisted) {
                        showError("No se pudo guardar la sesión segura. Intentá de nuevo.")
                        return@authenticate
                    }
                    passwordInput.setText("")
                    openProduct()
                }
                is AccountAuthOutcome.Rejected -> {
                    passwordInput.setText("")
                    // El backend responde igual exista o no la cuenta: el texto no
                    // revela si el email existe.
                    showError(
                        if (outcome.reason == AccountAuthClient.REASON_INVALID_CREDENTIALS) {
                            "Email o contraseña incorrectos."
                        } else {
                            "No se pudo completar la operación. Probá de nuevo."
                        },
                    )
                }
            }
        }
    }

    private fun setBusy(busy: Boolean) {
        submitButton.isEnabled = !busy
        switchButton.isEnabled = !busy
        submitButton.text = if (busy) "Un momento…" else if (registrationMode) "Crear cuenta" else "Ingresar"
    }

    private fun showError(message: String) {
        errorText.text = message
        errorText.visibility = View.VISIBLE
    }

    private fun openProduct() {
        startActivity(Intent(this, ShellActivity::class.java))
        finish()
    }
}
