package com.apollo.mobile.command

import com.apollo.mobile.contract.Contract
import org.json.JSONObject

/**
 * Validacion de payload por capability (BLOCK 11 §17). Refleja
 * `apps/agent/src/devices/payload.ts`: los mismos campos, los mismos limites y
 * el mismo rechazo de campos extra.
 *
 * La plataforma Android no se toca aca: esto decide si el comando se ejecuta.
 */
object PayloadValidator {

    sealed class Result {
        data class Valid(val payload: Map<String, Any?>) : Result()
        data class Invalid(val reason: String) : Result()
    }

    /**
     * El schema lo define el COMANDO, no la capability. Esto lo cambio la
     * ejecucion real del cliente: `alarm_set` manda `{hourMinute, label}` y
     * `alarm_cancel` manda `{label}`, asi que un schema por capability hacia que
     * cancelar una alarma fallara siempre con `invalid_payload`.
     *
     * Refleja `apps/agent/src/devices/payload.ts`.
     */
    fun validate(commandName: String, payload: Map<String, Any?>): Result =
        when (commandName) {
            "notification_post" -> validateNotification(payload)
            "alarm_set" -> validateAlarmSet(payload)
            "alarm_cancel" -> validateAlarmCancel(payload)
            "calendar_create" -> validateCalendarCreate(payload)
            "calendar_list" -> validateCalendarList(payload)
            "calendar_cancel" -> validateCalendarCancel(payload)
            "media_play", "media_pause", "media_next", "media_previous" -> validateMedia(payload)
            "volume_set" -> validateVolumeSet(payload)
            "volume_get" -> validateVolumeGet(payload)
            "app_open" -> validateOpenApp(payload)
            else -> Result.Invalid("unsupported_command")
        }

    private fun validateNotification(payload: Map<String, Any?>): Result {
        if (hasExtraField(payload, "title", "body")) {
            return Result.Invalid("unexpected_field")
        }
        val title = readBoundedString(payload, "title", Contract.NOTIFICATION_TITLE_MAX_LENGTH)
            ?: return Result.Invalid("invalid_title")
        val body = readBoundedString(payload, "body", Contract.NOTIFICATION_BODY_MAX_LENGTH)
            ?: return Result.Invalid("invalid_body")
        return Result.Valid(mapOf("title" to title, "body" to body))
    }

    private fun validateAlarmSet(payload: Map<String, Any?>): Result {
        if (hasExtraField(payload, "hourMinute", "label", "repeatDaily")) {
            return Result.Invalid("unexpected_field")
        }
        val hourMinute = readBoundedString(payload, "hourMinute", 5)
            ?: return Result.Invalid("invalid_hour_minute")
        if (!HOUR_MINUTE_PATTERN.matches(hourMinute)) {
            return Result.Invalid("invalid_hour_minute")
        }
        val label = readBoundedString(payload, "label", Contract.ALARM_LABEL_MAX_LENGTH)
            ?: return Result.Invalid("invalid_alarm_label")
        val repeatDaily = payload["repeatDaily"]
        if (repeatDaily != null && repeatDaily !is Boolean) {
            return Result.Invalid("invalid_repeat_daily")
        }
        return Result.Valid(
            mapOf(
                "hourMinute" to hourMinute,
                "label" to label,
                "repeatDaily" to (repeatDaily as? Boolean ?: false)
            )
        )
    }

    private fun validateAlarmCancel(payload: Map<String, Any?>): Result {
        if (hasExtraField(payload, "label")) {
            return Result.Invalid("unexpected_field")
        }
        val label = readBoundedString(payload, "label", Contract.ALARM_LABEL_MAX_LENGTH)
            ?: return Result.Invalid("invalid_alarm_label")
        return Result.Valid(mapOf("label" to label))
    }

    private fun validateCalendarCreate(payload: Map<String, Any?>): Result {
        if (hasExtraField(payload, "title", "startsAt", "location")) {
            return Result.Invalid("unexpected_field")
        }
        val title = readBoundedString(payload, "title", Contract.EVENT_TITLE_MAX_LENGTH)
            ?: return Result.Invalid("invalid_event_title")
        val startsAt = readBoundedString(payload, "startsAt", 40)
            ?: return Result.Invalid("invalid_starts_at")
        val location = payload["location"]
        if (location != null && location !is String) {
            return Result.Invalid("invalid_location")
        }
        return Result.Valid(
            mapOf(
                "title" to title,
                "startsAt" to startsAt,
                "location" to (location as? String ?: "")
            )
        )
    }

    private fun validateCalendarList(payload: Map<String, Any?>): Result {
        if (hasExtraField(payload, "withinDays")) {
            return Result.Invalid("unexpected_field")
        }
        val withinDays = payload["withinDays"]
        if (withinDays == null) {
            return Result.Valid(mapOf("withinDays" to 1))
        }
        if (withinDays !is Int || withinDays < 1 || withinDays > 30) {
            return Result.Invalid("invalid_within_days")
        }
        return Result.Valid(mapOf("withinDays" to withinDays))
    }

    private fun validateCalendarCancel(payload: Map<String, Any?>): Result {
        if (hasExtraField(payload, "title")) {
            return Result.Invalid("unexpected_field")
        }
        val title = readBoundedString(payload, "title", Contract.EVENT_TITLE_MAX_LENGTH)
            ?: return Result.Invalid("invalid_event_title")
        return Result.Valid(mapOf("title" to title))
    }

    private fun validateMedia(payload: Map<String, Any?>): Result {
        if (hasExtraField(payload, "query")) {
            return Result.Invalid("unexpected_field")
        }
        val rawQuery = payload["query"]
        if (rawQuery == null) {
            return Result.Valid(emptyMap())
        }
        if (rawQuery !is String) {
            return Result.Invalid("invalid_query")
        }
        if (rawQuery.length > Contract.MEDIA_QUERY_MAX_LENGTH) {
            return Result.Invalid("invalid_query")
        }
        return Result.Valid(mapOf("query" to rawQuery))
    }

    private fun validateVolumeSet(payload: Map<String, Any?>): Result {
        if (hasExtraField(payload, "level")) {
            return Result.Invalid("unexpected_field")
        }
        val level = payload["level"]
        if (level !is Int || level < 0 || level > 100) {
            return Result.Invalid("invalid_volume_level")
        }
        return Result.Valid(mapOf("level" to level))
    }

    private fun validateVolumeGet(payload: Map<String, Any?>): Result {
        if (hasExtraField(payload)) {
            return Result.Invalid("unexpected_field")
        }
        return Result.Valid(emptyMap())
    }

    private fun validateOpenApp(payload: Map<String, Any?>): Result {
        if (hasExtraField(payload, "appName")) {
            return Result.Invalid("unexpected_field")
        }
        val appName = readBoundedString(payload, "appName", 64) ?: return Result.Invalid("invalid_app_name")
        return Result.Valid(mapOf("appName" to appName))
    }

    private fun hasExtraField(payload: Map<String, Any?>, vararg allowed: String): Boolean =
        payload.keys.any { it !in allowed }

    private fun readBoundedString(
        payload: Map<String, Any?>,
        fieldName: String,
        maxLength: Int
    ): String? {
        val rawValue = payload[fieldName]
        if (rawValue !is String) {
            return null
        }
        if (rawValue.isEmpty() || rawValue.length > maxLength) {
            return null
        }
        return rawValue
    }

    private val HOUR_MINUTE_PATTERN = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")
}
