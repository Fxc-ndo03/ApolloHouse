package com.apollo.mobile.conversation

/**
 * FASE 3.20: captions "transitorios" son estado de UI, no la respuesta.
 *
 * El Worker manda `ui_state` durante todo el turno (`Pensando…`, `Escuchando…`,
 * `Hablando…`) y al final manda el texto real en el mismo campo. Si se pintan
 * todos, el chat se llena de ruido y la respuesta real se pierde entre captions
 * de estado.
 *
 * Mismo criterio que usa el cliente de escritorio.
 */
fun isTransientCaption(captionText: String): Boolean {
    val trimmed = captionText.trim()
    if (trimmed.isEmpty()) return true
    return trimmed.endsWith("…") || trimmed.endsWith("...")
}