package com.apollo.mobile

import com.apollo.mobile.command.CommandDispatcher
import com.apollo.mobile.contract.Contract
import com.apollo.mobile.notification.PermissionOutcome
import com.apollo.mobile.session.MobileSession
import com.apollo.mobile.session.MobileSessionOwner
import com.apollo.mobile.session.MobileSessionState
import com.apollo.mobile.transport.ClientConfig
import com.apollo.mobile.transport.DeviceCredential
import com.apollo.mobile.transport.RecordingSocketFactory
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Tests 2, 3, 4, 5: hello mobile, capabilities, auth fallida y conexion exitosa. */
class SessionTest {

    private fun buildSession(
        socketFactory: RecordingSocketFactory,
        permissionOutcome: PermissionOutcome = PermissionOutcome.Granted
    ): MobileSession = MobileSession(
        clientConfig = ClientConfig(workerHost = TEST_WORKER_HOST),
        deviceSocketFactory = socketFactory,
        commandDispatcher = CommandDispatcher(FakeNotificationAdapter(permissionOutcome), RecordingMobilePlatform()),
        nowMillisecondsPort = { 1_700_000_000_000L },
    )

    @Test
    fun sendsAHelloMobileWithTheStructuredContract() {
        val socketFactory = RecordingSocketFactory()
        buildSession(socketFactory).start(TEST_DEVICE_ID, legacyTestCredential())
        socketFactory.acceptOpen()

        val helloMessage = JSONObject(socketFactory.sentMessageList.first())
        assertEquals("hello", helloMessage.getString("type"))
        assertEquals(TEST_DEVICE_ID, helloMessage.getString("deviceId"))
        assertEquals("mobile", helloMessage.getString("deviceType"))
        assertEquals(Contract.PROTOCOL_VERSION, helloMessage.getInt("protocolVersion"))
        assertEquals(1_700_000_000_000L, helloMessage.getLong("ts"))
    }

    /** BLOCK 11 §17: el cliente anuncia las capabilities mobile implementadas. */
    @Test
    fun announcesEveryImplementedMobileCapability() {
        val socketFactory = RecordingSocketFactory()
        buildSession(socketFactory).start(TEST_DEVICE_ID, legacyTestCredential())
        socketFactory.acceptOpen()

        val announcedCapabilityList = JSONObject(socketFactory.sentMessageList.first())
            .getJSONArray("capabilities")
        assertEquals(Contract.ANNOUNCED_CAPABILITY_LIST.size, announcedCapabilityList.length())
        val announcedList = (0 until announcedCapabilityList.length())
            .map { announcedCapabilityList.getString(it) }
        assertEquals(Contract.ANNOUNCED_CAPABILITY_LIST.sorted(), announcedList.sorted())
        // Ninguna desktop: el cliente mobile no anuncia capabilities de PC.
        assertTrue(announcedList.none { it.startsWith("desktop.") })
    }

    @Test
    fun reachesOnlineWhenTheServerAcceptsTheHello() {
        val socketFactory = RecordingSocketFactory()
        val session = buildSession(socketFactory)
        session.start(TEST_DEVICE_ID, legacyTestCredential())
        socketFactory.acceptOpen()
        socketFactory.deliver(buildHelloAcceptedMessage())

        assertEquals(MobileSessionState.ONLINE, session.state)
        assertEquals(
            listOf("mobile.notifications", "mobile.alarm"),
            session.availableCapabilityList
        )
        assertTrue(session.heartbeatScheduler.isRunning)
    }

    @Test
    fun recordsTheRejectionReasonAndStaysDisconnected() {
        val socketFactory = RecordingSocketFactory()
        val session = buildSession(socketFactory)
        session.start(TEST_DEVICE_ID, legacyTestCredential())
        socketFactory.acceptOpen()
        socketFactory.deliver(
            JSONObject().put("type", "hello_rejected").put("reason", "bad_device_id").toString()
        )

        assertEquals(MobileSessionState.DISCONNECTED, session.state)
        assertEquals("bad_device_id", session.rejectionReason)
        assertFalse(session.heartbeatScheduler.isRunning)
    }

    @Test
    fun anInvalidTokenNeverReachesOnline() {
        val socketFactory = RecordingSocketFactory()
        val session = buildSession(socketFactory)
        session.start(TEST_DEVICE_ID, DeviceCredential.LegacySharedSecret("wrong-secret"))
        socketFactory.acceptOpen()
        socketFactory.deliver(
            JSONObject().put("type", "hello_rejected").put("reason", "unauthorized").toString()
        )

        assertEquals(MobileSessionState.DISCONNECTED, session.state)
        assertEquals("unauthorized", session.rejectionReason)
    }

    @Test
    fun neverLogsTheDeviceSharedSecret() {
        val socketFactory = RecordingSocketFactory()
        buildSession(socketFactory).start(TEST_DEVICE_ID, legacyTestCredential())
        socketFactory.acceptOpen()

        assertTrue(
            socketFactory.sentMessageList.none { rawMessageText ->
                rawMessageText.contains(TEST_DEVICE_SHARED_SECRET)
            }
        )
        assertTrue(socketFactory.openedUrl?.contains(TEST_DEVICE_SHARED_SECRET) == true)
    }
}
