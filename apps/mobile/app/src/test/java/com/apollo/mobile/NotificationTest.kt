package com.apollo.mobile

import com.apollo.mobile.command.CommandDispatcher
import com.apollo.mobile.notification.PermissionOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tests 15 y 16: notificacion nativa con permiso concedido o denegado. */
class NotificationTest {

    @Test
    fun postsWhenThePermissionIsGranted() {
        val notificationAdapter = FakeNotificationAdapter(PermissionOutcome.Granted)
        val platform = RecordingMobilePlatform()
        val commandDispatcher = CommandDispatcher(notificationAdapter, platform)

        val outcome = commandDispatcher.dispatch(dispatchInput())

        assertTrue(outcome.isExecuted())
        assertEquals(1, notificationAdapter.postCount)
        assertEquals(listOf("Apollo" to "Hola"), notificationAdapter.postedList)
    }

    @Test
    fun reportsPermissionDeniedWithoutPostingAndWithoutRetrying() {
        val notificationAdapter = FakeNotificationAdapter(PermissionOutcome.Denied)
        val platform = RecordingMobilePlatform()
        val commandDispatcher = CommandDispatcher(notificationAdapter, platform)

        val outcome = commandDispatcher.dispatch(dispatchInput())

        assertEquals(CommandDispatcher.Outcome.Rejected("permission_denied"), outcome)
        assertEquals(0, notificationAdapter.postCount)
        assertEquals(1, notificationAdapter.permissionCount)
        assertEquals(0, platform.callList.size)
    }

    @Test
    fun reportsAFailedPostInsteadOfClaimingSuccess() {
        val notificationAdapter = FakeNotificationAdapter(
            permissionOutcome = PermissionOutcome.Granted,
            doesPost = false
        )
        val commandDispatcher = CommandDispatcher(notificationAdapter, RecordingMobilePlatform())

        assertEquals(
            CommandDispatcher.Outcome.Rejected("post_failed"),
            commandDispatcher.dispatch(dispatchInput())
        )
    }

    @Test
    fun reportsAPlatformFailureInsteadOfClaimingSuccess() {
        val platform = RecordingMobilePlatform().apply { doesSucceed = false }
        val commandDispatcher = CommandDispatcher(
            FakeNotificationAdapter(PermissionOutcome.Granted),
            platform
        )

        assertEquals(
            CommandDispatcher.Outcome.Rejected("platform_rejected"),
            commandDispatcher.dispatch(
                dispatchInput(
                    capabilityName = "mobile.open_app",
                    commandName = "app_open",
                    payload = mapOf("appName" to "no-existe")
                )
            )
        )
        assertEquals(listOf("openApp"), platform.callList)
    }
}
