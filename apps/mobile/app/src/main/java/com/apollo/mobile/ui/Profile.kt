package com.apollo.mobile.ui

import android.app.AlertDialog
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.apollo.mobile.R
import com.apollo.mobile.ShellActivity
import com.apollo.mobile.identity.AccountSessionStore

/**
 * Perfil: identidad de la sesion y cierre de sesion.
 *
 * No ofrece cambiar contrasena ni eliminar cuenta porque el backend no expone
 * esos endpoints. Inventarlos seria mostrar una accion que no ocurre.
 */
class Profile(private val host: ShellActivity) {

    fun build(): View {
        val view = host.layoutInflater.inflate(R.layout.fragment_profile, null, false)
        val context = host
        val sessionStore = AccountSessionStore(context)

        val accountId = sessionStore.readAccountId().orEmpty()
        val email = sessionStore.readEmail()

        view.findViewById<TextView>(R.id.profile_avatar).text =
            (email.ifBlank { accountId }).take(1).uppercase().ifBlank { "A" }
        view.findViewById<TextView>(R.id.profile_name).text =
            email.substringBefore('@').ifBlank { "Tu cuenta" }
        view.findViewById<TextView>(R.id.profile_email).text = email.ifBlank { accountId }
        view.findViewById<TextView>(R.id.profile_session_state).text = "Sesión activa"
        view.findViewById<TextView>(R.id.profile_session_token).text =
            "Token guardado cifrado en el Keystore del teléfono"
        view.findViewById<TextView>(R.id.profile_device).text =
            "Este teléfono: ${(context.applicationContext as com.apollo.mobile.ApolloApplication).identityStore.resolveStableDeviceId()}"

        view.findViewById<View>(R.id.profile_sign_out).setOnClickListener {
            AlertDialog.Builder(context)
                .setTitle("¿Cerrar sesión?")
                .setMessage("Vas a tener que iniciar sesión de nuevo para usar Apollo.")
                .setNegativeButton("Cancelar", null)
                .setPositiveButton("Cerrar sesión") { _, _ ->
                    host.signOut()
                }
                .show()
        }
        return view
    }
}
