package com.apollo.mobile.identity

import com.apollo.mobile.transport.ClientConfig
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * BLOCK 12 §2: el canje del desafio de enrollment.
 *
 * Va por HTTPS con `HttpURLConnection`, no por el WebSocket, porque todavia no hay
 * credencial con la que autenticarse: lo que autoriza esta llamada es el desafio
 * en si, que es de un solo uso y expira solo. Por eso no pide ningun token.
 *
 * No se registra nada: ni el desafio, ni la credencial, ni el body. Un log de
 * este camino seria una fuga.
 */
sealed class EnrollmentClaimResult {
    data class Enrolled(val deviceId: String, val credential: String) : EnrollmentClaimResult()
    data class Rejected(val reason: String) : EnrollmentClaimResult()
    data class Unreachable(val detail: String) : EnrollmentClaimResult()
}

/** Puerto HTTP: los tests no levantan HTTPS. */
interface EnrollmentHttpPort {
    fun postJson(url: String, jsonBody: String): EnrollmentHttpAnswer
}

data class EnrollmentHttpAnswer(val statusCode: Int, val body: String)

/**
 * Respuesta del servidor tal cual. Se parsea sin asumir exito: el claim puede
 * volver 403 con un motivo, y el telefono necesita distinguirlo de un 200.
 */
class EnrollmentClaimClient(
    private val clientConfig: ClientConfig,
    private val httpPort: EnrollmentHttpPort = UrlConnectionEnrollmentHttpPort()
) {

    fun buildClaimUrl(): String {
        val scheme = if (clientConfig.useSecureWebSocket) "https" else "http"
        return "$scheme://${clientConfig.workerHost}" +
            com.apollo.mobile.contract.Contract.MOBILE_BRIDGE_PATH +
            ENROLLMENT_CLAIM_SUFFIX
    }

    /**
     * §2 pasos 3 a 5: presentar el desafío y recibir la credencial individual.
     *
     * La `deviceId` que viaja es la estable del teléfono: es la identidad que se
     * va a atar a la credencial, y la que después revoca el dueño.
     *
     * No lleva credencial propia: todavía no hay ninguna. Lo que autoriza esta
     * llamada es el desafío, que es de un solo uso, expira solo y lo emitió el
     * dueño. Por eso NO pide ningún token, y por eso la respuesta nunca se loguea.
     */
    fun claim(challenge: String, deviceId: String): EnrollmentClaimResult {
        if (challenge.isBlank()) {
            return EnrollmentClaimResult.Rejected(REASON_CHALLENGE_MISSING)
        }
        val requestBody = JSONObject()
            .put("challenge", challenge)
            .put("deviceId", deviceId)
            .toString()
        val answer = try {
            httpPort.postJson(buildClaimUrl(), requestBody)
        } catch (failedToReach: Exception) {
            return EnrollmentClaimResult.Unreachable(failedToReach.javaClass.simpleName)
        }
        return readClaimAnswer(answer)
    }

    private fun readClaimAnswer(answer: EnrollmentHttpAnswer): EnrollmentClaimResult {
        val bodyObject = parseBodyObject(answer.body)
            ?: return EnrollmentClaimResult.Rejected(REASON_RESPONSE_INVALID)
        if (answer.statusCode != HTTP_OK) {
            return EnrollmentClaimResult.Rejected(
                bodyObject.optString("reason", REASON_RESPONSE_INVALID)
            )
        }
        if (bodyObject.optString("status") != "enrolled") {
            return EnrollmentClaimResult.Rejected(REASON_RESPONSE_INVALID)
        }
        val credential = bodyObject.optString("credential")
        if (credential.isBlank()) {
            return EnrollmentClaimResult.Rejected(REASON_RESPONSE_INVALID)
        }
        return EnrollmentClaimResult.Enrolled(
            deviceId = bodyObject.optString("deviceId"),
            credential = credential
        )
    }

    private fun parseBodyObject(body: String): JSONObject? = try {
        JSONObject(body)
    } catch (malformed: Exception) {
        null
    }

    companion object {
        const val ENROLLMENT_CLAIM_SUFFIX = "/enrollment/claim"
        const val HTTP_OK = 200
        const val REASON_CHALLENGE_MISSING = "challenge_missing"
        const val REASON_RESPONSE_INVALID = "response_invalid"
    }
}

/**
 * El puerto real. `HttpURLConnection` alcanza porque ya viene en el framework: no
 * hace falta agregar una dependencia para un POST con un body JSON.
 */
class UrlConnectionEnrollmentHttpPort : EnrollmentHttpPort {

    override fun postJson(url: String, jsonBody: String): EnrollmentHttpAnswer {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.connectTimeout = TIMEOUT_MILLISECONDS
            connection.readTimeout = TIMEOUT_MILLISECONDS
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { outputStream ->
                outputStream.write(jsonBody.toByteArray(Charsets.UTF_8))
            }
            val statusCode = connection.responseCode
            val stream = if (statusCode in 200..299) {
                connection.inputStream
            } else {
                connection.errorStream
            }
            val bodyText = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            return EnrollmentHttpAnswer(statusCode = statusCode, body = bodyText)
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        const val TIMEOUT_MILLISECONDS = 15_000
    }
}
