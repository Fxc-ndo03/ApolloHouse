package com.apollo.mobile

import com.apollo.mobile.command.CommandDispatcher
import com.apollo.mobile.command.PayloadValidator
import com.apollo.mobile.contract.Contract
import com.apollo.mobile.notification.CalendarEventSummary
import com.apollo.mobile.notification.MediaPlayOutcome
import com.apollo.mobile.notification.PermissionOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tests 10 a 14: allowlist explicita y payload estricto (BLOCK 11 §5, §7). */
class CommandTest {

    private fun buildDispatcher(
        permissionOutcome: PermissionOutcome = PermissionOutcome.Granted
    ): Triple<CommandDispatcher, FakeNotificationAdapter, RecordingMobilePlatform> {
        val notificationAdapter = FakeNotificationAdapter(permissionOutcome)
        val platform = RecordingMobilePlatform()
        return Triple(CommandDispatcher(notificationAdapter, platform), notificationAdapter, platform)
    }

    @Test
    fun acceptsTheAllowlistedNotificationCapability() {
        val (commandDispatcher, notificationAdapter, _) = buildDispatcher()

        assertTrue(commandDispatcher.dispatch(dispatchInput()).isExecuted())
        assertEquals(1, notificationAdapter.postCount)
    }

    @Test
    fun rejectsADesktopCapability() {
        val (commandDispatcher, notificationAdapter, platform) = buildDispatcher()

        val outcome = commandDispatcher.dispatch(
            dispatchInput(
                capabilityName = "desktop.notifications",
                commandName = "notification_post",
                payload = validPayloadFor("mobile.notifications")
            )
        )

        assertEquals(CommandDispatcher.Outcome.Rejected("unsupported_command"), outcome)
        assertEquals(0, notificationAdapter.postCount)
        assertEquals(0, platform.callList.size)
    }

    @Test
    fun rejectsAnUnimplementedMobileCapability() {
        val (commandDispatcher, notificationAdapter, platform) = buildDispatcher()

        // BLOCK 11: todas las mobile del catálogo están implementadas, así que la
        // capability no existe. El peer igual la rechaza por allowlist.
        listOf("mobile.telepathy", "mobile.radar", "mobile.bluetooth").forEach { capabilityName ->
            assertEquals(
                CommandDispatcher.Outcome.Rejected("unsupported_command"),
                commandDispatcher.dispatch(
                    dispatchInput(
                        capabilityName = capabilityName,
                        commandName = "algo",
                        payload = emptyMap()
                    )
                )
            )
        }
        assertEquals(0, notificationAdapter.postCount)
        assertEquals(0, platform.callList.size)
    }

    @Test
    fun rejectsACommandThatItsCapabilityDoesNotDeclare() {
        val (commandDispatcher, _, platform) = buildDispatcher()

        // mobile.media no declara `media_stop`: es exactamente el caso §16.
        val outcome = commandDispatcher.dispatch(
            dispatchInput(
                capabilityName = "mobile.media",
                commandName = "media_stop",
                payload = validPayloadFor("mobile.media")
            )
        )

        assertEquals(CommandDispatcher.Outcome.Rejected("unsupported_command"), outcome)
        assertEquals(0, platform.callList.size)
    }

    @Test
    fun rejectsAnInvalidPayload() {
        val (commandDispatcher, notificationAdapter, platform) = buildDispatcher()

        val invalidPayloadList = listOf(
            mapOf<String, Any?>("title" to "Apollo"),
            mapOf<String, Any?>("body" to "Hola"),
            mapOf<String, Any?>("title" to "Apollo", "body" to "Hola", "extra" to 1),
            mapOf<String, Any?>("title" to 7, "body" to "Hola"),
            mapOf<String, Any?>("title" to "Apollo", "body" to listOf("x")),
            mapOf<String, Any?>("title" to "", "body" to "Hola"),
            mapOf<String, Any?>("title" to "Apollo", "body" to ""),
            mapOf<String, Any?>("title" to "A".repeat(121), "body" to "Hola"),
            mapOf<String, Any?>("title" to "Apollo", "body" to "B".repeat(501))
        )
        invalidPayloadList.forEach { payload ->
            val outcome = commandDispatcher.dispatch(dispatchInput(payload = payload))
            assertTrue(
                "se esperaba rechazo para $payload, hubo $outcome",
                outcome is CommandDispatcher.Outcome.Rejected
            )
        }
        assertEquals(0, notificationAdapter.postCount)
        assertEquals(0, platform.callList.size)
    }

    @Test
    fun thePayloadValidatorIsStrictAboutBothDirections() {
        assertTrue(
            PayloadValidator.validate("notification_post", validPayloadFor("mobile.notifications"))
                is PayloadValidator.Result.Valid
        )
        assertEquals(
            "unexpected_field",
            (PayloadValidator.validate(
                "notification_post",
                mapOf("title" to "Apollo", "body" to "Hola", "icon" to "x")
            ) as PayloadValidator.Result.Invalid).reason
        )
        assertEquals(
            "invalid_title",
            (PayloadValidator.validate(
                "notification_post",
                mapOf("title" to null, "body" to "Hola")
            ) as PayloadValidator.Result.Invalid).reason
        )
        assertEquals(
            "invalid_hour_minute",
            (PayloadValidator.validate(
                "alarm_set",
                mapOf("hourMinute" to "25:00", "label" to "x")
            ) as PayloadValidator.Result.Invalid).reason
        )
        assertEquals(
            "invalid_volume_level",
            (PayloadValidator.validate(
                "volume_set",
                mapOf("level" to 140)
            ) as PayloadValidator.Result.Invalid).reason
        )
    }

    /**
     * BLOCK 11 §17: TODO comando que el catalogo declara tiene que llegar a la
     * plataforma.
     *
     * La lista NO esta escrita a mano: se deriva del propio catalogo. La version
     * anterior la escribia a mano y por eso `calendar_list` y `volume_get`
     * quedaron afuera del test mientras el peer los declaraba: el guard era
     * decorativo para justamente los dos comandos que no funcionaban.
     */
    @Test
    fun everyImplementedMobileCapabilityReachesItsPlatformCommand() {
        val (commandDispatcher, _, platform) = buildDispatcher()
        val declaredCommandSet = mutableSetOf<String>()
        for ((capabilityName, commandNameList) in Contract.ALLOWED_COMMAND_MAP) {
            for (commandName in commandNameList) {
                declaredCommandSet.add(commandName)
                assertTrue(
                    "$commandName esta en el catalogo pero ningun test sabe que efecto " +
                        "produce: no se puede agregar un comando sin efecto real",
                    EXPECTED_PLATFORM_CALL_BY_COMMAND.containsKey(commandName)
                )
                val expectedPlatformCall = EXPECTED_PLATFORM_CALL_BY_COMMAND[commandName]
                platform.callList.clear()
                val outcome = commandDispatcher.dispatch(
                    dispatchInput(
                        capabilityName = capabilityName,
                        commandName = commandName,
                        payload = payloadForCommand(capabilityName, commandName)
                    )
                )
                assertTrue(
                    "$capabilityName/$commandName no se ejecuto: $outcome",
                    outcome.isExecuted()
                )
                if (expectedPlatformCall == null) {
                    // mobile.notifications lo maneja el NotificationAdapter, que ya
                    // tiene su propio permiso y su propio camino de exito.
                    assertEquals(
                        "$capabilityName/$commandName no deberia tocar la plataforma",
                        emptyList<String>(),
                        platform.callList
                    )
                } else {
                    assertEquals(
                        "$capabilityName/$commandName llamo a otra cosa",
                        listOf(expectedPlatformCall),
                        platform.callList
                    )
                }
            }
        }
        assertEquals(
            "el catalogo y los efectos probados tienen que ser el mismo conjunto",
            EXPECTED_PLATFORM_CALL_BY_COMMAND.keys.toSet(),
            declaredCommandSet
        )
    }

    /** Los comandos de lectura contestan con datos, no con un booleano. */
    @Test
    fun aReadingCommandAnswersWithItsData() {
        val (commandDispatcher, _, platform) = buildDispatcher()
        platform.calendarEventSummaryList = listOf(
            CalendarEventSummary("Reunión", "2026-10-08T15:00:00", "Casa")
        )

        val calendarOutcome = commandDispatcher.dispatch(
            dispatchInput(
                capabilityName = "mobile.calendar",
                commandName = "calendar_list",
                payload = mapOf("withinDays" to 7)
            )
        )
        assertEquals(
            CommandDispatcher.Outcome.Executed(
                mapOf(
                    "events" to listOf(
                        mapOf(
                            "title" to "Reunión",
                            "startsAt" to "2026-10-08T15:00:00",
                            "location" to "Casa"
                        )
                    )
                )
            ),
            calendarOutcome
        )

        platform.reportedVolumeLevel = 42
        val volumeOutcome = commandDispatcher.dispatch(
            dispatchInput(
                capabilityName = "mobile.volume",
                commandName = "volume_get",
                payload = emptyMap()
            )
        )
        assertEquals(CommandDispatcher.Outcome.Executed(mapOf("level" to 42)), volumeOutcome)
    }

    /**
     * `media_play` no puede fingir exito: sin un resolvedor de query a URL en el
     * telefono, tiene que decir que no se pudo en vez de devolver ok.
     */
    @Test
    fun mediaPlayReportsWhyItCouldNotPlay() {
        val (commandDispatcher, _, platform) = buildDispatcher()

        platform.mediaPlayOutcome = MediaPlayOutcome.Started
        assertEquals(
            CommandDispatcher.Outcome.Executed(mapOf("playing" to true)),
            commandDispatcher.dispatch(
                dispatchInput(
                    capabilityName = "mobile.media",
                    commandName = "media_play",
                    payload = mapOf("query" to "album")
                )
            )
        )

        platform.mediaPlayOutcome = MediaPlayOutcome.Unresolvable
        assertEquals(
            CommandDispatcher.Outcome.Rejected("media_unresolvable"),
            commandDispatcher.dispatch(
                dispatchInput(
                    capabilityName = "mobile.media",
                    commandName = "media_play",
                    payload = mapOf("query" to "album")
                )
            )
        )

        platform.mediaPlayOutcome = MediaPlayOutcome.Failed
        assertEquals(
            CommandDispatcher.Outcome.Rejected("media_failed"),
            commandDispatcher.dispatch(
                dispatchInput(
                    capabilityName = "mobile.media",
                    commandName = "media_play",
                    payload = mapOf("query" to "https://example.test/a.mp3")
                )
            )
        )
    }

    @Test
    fun volumeGetFailsWhenTheDeviceHasNoMusicStream() {
        val (commandDispatcher, _, platform) = buildDispatcher()
        platform.reportedVolumeLevel = null

        assertEquals(
            CommandDispatcher.Outcome.Rejected("volume_unavailable"),
            commandDispatcher.dispatch(
                dispatchInput(
                    capabilityName = "mobile.volume",
                    commandName = "volume_get",
                    payload = emptyMap()
                )
            )
        )
    }

    /** El comando canonico es el que se usa cuando Apollo no manda `command`. */
    @Test
    fun theCanonicalCommandOfEachCapabilityIsTheFirstOfItsList() {
        assertEquals("notification_post", canonicalCommandOf("mobile.notifications"))
        assertEquals("alarm_set", canonicalCommandOf("mobile.alarm"))
        assertEquals("calendar_create", canonicalCommandOf("mobile.calendar"))
        assertEquals("media_play", canonicalCommandOf("mobile.media"))
        assertEquals("volume_set", canonicalCommandOf("mobile.volume"))
        assertEquals("app_open", canonicalCommandOf("mobile.open_app"))
    }


    /**
     * El bug que la ejecucion real del cliente encontro: con schema por
     * capability, `alarm_cancel` (que manda solo `{label}`) fallaba siempre con
     * `invalid_hour_minute` porque se le exigia la hora. El schema es por comando.
     */
    @Test
    fun cancelAlarmNeedsOnlyTheLabel() {
        val (commandDispatcher, _, platform) = buildDispatcher()

        val outcome = commandDispatcher.dispatch(
            dispatchInput(
                capabilityName = "mobile.alarm",
                commandName = "alarm_cancel",
                payload = mapOf("label" to "Despertar")
            )
        )

        assertTrue(outcome.isExecuted())
        assertEquals(listOf("cancelAlarm"), platform.callList)
    }

    @Test
    fun alarmSetNeedsTheHourAndTheLabel() {
        val (commandDispatcher, _, platform) = buildDispatcher()

        val withoutHour = commandDispatcher.dispatch(
            dispatchInput(
                capabilityName = "mobile.alarm",
                commandName = "alarm_set",
                payload = mapOf("label" to "Despertar")
            )
        )
        assertEquals(CommandDispatcher.Outcome.Rejected("invalid_hour_minute"), withoutHour)
        assertEquals(0, platform.callList.size)
    }
}

/**
 * Que metodo de `MobilePlatform` toca cada comando, o `null` cuando el efecto lo
 * maneja otro puerto (notificaciones). Derivarse del catalogo sin esta tabla hace
 * fallar el test de arriba, asi que agregar un comando obliga a declarar su
 * efecto real.
 */
private val EXPECTED_PLATFORM_CALL_BY_COMMAND: Map<String, String?> = mapOf(
    "notification_post" to null,
    "alarm_set" to "setAlarm",
    "alarm_cancel" to "cancelAlarm",
    "calendar_create" to "createCalendarEvent",
    "calendar_list" to "listCalendarEvents",
    "calendar_cancel" to "cancelCalendarEvent",
    "media_play" to "playMedia",
    "media_pause" to "pauseMedia",
    "media_next" to "nextMedia",
    "media_previous" to "previousMedia",
    "volume_set" to "setVolume",
    "volume_get" to "getVolumeLevel",
    "app_open" to "openApp"
)

/** Payload minimo valido por comando. */
fun payloadForCommand(capabilityName: String, commandName: String): Map<String, Any?> =
    when (commandName) {
        "alarm_set" -> mapOf("hourMinute" to "07:30", "label" to "Despertar")
        "alarm_cancel" -> mapOf("label" to "Despertar")
        "calendar_create" -> mapOf("title" to "Reunión", "startsAt" to "2026-10-08T15:00:00")
        "calendar_list" -> mapOf("withinDays" to 7)
        "calendar_cancel" -> mapOf("title" to "Reunión")
        "media_play", "media_pause", "media_next", "media_previous" -> mapOf("query" to "album")
        "volume_set" -> mapOf("level" to 40)
        "volume_get" -> emptyMap()
        "app_open" -> mapOf("appName" to "whatsapp")
        else -> validPayloadFor(capabilityName)
    }
