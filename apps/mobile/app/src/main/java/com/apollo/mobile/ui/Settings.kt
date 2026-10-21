package com.apollo.mobile.ui

import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.apollo.mobile.ApolloApplication
import com.apollo.mobile.R
import com.apollo.mobile.ShellActivity

/** Ajustes: apariencia, conexion y acceso al actualizador. */
class Settings(private val host: ShellActivity) {

    fun build(): View {
        val view = host.layoutInflater.inflate(R.layout.fragment_settings, null, false)
        val context = host
        val application = context.applicationContext as ApolloApplication

        view.findViewById<TextView>(R.id.settings_theme).text =
            "Oscuro"
        view.findViewById<TextView>(R.id.settings_language).text = "Español"

        val connection = view.findViewById<LinearLayout>(R.id.settings_connection)
        addRow(connection, "Servidor", application.workerHost.ifBlank { "(sin configurar)" })
        addRow(connection, "Canal de actualizaciones", if (application.isDebugBuild()) "staging (debug)" else "estable")

        view.findViewById<View>(R.id.settings_updates).setOnClickListener {
            host.openUpdates()
        }
        view.findViewById<View>(R.id.settings_device).setOnClickListener {
            host.startActivity(android.content.Intent(host, com.apollo.mobile.DeviceActivity::class.java))
        }
        view.findViewById<View>(R.id.settings_notifications).setOnClickListener {
            com.apollo.mobile.notification.NotificationPermissionRequest(host)
                .request { /* el resultado ya se refleja en el sistema */ }
        }
        return view
    }

    private fun ApolloTheme_isDark(context: android.content.Context) = ApolloColors.isDark(context)

    private fun addRow(container: LinearLayout, label: String, value: String) {
        val context = host
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
        }
        row.addView(TextView(context).apply {
            text = label
            setTextColor(ApolloColors.text(context))
            textSize = 15f
        })
        row.addView(TextView(context).apply {
            text = value
            setTextColor(ApolloColors.muted(context))
            textSize = 13f
        })
        container.addView(row)
    }
}
