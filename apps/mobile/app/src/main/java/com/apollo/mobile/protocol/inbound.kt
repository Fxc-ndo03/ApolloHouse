package com.apollo.mobile.protocol

import org.json.JSONObject

/** Lo que el servidor puede mandar a un cliente mobile. */
sealed class InboundMessage {
    data class HelloAccepted(
        val deviceId: String,
        val protocolVersion: Int,
        val availableCapabilityList: List<String>,
        val ignoredCapabilityCount: Int,
        val heartbeatIntervalMilliseconds: Long
    ) : InboundMessage()

    data class HelloRejected(val reason: String) : InboundMessage()

    data class HeartbeatProbe(val atMilliseconds: Long) : InboundMessage()

    data class Command(
        val requestId: String,
        val capabilityName: String,
        val payload: Map<String, Any?>,
        val targetDeviceId: String?,
        // BLOCK 11 §4: comando explicito. Ausente = comando canonico de la
        // capability, que es lo que mandaba Apollo antes de Block 11.
        val commandName: String?
    ) : InboundMessage()

    data class Malformed(val reason: String) : InboundMessage()
}

object InboundParser {

    fun parse(rawMessageText: String): InboundMessage {
        val parsed = try {
            JSONObject(rawMessageText)
        } catch (invalidJson: Exception) {
            return InboundMessage.Malformed("invalid_json")
        }
        return when (val type = parsed.optString("type")) {
            "hello_accepted" -> parseHelloAccepted(parsed)
            "hello_rejected" -> InboundMessage.HelloRejected(
                parsed.optString("reason").ifEmpty { "unknown" }
            )
            "heartbeat_probe" -> InboundMessage.HeartbeatProbe(parsed.optLong("ts", 0L))
            "command" -> parseCommand(parsed)
            "" -> InboundMessage.Malformed("missing_type")
            else -> InboundMessage.Malformed("unknown_type:$type")
        }
    }

    private fun parseHelloAccepted(parsed: JSONObject): InboundMessage {
        val accepted = InboundMessage.HelloAccepted(
            deviceId = parsed.optString("deviceId"),
            protocolVersion = parsed.optInt("protocolVersion", 0),
            availableCapabilityList = readStringList(parsed.optJSONArray("availableCapabilities")),
            ignoredCapabilityCount = parsed.optInt("ignoredCapabilityCount", 0),
            heartbeatIntervalMilliseconds = parsed.optLong("heartbeatIntervalMilliseconds", 0L)
        )
        if (accepted.deviceId.isEmpty() || accepted.protocolVersion <= 0) {
            return InboundMessage.Malformed("invalid_hello_accepted")
        }
        return accepted
    }

    private fun parseCommand(parsed: JSONObject): InboundMessage {
        val requestId = parsed.optString("requestId")
        if (requestId.isEmpty() || requestId.length > 128) {
            return InboundMessage.Malformed("invalid_request_id")
        }
        val capabilityName = parsed.optString("capability")
        if (capabilityName.isEmpty()) {
            return InboundMessage.Malformed("missing_capability")
        }
        val payloadObject = parsed.optJSONObject("payload")
            ?: return InboundMessage.Malformed("missing_payload")
        return InboundMessage.Command(
            requestId = requestId,
            capabilityName = capabilityName,
            payload = readMap(payloadObject),
            targetDeviceId = parsed.optString("targetDeviceId").ifEmpty { null },
            commandName = parsed.optString("command").ifEmpty { null }
        )
    }

    private fun readStringList(array: org.json.JSONArray?): List<String> {
        if (array == null) {
            return emptyList()
        }
        return (0 until array.length()).map { index -> array.optString(index) }
    }

    private fun readMap(source: JSONObject): Map<String, Any?> {
        val result = linkedMapOf<String, Any?>()
        val keyList = source.keys()
        while (keyList.hasNext()) {
            val key = keyList.next()
            result[key] = source.opt(key)
        }
        return result
    }
}
