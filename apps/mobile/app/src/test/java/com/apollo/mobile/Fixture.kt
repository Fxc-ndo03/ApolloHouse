package com.apollo.mobile

import com.apollo.mobile.command.CommandDispatcher
import com.apollo.mobile.transport.DeviceCredential
import com.apollo.mobile.contract.Contract
import com.apollo.mobile.notification.CalendarEventSummary
import com.apollo.mobile.notification.MediaPlayOutcome
import com.apollo.mobile.notification.MobilePlatform
import com.apollo.mobile.notification.NotificationAdapter
import com.apollo.mobile.notification.PermissionOutcome
import org.json.JSONArray
import org.json.JSONObject

const val TEST_DEVICE_ID = "mobile:test-phone"
const val TEST_DEVICE_SHARED_SECRET = "test-device-shared-secret"

/**
 * BLOCK 12: la sesion recibe una `DeviceCredential`, no un String. El helper de
 * test arma la forma legacy para que los casos de Block 10 sigan siendo los
 * mismos casos, y el ambito enrolled tiene su propio helper.
 */
fun legacyTestCredential(): DeviceCredential =
    DeviceCredential.LegacySharedSecret(TEST_DEVICE_SHARED_SECRET)

fun enrolledTestCredential(
    credential: String = "apollo_dev_test-credential"
): DeviceCredential = DeviceCredential.Enrolled(credential)
const val TEST_WORKER_HOST = "worker.test"

/**
 * Comando canonico de una capability: el primero de su commandList. Es lo que el
 * peer usa cuando Apollo no manda `command` (compatibilidad con Block 9).
 */
fun canonicalCommandOf(capabilityName: String): String =
    CommandAllowlistForTest.listCommandFor(capabilityName).first()

/** Espejo del allowlist de produccion, para que los tests no dependan del order. */
object CommandAllowlistForTest {
    fun listCommandFor(capabilityName: String): List<String> =
        Contract.ALLOWED_COMMAND_MAP[capabilityName] ?: emptyList()
}

fun buildHelloAcceptedMessage(
    deviceId: String = TEST_DEVICE_ID,
    heartbeatIntervalMilliseconds: Long = 30_000L,
    availableCapabilityList: List<String> = listOf("mobile.notifications", "mobile.alarm")
): String = JSONObject()
    .put("type", "hello_accepted")
    .put("deviceId", deviceId)
    .put("protocolVersion", Contract.PROTOCOL_VERSION)
    .put("availableCapabilities", JSONArray(availableCapabilityList))
    .put("ignoredCapabilityCount", 0)
    .put("heartbeatIntervalMilliseconds", heartbeatIntervalMilliseconds)
    .toString()

fun buildValidNotificationPayload(): Map<String, Any?> =
    mapOf("title" to "Apollo", "body" to "Hola")

/** Plataforma falsa: registra que se le pidió, sin tocar Android. */
class RecordingMobilePlatform : MobilePlatform {

    val callList = mutableListOf<String>()
    var doesSucceed = true
    var mediaPlayOutcome: MediaPlayOutcome = MediaPlayOutcome.Started
    var calendarEventSummaryList: List<CalendarEventSummary> = emptyList()
    // No puede llamarse `volumeLevel`: el getter de la property generaria un
    // getVolumeLevel() con la misma firma JVM que el override del puerto.
    var reportedVolumeLevel: Int? = 42

    override fun showNotification(title: String, body: String): Boolean = record("showNotification")
    override fun setAlarm(label: String, hourMinute: String, repeatDaily: Boolean): Boolean =
        record("setAlarm")
    override fun cancelAlarm(label: String): Boolean = record("cancelAlarm")
    override fun createCalendarEvent(title: String, startsAt: String, location: String): Boolean =
        record("createCalendarEvent")
    override fun cancelCalendarEvent(title: String): Boolean = record("cancelCalendarEvent")

    override fun listCalendarEvents(withinDays: Int): List<CalendarEventSummary> {
        callList.add("listCalendarEvents")
        return calendarEventSummaryList
    }

    override fun playMedia(query: String): MediaPlayOutcome {
        callList.add("playMedia")
        return mediaPlayOutcome
    }

    override fun pauseMedia(): Boolean = record("pauseMedia")
    override fun nextMedia(): Boolean = record("nextMedia")
    override fun previousMedia(): Boolean = record("previousMedia")
    override fun setVolume(level: Int): Boolean = record("setVolume")

    override fun getVolumeLevel(): Int? {
        callList.add("getVolumeLevel")
        return reportedVolumeLevel
    }

    override fun openApp(appName: String): Boolean = record("openApp")

    private fun record(callName: String): Boolean {
        callList.add(callName)
        return doesSucceed
    }
}

class FakeNotificationAdapter(
    private val permissionOutcome: PermissionOutcome,
    private val doesPost: Boolean = true
) : NotificationAdapter {

    var permissionCount: Int = 0
        private set
    var postCount: Int = 0
        private set
    val postedList = mutableListOf<Pair<String, String>>()

    override fun requestPermission(): PermissionOutcome {
        permissionCount += 1
        return permissionOutcome
    }

    override fun post(title: String, body: String): Boolean {
        if (!doesPost) {
            return false
        }
        postCount += 1
        postedList.add(title to body)
        return true
    }
}

class BlockingNotificationAdapter : NotificationAdapter {

    var postCount: Int = 0
        private set
    private val postStartedLatch = java.util.concurrent.CountDownLatch(1)
    private val releaseLatch = java.util.concurrent.CountDownLatch(1)

    fun awaitPostStarted() {
        postStartedLatch.await(5, java.util.concurrent.TimeUnit.SECONDS)
    }

    fun releasePost() {
        releaseLatch.countDown()
    }

    override fun requestPermission(): PermissionOutcome = PermissionOutcome.Granted

    override fun post(title: String, body: String): Boolean {
        postCount += 1
        postStartedLatch.countDown()
        releaseLatch.await(5, java.util.concurrent.TimeUnit.SECONDS)
        return true
    }
}

fun dispatchInput(
    requestId: String = "request-1",
    capabilityName: String = "mobile.notifications",
    commandName: String = "notification_post",
    payload: Map<String, Any?> = buildValidNotificationPayload(),
    targetDeviceId: String? = null,
    isAuthenticated: Boolean = true
) = CommandDispatcher.DispatchInput(
    deviceId = TEST_DEVICE_ID,
    requestId = requestId,
    capabilityName = capabilityName,
    commandName = commandName,
    payload = payload,
    targetDeviceId = targetDeviceId,
    isAuthenticated = isAuthenticated
)

/** `Outcome.Executed` es un data class: se compara por tipo, no por identidad. */
fun CommandDispatcher.Outcome.isExecuted(): Boolean = this is CommandDispatcher.Outcome.Executed

/** Payload minimo valido por capability (mismo shape que valida PayloadValidator). */
fun validPayloadFor(capabilityName: String): Map<String, Any?> = when (capabilityName) {
    "mobile.notifications" -> mapOf("title" to "Apollo", "body" to "Hola")
    "mobile.alarm" -> mapOf("hourMinute" to "07:30", "label" to "Despertar")
    "mobile.calendar" -> mapOf("title" to "Reunion", "startsAt" to "2026-10-08T15:00:00")
    "mobile.media" -> mapOf("query" to "album")
    "mobile.volume" -> mapOf("level" to 40)

    "mobile.open_app" -> mapOf("appName" to "whatsapp")
    else -> emptyMap()
}
