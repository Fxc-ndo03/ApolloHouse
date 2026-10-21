package com.apollo.mobile.ui

import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import com.apollo.mobile.ApolloApplication
import com.apollo.mobile.R
import com.apollo.mobile.ShellActivity
import com.apollo.mobile.updates.UpdateDownloader
import com.apollo.mobile.updates.UpdateManifest
import com.apollo.mobile.updates.UpdateOwner
import com.apollo.mobile.updates.UpdateService

/**
 * Pantalla de actualizaciones: equivalente movil de la pagina homonima de
 * escritorio.
 *
 * Reutiliza `UpdateOwner`/`UpdateService`/`UpdateDownloader` tal cual — no hay
 * un segundo camino de actualizacion. Aqui solo se dibuja el estado y se
 * traducen los dos botones a las acciones del owner.
 *
 * La politica sigue siendo MANUAL: comprobar es automatico (al abrir), pero
 * descargar e instalar solo ocurren con un toque.
 */
class Updates(private val host: ShellActivity) {

    private val owner: UpdateOwner
        get() = (host.application as ApolloApplication).updateOwner

    private lateinit var stateText: TextView
    private lateinit var installedText: TextView
    private lateinit var channelText: TextView
    private lateinit var notesLabel: TextView
    private lateinit var notesText: TextView
    private lateinit var primary: Button
    private lateinit var secondary: Button

    private var apkToInstall: UpdateDownloader.VerifiedApk? = null

    private val listener = UpdateOwner.Listener { state -> render(state) }

    fun build(): View {
        val view = host.layoutInflater.inflate(R.layout.fragment_updates, null, false)

        stateText = view.findViewById(R.id.updates_state)
        installedText = view.findViewById(R.id.updates_installed)
        channelText = view.findViewById(R.id.updates_channel)
        notesLabel = view.findViewById(R.id.updates_notes_label)
        notesText = view.findViewById(R.id.updates_notes)
        primary = view.findViewById(R.id.updates_primary)
        secondary = view.findViewById(R.id.updates_secondary)

        installedText.text = UpdateService.installedVersionName(host)
        channelText.text = if (owner.currentChannel == UpdateManifest.CHANNEL_STAGING) {
            "STAGING (pruebas)"
        } else {
            "Estable"
        }

        view.findViewById<View>(R.id.updates_back).setOnClickListener {
            host.openSettings()
        }
        primary.setOnClickListener { onPrimary() }
        secondary.setOnClickListener { onSecondary() }

        // Sin esto la pantalla se queda congelada en el estado inicial: la
        // comprobacion ocurre en segundo plano y sin observarla nadie se entera.
        owner.observe(listener)
        render(owner.state())
        return view
    }

    /** El owner se observa mientras la pantalla esta viva y se suelta al salir. */
    fun release() {
        owner.unobserve(listener)
    }

    private fun render(state: UpdateOwner.State) {
        if (host.isFinishing) return
        val context = host
        val accent = ApolloColors.accent(context)
        val muted = ApolloColors.muted(context)

        fun set(text: String, color: Int = muted) {
            stateText.text = text
            stateText.setTextColor(color)
        }

        when (state) {
            is UpdateOwner.State.SinComprobar ->
                set("Todavía no se comprobó")
            is UpdateOwner.State.Comprobando ->
                set("Comprobando…")
            is UpdateOwner.State.AlDia ->
                set("Apollo está al día", accent)
            is UpdateOwner.State.Disponible -> {
                set("Hay una versión nueva: ${state.manifest.versionName}", accent)
                val notes = state.manifest.notes.takeIf { it.isNotBlank() }
                notesLabel.visibility = if (notes == null) View.GONE else View.VISIBLE
                notesText.visibility = notesLabel.visibility
                notesText.text = notes.orEmpty()
                primary.text = "Descargar"
                primary.isEnabled = true
                secondary.visibility = View.GONE
            }
            is UpdateOwner.State.Descargando -> {
                val percent = if (state.totalBytes > 0) {
                    (state.bytesRead * 100 / state.totalBytes).coerceIn(0L, 100L)
                } else {
                    0L
                }
                set("Descargando… $percent%")
                primary.text = "Descargando…"
                primary.isEnabled = false
                secondary.visibility = View.GONE
            }
            is UpdateOwner.State.VerificadoParaInstalar -> {
                apkToInstall = state.apk
                set("Descarga verificada: tamaño y SHA-256 coinciden.", accent)
                primary.text = "Comprobar de nuevo"
                primary.isEnabled = true
                secondary.text = "Instalar ${state.apk.versionName}"
                secondary.visibility = View.VISIBLE
            }
            is UpdateOwner.State.InstaladorAbierto -> {
                apkToInstall = null
                set("Instalador de Android abierto. Termina la instalación y volvé a Apollo.", accent)
                primary.text = "Comprobar actualizaciones"
                primary.isEnabled = true
                secondary.visibility = View.GONE
            }
            is UpdateOwner.State.FaltaPermisoDeInstalacion ->
                set("Falta permiso para instalar. Abrí los ajustes del sistema.", ApolloColors.muted(context))
            is UpdateOwner.State.Error ->
                set(
                    if (state.recuperable) {
                        "No se pudo actualizar: ${state.motivo}. Podés reintentar."
                    } else {
                        "La actualización fue rechazada: ${state.motivo}"
                    },
                    0xFFFF6A4A.toInt(),
                )
        }
    }

    private fun onPrimary() {
        when (owner.state()) {
            is UpdateOwner.State.SinComprobar,
            is UpdateOwner.State.AlDia,
            is UpdateOwner.State.Error,
            -> owner.comprobarAhora()
            is UpdateOwner.State.Disponible -> owner.descargar()
            is UpdateOwner.State.FaltaPermisoDeInstalacion -> {
                val intent = UpdateDownloader.installPermissionSettingsIntent(host)
                if (intent != null) host.startActivity(intent)
            }
            else -> owner.comprobarAhora()
        }
    }

    private fun onSecondary() {
        val apk = apkToInstall ?: return
        // Se revalida el archivo justo antes de tocar el instalador: si cambio
        // desde que se verifico, se aborta y hay que comprobar de nuevo.
        val problem = UpdateDownloader.reverifyBeforeInstall(apk)
        if (problem != null) {
            apk.file.delete()
            apkToInstall = null
            owner.comprobarAhora()
            return
        }
        if (!UpdateDownloader.canRequestInstall(host)) {
            owner.comprobarPermisoDeInstalacion(concedido = false)
            return
        }
        val intent = UpdateDownloader.buildInstallerIntent(host, apk)
        if (intent != null) {
            apkToInstall = null
            host.startActivity(intent)
        }
    }
}
