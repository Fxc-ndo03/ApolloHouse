package com.apollo.mobile

import com.apollo.mobile.command.CommandDispatcher
import com.apollo.mobile.notification.PermissionOutcome
import com.apollo.mobile.session.MobileSession
import com.apollo.mobile.session.MobileSessionState
import com.apollo.mobile.transport.ClientConfig
import com.apollo.mobile.transport.RecordingSocketFactory
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tests 6, 7, 8, 9: heartbeat, disconnect, reconnect y no duplicar el scheduler. */
class HeartbeatTest {

    private fun buildSession(socketFactory: RecordingSocketFactory): MobileSession =
        MobileSession(
            clientConfig = ClientConfig(workerHost = TEST_WORKER_HOST),
            deviceSocketFactory = socketFactory,
            commandDispatcher = CommandDispatcher(
                FakeNotificationAdapter(PermissionOutcome.Granted),
                RecordingMobilePlatform()
            ),
            nowMillisecondsPort = { 42L }
        )

    private fun connectSession(
        socketFactory: RecordingSocketFactory
    ): MobileSession {
        val session = buildSession(socketFactory)
        session.start(TEST_DEVICE_ID, legacyTestCredential())
        socketFactory.acceptOpen()
        socketFactory.deliver(buildHelloAcceptedMessage())
        return session
    }

    @Test
    fun sendsHeartbeatsWithTheServerProvidedInterval() {
        val socketFactory = RecordingSocketFactory()
        val session = connectSession(socketFactory)

        assertTrue(session.heartbeatScheduler.isRunning)
        assertEquals(30_000L, session.heartbeatScheduler.currentIntervalMilliseconds)
        session.sendHeartbeat()
        val heartbeatMessage = JSONObject(socketFactory.sentMessageList.last())
        assertEquals("heartbeat", heartbeatMessage.getString("type"))
        assertEquals(42L, heartbeatMessage.getLong("ts"))
    }

    @Test
    fun answersTheHeartbeatProbe() {
        val socketFactory = RecordingSocketFactory()
        connectSession(socketFactory)

        socketFactory.deliver(
            JSONObject().put("type", "heartbeat_probe").put("ts", 42L).toString()
        )

        assertEquals("heartbeat", JSONObject(socketFactory.sentMessageList.last()).getString("type"))
    }

    @Test
    fun aReconnectKeepsTheSameDeviceId() {
        val socketFactory = RecordingSocketFactory()
        val session = connectSession(socketFactory)
        assertEquals(TEST_DEVICE_ID, session.deviceId)

        session.connect(legacyTestCredential())

        assertEquals(TEST_DEVICE_ID, session.deviceId)
        assertEquals(MobileSessionState.RECONNECTING, session.state)
    }

    @Test
    fun aReconnectDoesNotDuplicateTheHeartbeatScheduler() {
        val socketFactory = RecordingSocketFactory()
        val session = connectSession(socketFactory)
        val startCountAfterFirstConnect = session.heartbeatScheduler.startCount

        socketFactory.dropConnection()
        session.connect(legacyTestCredential())
        socketFactory.acceptOpen()
        socketFactory.deliver(buildHelloAcceptedMessage())

        assertEquals(startCountAfterFirstConnect + 1, session.heartbeatScheduler.startCount)
        assertTrue(session.heartbeatScheduler.isRunning)
    }

    @Test
    fun dropsTheHeartbeatWhenTheConnectionDies() {
        val socketFactory = RecordingSocketFactory()
        val session = connectSession(socketFactory)

        socketFactory.dropConnection()

        assertFalse(session.heartbeatScheduler.isRunning)
        assertEquals(MobileSessionState.RECONNECTING, session.state)
    }
}
