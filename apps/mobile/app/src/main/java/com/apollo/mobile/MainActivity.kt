package com.apollo.mobile

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.apollo.mobile.webview.ApolloWebActivity

/**
 * Punto de entrada del launcher.
 *
 * Antes esta Activity CONSTRUIA la pantalla tecnica (host del Worker, id del
 * dispositivo, enrolar, conectar, login, actualizaciones) y era a la vez la
 * portada del producto. Eso no es una app movil, es un panel de diagnostico.
 *
 * Ahora solo decide a donde va el usuario:
 *   - sin sesion -> `LoginActivity` (acceso/registro)
 *   - con sesion -> `ShellActivity` (Inicio / Chat / Ajustes / Perfil)
 *
 * No se elimina ninguna logica: el login, la sesion, la conversacion, el
 * enrolment y el actualizador siguen siendo los mismos objetos, solo cambia la
 * pantalla desde la que se llega a ellos.
 *
 * FASE 6.1 · Etapa 2 — selector temporal.
 *
 * La ruta NATIVA es la predeterminada y no se cambia todavia: la interfaz web no
 * tiene autenticacion, conversacion ni capacidades integradas, asi que abrirla
 * por defecto seria mostrar una pantalla vacia. La interfaz web se abre solo si
 * la persona lo pide de forma explicita y reversible:
 *
 *   - `adb shell am start -n com.apollo.mobile/.MainActivity --ez apolloWeb true`
 *   - o el atajo en Ajustes de la pantalla tecnica, cuando exista
 *
 * El flag se lee una vez, al crear la Activity, y nunca se persiste: al volver
 * a abrir la app se reinstate la ruta nativa. Es un interruptor de
 * diagnostico, no un estado del producto.
 */
class MainActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val application = application as ApolloApplication
        // El sidecar/foreground service se siguensiguiendo desde la app, pero la
        // decision de "que pantalla" no depende de que el servicio este vivo.

        if (BuildConfig.UPDATE_CHANNEL == "staging" || isWebInterfaceRequested(intent)) {
            startActivity(Intent(this, ApolloWebActivity::class.java))
            finish()
            return
        }

        val destination = if (com.apollo.mobile.identity.AccountSessionStore(this).hasSession()) {
            ShellActivity::class.java
        } else {
            LoginActivity::class.java
        }
        startActivity(Intent(this, destination))
        finish()
        application
    }

    /**
     * Solo el extra `apolloWeb` con valor `true` abre la web. Cualquier otro
     * valor, o su ausencia, deja la ruta nativa intacta.
     */
    private fun isWebInterfaceRequested(startingIntent: Intent?): Boolean =
        startingIntent?.getBooleanExtra(WEB_INTERFACE_EXTRA_KEY, false) == true

    private companion object {
        const val WEB_INTERFACE_EXTRA_KEY = "apolloWeb"
    }
}
