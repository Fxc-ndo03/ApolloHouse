package com.apollo.mobile.protocol

import com.apollo.mobile.contract.Contract
import org.json.JSONObject

/** Mensajes que el cliente envia. El secret nunca viaja en el cuerpo. */
object OutboundMessage {

    fun buildHelloMessage(
        deviceId: String,
        announcedCapabilityList: List<String>,
        atMilliseconds: Long
    ): String = JSONObject()
        .put("type", "hello")
        .put("deviceId", deviceId)
        .put("deviceType", Contract.DEVICE_TYPE)
        .put("protocolVersion", Contract.PROTOCOL_VERSION)
        .put("capabilities", org.json.JSONArray(announcedCapabilityList))
        .put("ts", atMilliseconds)
        .toString()

    fun buildHeartbeatMessage(atMilliseconds: Long): String = JSONObject()
        .put("type", "heartbeat")
        .put("ts", atMilliseconds)
        .toString()

    /**
     * El requestId viaja exactamente como vino del envelope: el cliente no genera
     * uno nuevo. El contrato existente no lleva deviceId porque el socket ya esta
     * bound a una identidad.
     */
    fun buildCommandResultMessage(
        requestId: String,
        capabilityName: String,
        wasPosted: Boolean,
        errorDetail: String?,
        commandResult: Map<String, Any?>?,
        atMilliseconds: Long
    ): String {
        val message = JSONObject()
            .put("type", "command_result")
            .put("requestId", requestId)
            .put("capability", capabilityName)
            .put("ok", wasPosted)
            .put("ts", atMilliseconds)
        if (wasPosted) {
            message.put("result", toJsonObject(commandResult))
        } else {
            message.put("error", errorDetail ?: "unknown_error")
        }
        return message.toString()
    }

    private fun toJsonObject(commandResult: Map<String, Any?>?): JSONObject {
        val resultObject = JSONObject()
        for ((fieldName, fieldValue) in commandResult.orEmpty()) {
            when (fieldValue) {
                null -> Unit
                is Boolean -> resultObject.put(fieldName, fieldValue)
                is Int -> resultObject.put(fieldName, fieldValue)
                is Long -> resultObject.put(fieldName, fieldValue)
                is String -> resultObject.put(fieldName, fieldValue)
                is List<*> -> resultObject.put(
                    fieldName,
                    org.json.JSONArray().apply {
                        for (item in fieldValue) {
                            if (item is Map<*, *>) {
                                put(toJsonObject(item.mapKeys { entry -> entry.key.toString() }))
                            } else {
                                put(item)
                            }
                        }
                    }
                )
                is Map<*, *> -> resultObject.put(
                    fieldName,
                    toJsonObject(fieldValue.mapKeys { entry -> entry.key.toString() })
                )
                else -> resultObject.put(fieldName, fieldValue.toString())
            }
        }
        return resultObject
    }
}
