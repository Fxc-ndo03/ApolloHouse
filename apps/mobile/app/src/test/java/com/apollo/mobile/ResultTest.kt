package com.apollo.mobile

import com.apollo.mobile.command.CommandDispatcher
import com.apollo.mobile.protocol.InboundMessage
import com.apollo.mobile.protocol.InboundParser
import com.apollo.mobile.notification.PermissionOutcome
import com.apollo.mobile.protocol.OutboundMessage
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Test 17, 22: command_result con el requestId preservado. */
class ResultTest {

    private fun buildInboundCommand(requestId: String = "abc-123"): InboundMessage.Command =
        InboundParser.parse(
            JSONObject()
                .put("type", "command")
                .put("requestId", requestId)
                .put("capability", "mobile.notifications")
                .put("payload", JSONObject().put("title", "Apollo").put("body", "Hola"))
                .toString()
        ) as InboundMessage.Command

    @Test
    fun preservesTheRequestIdExactly() {
        val inboundCommand = buildInboundCommand()

        val resultMessage = JSONObject(
            OutboundMessage.buildCommandResultMessage(
                requestId = inboundCommand.requestId,
                capabilityName = inboundCommand.capabilityName,
                wasPosted = true,
                errorDetail = null,
                commandResult = mapOf("posted" to true),
                atMilliseconds = 42L
            )
        )

        assertEquals("abc-123", resultMessage.getString("requestId"))
        assertEquals("command_result", resultMessage.getString("type"))
        assertEquals("mobile.notifications", resultMessage.getString("capability"))
        assertTrue(resultMessage.getBoolean("ok"))
        assertTrue(resultMessage.getJSONObject("result").getBoolean("posted"))
        assertEquals(42L, resultMessage.getLong("ts"))
    }

    @Test
    fun buildsAFailureResultWithAStructuredError() {
        val resultMessage = JSONObject(
            OutboundMessage.buildCommandResultMessage(
                requestId = "abc-123",
                capabilityName = "mobile.notifications",
                wasPosted = false,
                errorDetail = "permission_denied",
                commandResult = null,
                atMilliseconds = 42L
            )
        )

        assertFalse(resultMessage.getBoolean("ok"))
        assertEquals("permission_denied", resultMessage.getString("error"))
        assertFalse(resultMessage.has("result"))
        assertEquals("abc-123", resultMessage.getString("requestId"))
    }
}

/** Test 18: un requestId duplicado en vuelo no ejecuta dos efectos. */
class DuplicateTest {

    @Test
    fun runsOneEffectForADuplicateInFlightRequestId() {
        val blockingAdapter = BlockingNotificationAdapter()
        val commandDispatcher = CommandDispatcher(blockingAdapter, RecordingMobilePlatform())

        val firstThread = Thread {
            commandDispatcher.dispatch(dispatchInput(requestId = "dup"))
        }
        firstThread.start()
        blockingAdapter.awaitPostStarted()

        val secondOutcome = commandDispatcher.dispatch(dispatchInput(requestId = "dup"))
        blockingAdapter.releasePost()
        firstThread.join()

        assertEquals(CommandDispatcher.Outcome.Rejected("duplicate_in_flight"), secondOutcome)
        assertEquals(1, blockingAdapter.postCount)
    }

    @Test
    fun allowsTheRequestIdAgainOnceTheFirstCallFinished() {
        val commandDispatcher = CommandDispatcher(
            FakeNotificationAdapter(PermissionOutcome.Granted),
            RecordingMobilePlatform()
        )

        assertTrue(commandDispatcher.dispatch(dispatchInput()).isExecuted())
        assertTrue(commandDispatcher.dispatch(dispatchInput()).isExecuted())
    }
}

/** Test 19: envelope malformado. */
class EnvelopeTest {

    @Test
    fun rejectsAMalformedEnvelope() {
        val malformedMessageList = listOf(
            "not json at all",
            JSONObject().put("type", "command").toString(),
            JSONObject()
                .put("type", "command")
                .put("requestId", "")
                .put("capability", "mobile.notifications")
                .toString(),
            JSONObject()
                .put("type", "command")
                .put("requestId", "abc")
                .put("capability", "mobile.notifications")
                .toString(),
            JSONObject()
                .put("type", "command")
                .put("requestId", "abc")
                .put("payload", JSONObject())
                .toString(),
            JSONObject().put("type", "invented").toString(),
            JSONObject().put("noType", true).toString()
        )

        malformedMessageList.forEach { rawMessageText ->
            assertTrue(
                "se esperaba malformado para $rawMessageText",
                InboundParser.parse(rawMessageText) is InboundMessage.Malformed
            )
        }
    }

    @Test
    fun rejectsAHelloAcceptedWithoutItsRequiredFields() {
        assertTrue(
            InboundParser.parse(JSONObject().put("type", "hello_accepted").toString())
                is InboundMessage.Malformed
        )
        assertNull(
            InboundParser.parse(
                JSONObject()
                    .put("type", "hello_accepted")
                    .put("deviceId", "")
                    .put("protocolVersion", 1)
                    .toString()
            ) as? InboundMessage.HelloAccepted
        )
    }

    @Test
    fun readsTheOptionalTargetOfACommand() {
        val inbound = InboundParser.parse(
            JSONObject()
                .put("type", "command")
                .put("requestId", "abc")
                .put("capability", "mobile.notifications")
                .put("payload", JSONObject().put("title", "Apollo").put("body", "Hola"))
                .put("targetDeviceId", "mobile:otro")
                .toString()
        )

        assertEquals("mobile:otro", (inbound as InboundMessage.Command).targetDeviceId)
    }
}
