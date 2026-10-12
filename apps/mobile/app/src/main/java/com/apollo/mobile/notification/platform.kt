package com.apollo.mobile.notification

/**
 * Evento del calendario tal como lo devuelve el peer. Es un DTO, no una entidad
 * de Android: el dispatcher lo puede construir en la JVM sin `ContentResolver`.
 */
data class CalendarEventSummary(
    val title: String,
    val startsAt: String,
    val location: String
)

/**
 * Por que el telefono no puede reproducir (BLOCK 11 §17).
 *
 * Distinguir `Unresolvable` de `Failed` importa porque son fallos distintos para
 * Apollo: `Unresolvable` significa "falta resolver la query a una URL, y eso es
 * del backend", mientras que `Failed` es un error real del player.
 */
sealed class MediaPlayOutcome {
    object Started : MediaPlayOutcome()
    object Unresolvable : MediaPlayOutcome()
    object Failed : MediaPlayOutcome()
}

/**
 * Puerto de plataforma (BLOCK 11 §17). Cada comando mobile declara aca que
 * necesita; la implementacion real vive en otra parte, asi que el dispatcher se
 * puede probar entero en la JVM sin Android ni hardware.
 *
 * Los comandos de lectura devuelven datos en vez de un booleano: `volume_get` y
 * `calendar_list` existen justamente para reportar estado.
 */
interface MobilePlatform {
    fun showNotification(title: String, body: String): Boolean
    fun setAlarm(label: String, hourMinute: String, repeatDaily: Boolean): Boolean
    fun cancelAlarm(label: String): Boolean
    fun createCalendarEvent(title: String, startsAt: String, location: String): Boolean
    fun cancelCalendarEvent(title: String): Boolean
    fun listCalendarEvents(withinDays: Int): List<CalendarEventSummary>
    fun playMedia(query: String): MediaPlayOutcome
    fun pauseMedia(): Boolean
    fun nextMedia(): Boolean
    fun previousMedia(): Boolean
    fun setVolume(level: Int): Boolean
    /** Nivel de 0 a 100, o `null` si el stream no existe en este dispositivo. */
    fun getVolumeLevel(): Int?
    fun openApp(appName: String): Boolean
}
