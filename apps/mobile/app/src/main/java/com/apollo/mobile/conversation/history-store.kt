package com.apollo.mobile.conversation

import android.content.Context
import java.io.File

/**
 * Persistencia del historial de conversación en el almacenamiento de la app.
 *
 * Es un archivo plano, y no Keystore, porque el historial NO es secreto: es el
 * texto que el usuario ya vio en pantalla. Cifrarlo dos veces sobre el mismo
 * dispositivo es ceremonia que no añade seguridad real (la llave estaría al lado).
 *
 * Lo que **nunca** va acá: credencial, challenge, token. Esos siguen siendo
 * propiedad del Keystore ([com.apollo.mobile.transport.CredentialStore]).
 */
class ConversationHistoryStore(
    context: Context,
    private val history: ConversationHistory
) {

    /** `MODE_PRIVATE`: ninguna otra app lo lee. */
    private val historyFile = File(context.filesDir, "apollo_conversation_history.json")

    fun readHistory(): ConversationHistory {
        if (!historyFile.exists()) return history
        val serialized = runCatching { historyFile.readText() }.getOrNull() ?: return history
        history.deserialize(serialized)
        return history
    }

    fun saveHistory() {
        // La escritura es atómica: escribir a un .tmp y renombrar es lo que
        // evita un historial corrupto si el proceso se mata a mitad de write.
        val temporaryFile = File(historyFile.parent, "${historyFile.name}.tmp")
        temporaryFile.writeText(history.serialize())
        if (!temporaryFile.renameTo(historyFile)) {
            // Un rename fallido es informativo, no crash: el historial actual
            // del disco queda intacto y se sobrescribe la próxima vez.
            temporaryFile.delete()
        }
    }

    fun deleteHistory() {
        historyFile.delete()
        File(historyFile.parent, "${historyFile.name}.tmp").delete()
    }
}
