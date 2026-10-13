package com.apollo.mobile.identity

import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * Cliente de autenticación de CUENTA contra las rutas `/api/auth/...`.
 *
 * Contrato real del Worker (FASE 2.2): register/login devuelven
 * `{ accountId, sessionToken, expiresAt }`; session devuelve
 * `{ authenticated: true, accountId }`; logout devuelve `{ ok }`.
 * El email y el password viajan en el body, NUNCA en la URL; el token de
 * sesión viaja en el header `Authorization: Bearer`, NUNCA en la URL ni en
 * logs.
 */
object AccountAuthContract {

    const val REGISTER_PATH = "/api/auth/register"
    const val LOGIN_PATH = "/api/auth/login"
    const val LOGOUT_PATH = "/api/auth/logout"
    const val SESSION_PATH = "/api/auth/session"
    const val DEVICES_PATH = "/api/auth/devices"

    fun buildAuthUrl(workerHost: String, path: String): String {
        val scheme = if (workerHost.startsWith("localhost") || workerHost.startsWith("127.0.0.1")) {
            "http"
        } else {
            "https"
        }
        return "$scheme://$workerHost$path"
    }
}

data class AccountAuthAnswer(
    val statusCode: Int,
    val body: String,
)

interface AccountAuthHttpPort {
    fun postJson(url: String, jsonBody: String, bearerToken: String?): AccountAuthAnswer
    fun getJson(url: String, bearerToken: String?): AccountAuthAnswer
}

class UrlConnectionAccountAuthHttpPort : AccountAuthHttpPort {

    override fun postJson(url: String, jsonBody: String, bearerToken: String?): AccountAuthAnswer =
        execute(url, method = "POST", jsonBody = jsonBody, bearerToken = bearerToken)

    override fun getJson(url: String, bearerToken: String?): AccountAuthAnswer =
        execute(url, method = "GET", jsonBody = null, bearerToken = bearerToken)

    private fun execute(
        url: String,
        method: String,
        jsonBody: String?,
        bearerToken: String?,
    ): AccountAuthAnswer {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = TIMEOUT_MILLISECONDS
            connection.readTimeout = TIMEOUT_MILLISECONDS
            connection.setRequestProperty("Content-Type", "application/json")
            if (bearerToken != null) {
                connection.setRequestProperty("Authorization", "Bearer $bearerToken")
            }
            if (jsonBody != null) {
                connection.doOutput = true
                connection.outputStream.use { outputStream ->
                    outputStream.write(jsonBody.toByteArray(Charsets.UTF_8))
                }
            }
            val statusCode = connection.responseCode
            val stream = if (statusCode in 200..299) connection.inputStream else connection.errorStream
            val bodyText = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            return AccountAuthAnswer(statusCode = statusCode, body = bodyText)
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val TIMEOUT_MILLISECONDS = 15_000
    }
}

sealed class AccountAuthOutcome {
    data class Authenticated(
        val accountId: String,
        val sessionToken: String,
        val expiresAtMilliseconds: Long,
    ) : AccountAuthOutcome()

    data class Rejected(val reason: String) : AccountAuthOutcome()
}

class AccountAuthClient(
    private val workerHost: String,
    private val httpPort: AccountAuthHttpPort = UrlConnectionAccountAuthHttpPort(),
) {

    fun register(email: String, password: String): AccountAuthOutcome =
        authenticate(AccountAuthContract.REGISTER_PATH, email, password, expectStatus = 200)

    fun login(email: String, password: String): AccountAuthOutcome =
        authenticate(AccountAuthContract.LOGIN_PATH, email, password, expectStatus = 200)

    private fun authenticate(
        path: String,
        email: String,
        password: String,
        expectStatus: Int,
    ): AccountAuthOutcome {
        val url = AccountAuthContract.buildAuthUrl(workerHost, path)
        val body = JSONObject().apply {
            put("email", email)
            put("password", password)
        }
        val answer = httpPort.postJson(url, body.toString(), bearerToken = null)
        if (answer.statusCode != expectStatus) {
            return AccountAuthOutcome.Rejected(resolveRejectionReason(answer))
        }
        val parsed = parseSessionIssued(answer.body)
            ?: return AccountAuthOutcome.Rejected(REASON_RESPONSE_INVALID)
        return AccountAuthOutcome.Authenticated(
            accountId = parsed.first,
            sessionToken = parsed.second,
            expiresAtMilliseconds = parsed.third,
        )
    }

    fun logout(sessionToken: String): Boolean {
        val url = AccountAuthContract.buildAuthUrl(workerHost, AccountAuthContract.LOGOUT_PATH)
        return httpPort.postJson(url, "{}", bearerToken = sessionToken).statusCode == 200
    }

    /** Devuelve el `accountId` de la sesión viva, o null si expiró/revocó. */
    fun resolveSessionAccount(sessionToken: String): String? {
        val url = AccountAuthContract.buildAuthUrl(workerHost, AccountAuthContract.SESSION_PATH)
        val answer = httpPort.getJson(url, bearerToken = sessionToken)
        if (answer.statusCode != 200) return null
        return runCatching {
            val parsed = JSONObject(answer.body)
            if (parsed.optBoolean("authenticated", false)) parsed.optString("accountId") else null
        }.getOrNull()?.takeIf { it.isNotEmpty() }
    }

    fun enrollDevice(sessionToken: String, deviceId: String, deviceType: String, deviceName: String): Boolean {
        val url = AccountAuthContract.buildAuthUrl(workerHost, AccountAuthContract.DEVICES_PATH)
        val body = JSONObject().apply {
            put("deviceId", deviceId)
            put("deviceType", deviceType)
            put("deviceName", deviceName)
        }
        return httpPort.postJson(url, body.toString(), bearerToken = sessionToken).statusCode == 200
    }

    private fun parseSessionIssued(body: String): Triple<String, String, Long>? = runCatching {
        val parsed = JSONObject(body)
        val accountId = parsed.optString("accountId")
        val token = parsed.optString("sessionToken")
        val expiresAt = parsed.optLong("expiresAt")
        if (accountId.isEmpty() || token.isEmpty()) null else Triple(accountId, token, expiresAt)
    }.getOrNull()

    private fun resolveRejectionReason(answer: AccountAuthAnswer): String = when {
        answer.statusCode == 401 -> REASON_INVALID_CREDENTIALS
        answer.statusCode == 409 -> REASON_EMAIL_TAKEN
        answer.statusCode == 400 -> REASON_INVALID_INPUT
        else -> REASON_RESPONSE_INVALID
    }

    companion object {
        const val REASON_INVALID_CREDENTIALS = "credenciales_invalidas"
        const val REASON_EMAIL_TAKEN = "email_en_uso"
        const val REASON_INVALID_INPUT = "datos_invalidos"
        const val REASON_RESPONSE_INVALID = "respuesta_invalida"
    }
}
