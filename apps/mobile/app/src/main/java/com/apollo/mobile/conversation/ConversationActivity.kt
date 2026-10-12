package com.apollo.mobile.conversation

import android.app.Activity
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.apollo.mobile.R
import com.apollo.mobile.transport.DeviceCredential

/**
 * Pantalla de conversación con Apollo.
 *
 * Es una `Activity` y no un `Fragment` porque la conexión la mantiene el
 * Foreground Service, no esta pantalla: entrar y salir de la Activity no debe
 * cortar el turno en curso.
 */
class ConversationActivity : Activity() {

    private lateinit var turnListView: LinearLayout
    private lateinit var statusText: TextView
    private lateinit var inputField: EditText
    private lateinit var sendButton: Button
    private lateinit var abortButton: Button
    private var lastRenderedTurnCount = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_conversation)
        val application = application as com.apollo.mobile.ApolloApplication
        // Se carga una vez y se guarda al terminar la sesión de esta pantalla.
        // El store es quien lee/escribe: la pantalla no toca archivos.
        application.loadConversationHistoryOnce()
        bindViews()
        wireInput()
        renderHistory(force = true)
        observeOwner()
    }

    private fun bindViews() {
        turnListView = findViewById(R.id.conversation_turn_list)
        statusText = findViewById(R.id.conversation_status)
        inputField = findViewById(R.id.conversation_input)
        sendButton = findViewById(R.id.conversation_send)
        abortButton = findViewById(R.id.conversation_abort)
    }

    private fun wireInput() {
        sendButton.setOnClickListener { sendCurrentInput() }
        abortButton.setOnClickListener {
            val application = application as com.apollo.mobile.ApolloApplication
            application.conversationOwner.abort()
        }
        // El botón se habilita recién con texto: mandar `text_input` vacío lo
        // rechaza el servidor y sería una respuesta falsa en pantalla.
        inputField.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                sendButton.isEnabled = !s.isNullOrBlank()
            }
        })
    }

    private fun observeOwner() {
        val application = application as com.apollo.mobile.ApolloApplication
        application.conversationOwner.stateListener = { nextState ->
            renderStatus(nextState)
        }
        application.conversationOwner.turnListener = { turnList ->
            renderHistory(force = false, turnList = turnList)
        }
        application.conversationOwner.noticeListener = { detail ->
            Toast.makeText(this, detail, Toast.LENGTH_LONG).show()
        }
        renderStatus(application.conversationOwner.state)
    }

    private fun sendCurrentInput() {
        val text = inputField.text.toString()
        if (text.isBlank()) return
        val application = application as com.apollo.mobile.ApolloApplication
        val turnId = application.conversationOwner.send(text)
        if (turnId == null) {
            // No se finge una respuesta: se dice que no se pudo mandar.
            Toast.makeText(
                this,
                "No hay conexion con Apollo. El mensaje no se envio.",
                Toast.LENGTH_LONG
            ).show()
            return
        }
        inputField.setText("")
    }

    private fun renderStatus(state: ConversationState) {
        statusText.text = when (state) {
            ConversationState.DISCONNECTED -> "Sin conexion"
            ConversationState.CONNECTING -> "Conectando con Apollo..."
            ConversationState.AWAITING_HELLO -> "Identificandose ante Apollo..."
            ConversationState.ONLINE -> "Conectado"
            ConversationState.DENIED -> "Apollo rechazo esta identidad"
            ConversationState.RETRY_WAIT -> "Reintentando..."
        }
    }

    private fun renderHistory(force: Boolean, turnList: List<ConversationTurn>? = null) {
        val application = application as com.apollo.mobile.ApolloApplication
        val turns = turnList ?: application.conversationHistory.snapshot()
        if (!force && turns.size == lastRenderedTurnCount) return
        turnListView.removeAllViews()
        for (turn in turns) {
            turnListView.addView(buildTurnView(turn))
        }
        lastRenderedTurnCount = turns.size
        (turnListView.parent as? ScrollView)?.post {
            (turnListView.parent as ScrollView).fullScroll(View.FOCUS_DOWN)
        }
    }

    private fun buildTurnView(turn: ConversationTurn): View {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            // Margen: sin esto los turnos quedan pegados al borde en pantallas
            // con cutout (edge-to-edge desde targetSdk 35).
            setPadding(dp(12), dp(6), dp(12), dp(6))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        val whoText = TextView(this).apply {
            text = if (turn.role == ConversationTurn.TurnRole.USER) "Vos" else "Apollo"
            setTextColor(0xFF6B7280.toInt())
            textSize = 12f
        }
        val bodyText = TextView(this).apply {
            text = turn.text
            textSize = 16f
            setTextColor(0xFF111827.toInt())
        }
        val stateText = TextView(this).apply {
            text = when (turn.state) {
                ConversationTurn.TurnState.SENT -> "enviado"
                ConversationTurn.TurnState.ANSWERED -> "respondido"
                ConversationTurn.TurnState.FAILED -> "fallo"
            }
            textSize = 11f
            setTextColor(0xFF9CA3AF.toInt())
        }
        container.addView(whoText)
        container.addView(bodyText)
        container.addView(stateText)
        return container
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    override fun onDestroy() {
        // Se sueltan los listeners: la sesión vive en la Application y no debe
        // quedar apuntando a una Activity destruida.
        val application = application as com.apollo.mobile.ApolloApplication
        application.conversationOwner.stateListener = null
        application.conversationOwner.turnListener = null
        application.conversationOwner.noticeListener = null
        // Se guarda siempre, no sólo si completó: un proceso matado por el
        // sistema llama a onDestroy, y los turnos no vuelven solos.
        application.conversationHistoryStore.saveHistory()
        super.onDestroy()
    }
}
