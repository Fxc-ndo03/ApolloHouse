package com.apollo.mobile.command

import com.apollo.mobile.notification.MediaPlayOutcome
import com.apollo.mobile.notification.MobilePlatform
import com.apollo.mobile.notification.NotificationAdapter
import com.apollo.mobile.notification.PermissionOutcome

/**
 * Cadena de seguridad antes de ejecutar un comando (BLOCK 11 §5, §11 y §16).
 *
 * Orden, y el orden importa:
 *   1. sesion autenticada
 *   2. capability allowlisted
 *   3. comando declarado por ESA capability (no hay lookup dinamico)
 *   4. target compatible si viene en el envelope
 *   5. requestId duplicado en vuelo -> no se ejecuta dos veces
 *   6. payload valido segun la capability
 *   7. recien ahi se toca la plataforma
 */
class CommandDispatcher(
    private val notificationAdapter: NotificationAdapter,
    private val platform: MobilePlatform
) {

    sealed class Outcome {
        /**
         * `result` viaja en el `command_result` del wire: los comandos de lectura
         * (`volume_get`, `calendar_list`) no pueden contestar con un booleano.
         */
        data class Executed(val result: Map<String, Any?>) : Outcome()
        data class Rejected(val reason: String) : Outcome()
    }

    private val inFlightRequestIdSet = mutableSetOf<String>()

    val inFlightRequestIdSnapshot: Set<String>
        get() = inFlightRequestIdSet.toSet()

    fun dispatch(input: DispatchInput): Outcome {
        if (!input.isAuthenticated) {
            return Outcome.Rejected("not_authenticated")
        }
        if (!CommandAllowlist.isAllowed(input.capabilityName)) {
            return Outcome.Rejected("unsupported_command")
        }
        if (!CommandAllowlist.isCommandDeclaredByCapability(input.capabilityName, input.commandName)) {
            return Outcome.Rejected("unsupported_command")
        }
        if (input.targetDeviceId != null && input.targetDeviceId != input.deviceId) {
            return Outcome.Rejected("target_mismatch")
        }
        if (!inFlightRequestIdSet.add(input.requestId)) {
            return Outcome.Rejected("duplicate_in_flight")
        }
        try {
            return execute(input)
        } finally {
            inFlightRequestIdSet.remove(input.requestId)
        }
    }

    private fun execute(input: DispatchInput): Outcome {
        val validation = PayloadValidator.validate(input.commandName, input.payload)
        if (validation !is PayloadValidator.Result.Valid) {
            return Outcome.Rejected((validation as PayloadValidator.Result.Invalid).reason)
        }
        val payload = validation.payload
        if (input.capabilityName == "mobile.notifications") {
            if (notificationAdapter.requestPermission() !is PermissionOutcome.Granted) {
                return Outcome.Rejected("permission_denied")
            }
            val title = payload["title"] as String
            val body = payload["body"] as String
            return if (notificationAdapter.post(title, body)) {
                Outcome.Executed(mapOf("posted" to true))
            } else {
                Outcome.Rejected("post_failed")
            }
        }
        return runPlatformCommand(input.commandName, payload)
    }

    /**
     * Cada comando declarado por una capability mobile llega a la plataforma. Un
     * comando sin rama NO puede caer a un `true` generico: seria reportar exito
     * sin efecto, que es el bug que BLOCK 11 §17 prohibe.
     */
    private fun runPlatformCommand(
        commandName: String,
        payload: Map<String, Any?>
    ): Outcome = when (commandName) {
        "alarm_set" -> platform.setAlarm(
            payload["label"] as String,
            payload["hourMinute"] as String,
            payload["repeatDaily"] as? Boolean ?: false
        ).asOutcome()
        "alarm_cancel" -> platform.cancelAlarm(payload["label"] as String).asOutcome()
        "calendar_create" -> platform.createCalendarEvent(
            payload["title"] as String,
            payload["startsAt"] as String,
            payload["location"] as? String ?: ""
        ).asOutcome()
        "calendar_cancel" -> platform.cancelCalendarEvent(payload["title"] as String).asOutcome()
        "calendar_list" -> Outcome.Executed(
            mapOf(
                "events" to platform.listCalendarEvents(
                    payload["withinDays"] as? Int ?: DEFAULT_CALENDAR_WINDOW_DAYS
                ).map { eventSummary ->
                    mapOf(
                        "title" to eventSummary.title,
                        "startsAt" to eventSummary.startsAt,
                        "location" to eventSummary.location
                    )
                }
            )
        )
        "media_play" -> when (platform.playMedia(payload["query"] as? String ?: "")) {
            MediaPlayOutcome.Started -> Outcome.Executed(mapOf("playing" to true))
            // No se pudo reproducir porque la query no es una URI: falta el
            // resolvedor del backend, y Apollo tiene que poder distinguirlo.
            MediaPlayOutcome.Unresolvable -> Outcome.Rejected("media_unresolvable")
            MediaPlayOutcome.Failed -> Outcome.Rejected("media_failed")
        }
        "media_pause" -> platform.pauseMedia().asOutcome()
        "media_next" -> platform.nextMedia().asOutcome()
        "media_previous" -> platform.previousMedia().asOutcome()
        "volume_set" -> platform.setVolume(payload["level"] as Int).asOutcome()
        "volume_get" -> platform.getVolumeLevel()
            ?.let { level -> Outcome.Executed(mapOf("level" to level)) }
            ?: Outcome.Rejected("volume_unavailable")
        "app_open" -> platform.openApp(payload["appName"] as String).asOutcome()
        else -> Outcome.Rejected("unsupported_command")
    }

    private fun Boolean.asOutcome(): Outcome =
        if (this) Outcome.Executed(mapOf("applied" to true)) else Outcome.Rejected("platform_rejected")

    companion object {
        const val DEFAULT_CALENDAR_WINDOW_DAYS = 1
    }

    data class DispatchInput(
        val deviceId: String,
        val requestId: String,
        val capabilityName: String,
        val commandName: String,
        val payload: Map<String, Any?>,
        val targetDeviceId: String?,
        val isAuthenticated: Boolean
    )
}
