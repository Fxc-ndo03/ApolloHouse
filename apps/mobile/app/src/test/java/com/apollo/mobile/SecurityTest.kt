package com.apollo.mobile

import com.apollo.mobile.command.CommandDispatcher
import com.apollo.mobile.notification.PermissionOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tests 20 y 21: seguridad antes de ejecutar (BLOCK 11 §11). */
class SecurityTest {

    private fun buildDispatcher(): CommandDispatcher = CommandDispatcher(
        FakeNotificationAdapter(PermissionOutcome.Granted),
        RecordingMobilePlatform()
    )

    @Test
    fun rejectsACommandBeforeAuthentication() {
        val notificationAdapter = FakeNotificationAdapter(PermissionOutcome.Granted)
        val platform = RecordingMobilePlatform()
        val commandDispatcher = CommandDispatcher(notificationAdapter, platform)

        val outcome = commandDispatcher.dispatch(dispatchInput(isAuthenticated = false))

        assertEquals(CommandDispatcher.Outcome.Rejected("not_authenticated"), outcome)
        assertEquals(0, notificationAdapter.postCount)
        assertEquals(0, platform.callList.size)
    }

    @Test
    fun rejectsACommandDirectedToAnotherDevice() {
        val notificationAdapter = FakeNotificationAdapter(PermissionOutcome.Granted)
        val platform = RecordingMobilePlatform()
        val commandDispatcher = CommandDispatcher(notificationAdapter, platform)

        val outcome = commandDispatcher.dispatch(
            dispatchInput(targetDeviceId = "mobile:OTRO-TELEFONO")
        )

        assertEquals(CommandDispatcher.Outcome.Rejected("target_mismatch"), outcome)
        assertEquals(0, notificationAdapter.postCount)
        assertEquals(0, platform.callList.size)
    }

    @Test
    fun acceptsACommandWhoseTargetIsThisSameDevice() {
        val commandDispatcher = buildDispatcher()

        assertTrue(
            commandDispatcher.dispatch(dispatchInput(targetDeviceId = TEST_DEVICE_ID))
                .isExecuted()
        )
    }

    /** BLOCK 11 §16: el móvil no puede ejecutar una tool arbitraria. */
    @Test
    fun aMobileClientCannotExecuteAnArbitraryTool() {
        val platform = RecordingMobilePlatform()
        val commandDispatcher = CommandDispatcher(
            FakeNotificationAdapter(PermissionOutcome.Granted),
            platform
        )

        val outcome = commandDispatcher.dispatch(
            dispatchInput(
                capabilityName = "desktop.open_app",
                commandName = "apps_open",
                payload = mapOf("appName" to "chrome")
            )
        )

        assertEquals(CommandDispatcher.Outcome.Rejected("unsupported_command"), outcome)
        assertEquals(0, platform.callList.size)
    }
}
