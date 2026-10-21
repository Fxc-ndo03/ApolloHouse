package com.apollo.mobile.ui

import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.apollo.mobile.R
import com.apollo.mobile.ShellActivity
import com.apollo.mobile.identity.AccountSessionStore
import com.apollo.mobile.session.MobileSessionState

/**
 * Inicio movil: la identidad de Apollo y el acceso a lo principal.
 *
 * Es el equivalente de la pantalla "Inicio" de escritorio (orbe, saludo,
 * accesos rapidos), no un panel de diagnostico.
 */
class Home(private val host: ShellActivity) {

    private var statusView: TextView? = null

    fun build(): View {
        val view = host.layoutInflater.inflate(R.layout.fragment_home, null, false)

        val orb = view.findViewById<com.apollo.mobile.ui.ApolloOrbView>(R.id.home_orb)
        orb.start()

        statusView = view.findViewById(R.id.home_status)

        view.findViewById<View>(R.id.home_chat).setOnClickListener {
            host.startActivity(android.content.Intent(
                host,
                com.apollo.mobile.conversation.ConversationActivity::class.java,
            ))
        }

        buildShortcuts(view.findViewById(R.id.home_shortcuts))
        buildStatusCard(view.findViewById(R.id.home_status_card))

        val account = AccountSessionStore(host).readAccountId()
        view.findViewById<TextView>(R.id.home_status).setTextColor(ApolloColors.muted(host))
        account
        return view
    }

    private fun buildShortcuts(container: LinearLayout) {
        val shortcuts = listOf(
            "¿Qué podés hacer?" to "Una vista rápida de tus opciones",
            "Contame las noticias" to "Novedades del día",
            "Abrí el navegador" to "Controlá tu equipo",
        )
        val context = host
        shortcuts.forEach { (label, sub) ->
            val row = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundResource(R.drawable.apollo_card)
                val pad = (16 * resources.displayMetrics.density).toInt()
                setPadding(pad, pad, pad, pad)
                isClickable = true
                isFocusable = true
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { bottomMargin = pad / 2 }
            }
            val title = TextView(context).apply {
                text = label
                setTextColor(ApolloColors.text(context))
                textSize = 16f
            }
            val subtitle = TextView(context).apply {
                text = sub
                setTextColor(ApolloColors.muted(context))
                textSize = 13f
            }
            row.addView(title)
            row.addView(subtitle)
            row.setOnClickListener {
                host.startActivity(android.content.Intent(
                    host,
                    com.apollo.mobile.conversation.ConversationActivity::class.java,
                ).putExtra("prefill", label))
            }
            container.addView(row)
        }
    }

    private fun buildStatusCard(container: LinearLayout) {
        val context = host
        val application = host.application as com.apollo.mobile.ApolloApplication
        val accountId = AccountSessionStore(context).readAccountId()

        addRow(container, "Cuenta", accountId ?: "sin sesión")
        addRow(container, "Servidor", application.workerHost.ifBlank { "(sin configurar)" })

        application.sessionOwner.observe(object : com.apollo.mobile.session.MobileSessionOwner.SessionListener {
            override fun onStateChanged(state: MobileSessionState) {
                if (host.isFinishing) return
                host.runOnUiThread {
                    statusView?.text = describe(state)
                    statusView?.setTextColor(
                        if (state == MobileSessionState.ONLINE || state == MobileSessionState.AUTHENTICATED) {
                            ApolloColors.accent(context)
                        } else {
                            ApolloColors.muted(context)
                        },
                    )
                }
            }
        })
    }

    private fun addRow(container: LinearLayout, label: String, value: String) {
        val context = host
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
        }
        val title = TextView(context).apply {
            text = label
            setTextColor(ApolloColors.text(context))
            textSize = 15f
        }
        val subtitle = TextView(context).apply {
            text = value
            setTextColor(ApolloColors.muted(context))
            textSize = 13f
        }
        row.addView(title)
        row.addView(subtitle)
        container.addView(row)
    }

    private fun describe(state: MobileSessionState): String = when (state) {
        MobileSessionState.DISCONNECTED -> "Sin conexión"
        MobileSessionState.CONNECTING -> "Conectando…"
        MobileSessionState.RECONNECTING -> "Reconectando…"
        MobileSessionState.AUTHENTICATED -> "Autenticado"
        MobileSessionState.ONLINE -> "En línea"
    }
}
