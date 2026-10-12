package com.apollo.mobile.contract

/**
 * Contrato de wire del cuerpo mobile. Todos los valores salen del lado Cloudflare:
 * `apps/agent/src/protocol/schema.ts`, `apps/agent/src/devices/identity.ts`,
 * `apps/agent/src/devices/capability.ts`, `apps/agent/src/devices/payload.ts` y
 * `apps/agent/src/devices/presence.ts`.
 *
 * BLOCK 11 §17: se agregaron las capabilities mobile que el Worker implementó de
 * verdad. El peer sólo acepta un comando si su capability lo declara: no hay
 * lookup dinámico ni método por reflexión.
 *
 * `apps/mobile/__tests__/contract.spec.ts` ata estas constantes al lado TypeScript
 * con un gate que corre en cada `bun run test`, porque este cliente Kotlin no se
 * puede compilar en el entorno del repo.
 */
object Contract {

    const val MOBILE_BRIDGE_PATH: String = "/agents/mobile-bridge/mobile"

    const val DEVICE_TYPE: String = "mobile"

    const val DEVICE_ID_PREFIX: String = "mobile:"

    const val PROTOCOL_VERSION: Int = 1

    val ANNOUNCED_CAPABILITY_LIST: List<String> = listOf(
        "mobile.notifications",
        "mobile.alarm",
        "mobile.calendar",
        "mobile.media",
        "mobile.volume",
        "mobile.open_app"
    )

    /** capability -> comandos que el peer ejecuta de verdad. */
    val ALLOWED_COMMAND_MAP: Map<String, List<String>> = mapOf(
        "mobile.notifications" to listOf("notification_post"),
        "mobile.alarm" to listOf("alarm_set", "alarm_cancel"),
        "mobile.calendar" to listOf("calendar_create", "calendar_list", "calendar_cancel"),
        "mobile.media" to listOf("media_play", "media_pause", "media_next", "media_previous"),
        "mobile.volume" to listOf("volume_set", "volume_get"),
        "mobile.open_app" to listOf("app_open")
    )

    const val NOTIFICATION_TITLE_MAX_LENGTH: Int = 120

    const val NOTIFICATION_BODY_MAX_LENGTH: Int = 500

    const val EVENT_TITLE_MAX_LENGTH: Int = 120

    const val ALARM_LABEL_MAX_LENGTH: Int = 80

    const val MEDIA_QUERY_MAX_LENGTH: Int = 120

    /**
     * El intervalo autoritativo lo manda `hello_accepted.heartbeatIntervalMilliseconds`.
     * Este valor solo se usa si el server no lo manda.
     */
    const val FALLBACK_HEARTBEAT_INTERVAL_MILLISECONDS: Long = 30_000L

    // Tabla de backoff que ya fija APOLLO_ANDROID_SOURCE_OF_TRUTH.md §10 para el
    // cuerpo Android: 1s, 2s, 4s, 8s, 16s y 30s como tope.
    val RECONNECT_BACKOFF_MILLISECOND_LIST: List<Long> =
        listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L)
}
