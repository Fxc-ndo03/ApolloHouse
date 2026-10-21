package com.apollo.mobile

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import com.apollo.mobile.identity.AccountAuthClient
import com.apollo.mobile.identity.AccountSessionStore
import com.apollo.mobile.ui.Home
import com.apollo.mobile.ui.Profile
import com.apollo.mobile.ui.Settings
import com.apollo.mobile.ui.Updates
import com.apollo.mobile.updates.UpdateOwner

/**
 * Contenedor del producto movil con navegacion inferior.
 *
 * Antes el "producto" era un unico scroll tecnico con el host del Worker, el id
 * del dispositivo, el boton de enrolar y el actualizador apilados. Eso no es
 * una app, es un panel de diagnostico. Ahora hay pantallas separadas con barra
 * inferior, que es como se usa un telefono.
 *
 * Las pantallas son controladores de vista (no Fragments): el proyecto no
 * depende de androidx.fragment y agregar esa libreria solo para esto seria
 * meter una dependencia nueva sin necesidad.
 *
 * La sesion se comprueba aqui y en `LoginActivity`, nunca dentro de cada
 * pantalla: entrar al producto sin sesion no depende de que la pantalla lo
 * pregunte.
 */
class ShellActivity : Activity() {

    private lateinit var content: FrameLayout
    private lateinit var navItems: Map<Int, TextView>

    private var home: Home? = null
    private var settings: Settings? = null
    private var profile: Profile? = null
    private var updates: Updates? = null

    private var promptedUpdateVersion: String? = null
    private val updateListener = UpdateOwner.Listener { state ->
        val available = state as? UpdateOwner.State.Disponible
        val version = available?.manifest?.versionName
        if (!version.isNullOrBlank() && version != promptedUpdateVersion && !isFinishing) {
            promptedUpdateVersion = version
            AlertDialog.Builder(this)
                .setTitle("Actualización nueva de Apollo")
                .setMessage("La versión $version está disponible.")
                .setPositiveButton("Ver actualización") { _, _ -> openUpdates() }
                .setNegativeButton("Más tarde", null)
                .show()
        }
    }

    private var currentView: View? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_shell)

        // Puerta: sin sesion no se entra al producto.
        if (!AccountSessionStore(this).hasSession()) {
            forwardToLogin()
            return
        }

        content = findViewById(R.id.shell_content)
        navItems = mapOf(
            R.id.nav_home to findViewById(R.id.nav_home),
            R.id.nav_chat to findViewById(R.id.nav_chat),
            R.id.nav_settings to findViewById(R.id.nav_settings),
            R.id.nav_profile to findViewById(R.id.nav_profile),
        )
        navItems.forEach { (id, view) -> view.setOnClickListener { onTab(id) } }

        ensureConversationSession()
        showHome()

        val updateOwner = (application as ApolloApplication).updateOwner
        updateOwner.observe(updateListener)
        updateOwner.comprobarAlIniciar()
    }

    /**
     * Abre la sesion de conversacion al entrar al producto.
     *
     * Antes solo la abria `DeviceActivity.connect()`, que en el flujo nuevo ya
     * no se visita: por eso Chat llegaba diciendo "Sin conexion" con una sesion
     * de cuenta valida. La sesion de conversacion es un socket DISTINTO al de
     * capacidades (`sessionOwner`), asi que se abre aqui y no se duplica.
     *
     * No hace falta enrolar este telefono: la identidad de conversacion es la
     * sesion de CUENTA, y el Worker acepta ese Bearer solo en rutas
     * `acct-<accountId>`. Misma regla que usa `DeviceActivity`.
     */
    private fun ensureConversationSession() {
        val application = application as ApolloApplication
        if (application.conversationOwner.state != com.apollo.mobile.conversation.ConversationState.DISCONNECTED) {
            return
        }
        val sessionStore = AccountSessionStore(this)
        val accountId = sessionStore.readAccountId()?.takeIf { it.isNotBlank() } ?: return
        val sessionToken = sessionStore.readSessionToken()?.takeIf { it.isNotBlank() } ?: return
        val deviceId = application.identityStore.resolveStableDeviceId()
        application.conversationOwner.start(
            deviceId = deviceId,
            credential = AccountAuthCredentialResolver.resolveForAccount(
                accountId = accountId,
                sessionToken = sessionToken,
                enrolledCredential = application.credentialStore.readEnrolledCredential(),
            ),
        )
    }

    override fun onResume() {
        super.onResume()
        if (!AccountSessionStore(this).hasSession()) {
            forwardToLogin()
            return
        }
        applyTheme()
        (application as ApolloApplication).updateOwner.comprobarAlReanudar()
    }

    override fun onDestroy() {
        if (::content.isInitialized) {
            (application as ApolloApplication).updateOwner.unobserve(updateListener)
        }
        super.onDestroy()
    }

    private fun forwardToLogin() {
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }

    private fun onTab(tabId: Int) {
        when (tabId) {
            // La conversacion reutiliza la Activity que ya existe y ya habla con
            // el transporte real: no se duplica esa logica.
            R.id.nav_chat -> startActivity(
                Intent(this, com.apollo.mobile.conversation.ConversationActivity::class.java),
            )
            R.id.nav_settings -> showSettings()
            R.id.nav_profile -> showProfile()
            else -> showHome()
        }
    }

    private fun swap(next: View) {
        if (currentView === next) return
        content.removeAllViews()
        content.addView(next, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        ))
        currentView = next
        applyTheme()
    }

    private fun showHome() {
        val screen = home ?: Home(this).also { home = it }
        markSelected(R.id.nav_home)
        swap(screen.build())
    }

    private fun showSettings() {
        val screen = settings ?: Settings(this).also { settings = it }
        markSelected(R.id.nav_settings)
        swap(screen.build())
    }

    private fun showProfile() {
        val screen = profile ?: Profile(this).also { profile = it }
        markSelected(R.id.nav_profile)
        swap(screen.build())
    }

    /** Abre Actualizaciones desde Ajustes. */
    fun openUpdates() {
        val screen = updates ?: Updates(this).also { updates = it }
        markSelected(R.id.nav_settings)
        swap(screen.build())
    }

    /** Vuelve a la pantalla de Ajustes (usado por el boton Volver). */
    fun openSettings() {
        showSettings()
    }

    private fun markSelected(activeId: Int) {
        navItems.forEach { (id, view) ->
            val selected = id == activeId
            view.isSelected = selected
            view.setTextColor(
                if (selected) com.apollo.mobile.ui.ApolloColors.accent(this)
                else com.apollo.mobile.ui.ApolloColors.muted(this),
            )
        }
    }

    private fun applyTheme() {
        content.setBackgroundColor(com.apollo.mobile.ui.ApolloColors.background(this))
        findViewById<View>(R.id.shell_nav)
            .setBackgroundColor(com.apollo.mobile.ui.ApolloColors.surface(this))
        findViewById<View>(R.id.shell_separator)
            .setBackgroundColor(com.apollo.mobile.ui.ApolloColors.line(this))
    }

    /** Cierra sesion y vuelve al acceso. Lo usa Perfil. */
    fun signOut() {
        // El socket de conversacion se cierra ANTES de borrar la sesion: si se
        // dejara vivo, seguiria hablando con la cuenta anterior.
        (application as ApolloApplication).conversationOwner.stop()
        (application as ApolloApplication).sessionOwner.stop()
        val sessionStore = AccountSessionStore(this)
        val token = sessionStore.readSessionToken()
        sessionStore.clearSession()
        if (token != null) {
            val application = application as ApolloApplication
            val host = com.apollo.mobile.transport.normalizeWorkerHostInput(application.workerHost)
            if (host != null) {
                application.accountAuthDispatcher.logout(AccountAuthClient(host), token) { }
            }
        }
        // La sesion se limpio antes de navegar: aunque la app se mate ahora,
        // no queda un token vivo en el telefono.
        forwardToLogin()
    }
}
