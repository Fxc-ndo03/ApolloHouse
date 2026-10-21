package com.apollo.mobile.bridge

import com.apollo.mobile.identity.AccountAuthAnswer
import com.apollo.mobile.identity.AccountAuthClient
import com.apollo.mobile.identity.AccountAuthHttpPort
import com.apollo.mobile.identity.AccountSessionPersistence
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeAuthHandlerTest {

    private val accountId = "acc_test_123"
    private val token = "synthetic-session-token"
    private val password = "synthetic-password"
    private val email = "person@example.com"
    private val now = 1_800_000_000_000L

    private class FakeAuthHttpPort : AccountAuthHttpPort {
        var loginAnswer = AccountAuthAnswer(200, "{}")
        var registerAnswer = AccountAuthAnswer(200, "{}")
        var sessionAnswer = AccountAuthAnswer(200, "{}")
        var logoutAnswer = AccountAuthAnswer(200, "{}")
        var throwOnSession = false
        var throwOnLogout = false
        val methods = mutableListOf<String>()
        val urls = mutableListOf<String>()
        val requestBodies = mutableListOf<String>()
        val bearerTokens = mutableListOf<String?>()

        override fun postJson(url: String, jsonBody: String, bearerToken: String?): AccountAuthAnswer {
            urls += url
            methods += "POST"
            requestBodies += jsonBody
            bearerTokens += bearerToken
            return when {
                url.endsWith("/api/auth/login") -> loginAnswer
                url.endsWith("/api/auth/register") -> registerAnswer
                else -> {
                    if (throwOnLogout) throw IllegalStateException("synthetic transport failure")
                    logoutAnswer
                }
            }
        }

        override fun getJson(url: String, bearerToken: String?): AccountAuthAnswer {
            urls += url
            methods += "GET"
            requestBodies += ""
            bearerTokens += bearerToken
            if (throwOnSession) throw IllegalStateException("synthetic transport failure")
            return sessionAnswer
        }
    }

    private class FakeSessionPersistence : AccountSessionPersistence {
        var accountId: String? = null
        var token: String? = null
        var email: String = ""
        var expiresAt: Long? = null
        var writeSucceeds = true
        var clearSucceeds = true
        var writes = 0
        var clears = 0

        override fun readSessionToken(): String? = token
        override fun readAccountId(): String? = accountId
        override fun readEmail(): String = email
        override fun hasSession(): Boolean = !token.isNullOrBlank() && !accountId.isNullOrBlank()

        override fun writeSession(
            accountId: String,
            sessionToken: String,
            email: String,
            expiresAtMilliseconds: Long?,
        ): Boolean {
            writes += 1
            if (!writeSucceeds) return false
            this.accountId = accountId
            token = sessionToken
            this.email = email
            expiresAt = expiresAtMilliseconds
            return true
        }

        override fun clearSession(): Boolean {
            clears += 1
            accountId = null
            token = null
            email = ""
            expiresAt = null
            return clearSucceeds
        }
    }

    private fun authenticatedBody(
        id: String = accountId,
        sessionToken: String = token,
        expiry: Long = now + 60_000L,
    ): String = JSONObject()
        .put("accountId", id)
        .put("sessionToken", sessionToken)
        .put("expiresAt", expiry)
        .toString()

    private fun handler(
        http: FakeAuthHttpPort,
        store: FakeSessionPersistence = FakeSessionPersistence(),
        authenticated: (String, String) -> Unit = { _, _ -> },
        cleared: () -> Unit = {},
    ) = BridgeAuthHandler(
        accountAuthClient = AccountAuthClient("staging.invalid", http),
        accountSessionStore = store,
        nowMillisecondsPort = { now },
        onSessionAuthenticated = authenticated,
        onSessionCleared = cleared,
    )

    @Test
    fun successfulLoginPersistsSessionAndReturnsNoTokenOrPasswordToBridge() {
        val http = FakeAuthHttpPort().apply { loginAnswer = AccountAuthAnswer(200, authenticatedBody()) }
        val store = FakeSessionPersistence()
        var startedFor: String? = null
        val response = handler(http, store, authenticated = { id, _ -> startedFor = id })
            .handle("auth.login", mapOf("email" to email, "password" to password))

        assertTrue(response.ok)
        assertEquals(mapOf("accountId" to accountId), response.data)
        assertEquals(accountId, store.accountId)
        assertEquals(token, store.token)
        assertEquals(email, store.email)
        assertEquals(now + 60_000L, store.expiresAt)
        assertEquals(accountId, startedFor)
        assertEquals("POST", http.methods.single())
        assertTrue(http.urls.single().endsWith("/api/auth/login"))
        assertFalse(response.toJson().contains(token))
        assertFalse(response.toJson().contains(password))
    }

    @Test
    fun successfulRegistrationPersistsEmailAndStartsOnlyAfterStorage() {
        val http = FakeAuthHttpPort().apply { registerAnswer = AccountAuthAnswer(200, authenticatedBody()) }
        val store = FakeSessionPersistence()
        val callbackSawStoredSession = mutableListOf<Boolean>()
        val response = handler(http, store, authenticated = { _, _ ->
            callbackSawStoredSession += store.token == token && store.email == email
        }).handle("auth.register", mapOf("email" to " Person@Example.com ", "password" to password))

        assertTrue(response.ok)
        assertEquals(email, store.email)
        assertEquals(listOf(true), callbackSawStoredSession)
        assertTrue(http.urls.single().endsWith("/api/auth/register"))
        assertFalse(response.toJson().contains(token))
    }

    @Test
    fun failedAuthDoesNotPersistAndMapsProviderErrors() {
        val invalidLoginHttp = FakeAuthHttpPort().apply {
            loginAnswer = AccountAuthAnswer(401, "{}")
        }
        val loginStore = FakeSessionPersistence()
        val login = handler(invalidLoginHttp, loginStore)
            .handle("auth.login", mapOf("email" to email, "password" to password))
        assertFalse(login.ok)
        assertEquals(BridgeError.INVALID_CREDENTIALS, login.error)
        assertEquals(0, loginStore.writes)

        val duplicateEmailHttp = FakeAuthHttpPort().apply {
            registerAnswer = AccountAuthAnswer(409, "{}")
        }
        val registerStore = FakeSessionPersistence()
        val register = handler(duplicateEmailHttp, registerStore)
            .handle("auth.register", mapOf("email" to email, "password" to password))
        assertFalse(register.ok)
        assertEquals(BridgeError.EMAIL_TAKEN, register.error)
        assertEquals(0, registerStore.writes)
    }

    @Test
    fun missingProviderCredentialOrExpiredIssuedSessionCannotSignIn() {
        val missingTokenHttp = FakeAuthHttpPort().apply {
            loginAnswer = AccountAuthAnswer(200, JSONObject()
                .put("accountId", accountId)
                .put("expiresAt", now + 60_000L)
                .toString())
        }
        val missingTokenStore = FakeSessionPersistence()
        val missingToken = handler(missingTokenHttp, missingTokenStore)
            .handle("auth.login", mapOf("email" to email, "password" to password))
        assertFalse(missingToken.ok)
        assertEquals(0, missingTokenStore.writes)

        val expiredHttp = FakeAuthHttpPort().apply {
            loginAnswer = AccountAuthAnswer(200, authenticatedBody(expiry = now))
        }
        val expiredStore = FakeSessionPersistence()
        val expired = handler(expiredHttp, expiredStore)
            .handle("auth.login", mapOf("email" to email, "password" to password))
        assertFalse(expired.ok)
        assertEquals(0, expiredStore.writes)
        assertFalse(expired.toJson().contains(token))
    }

    @Test
    fun failedSecureWriteCannotReportSignedInOrStartConversation() {
        val http = FakeAuthHttpPort().apply { loginAnswer = AccountAuthAnswer(200, authenticatedBody()) }
        val store = FakeSessionPersistence().apply { writeSucceeds = false }
        var started = 0
        var stopped = 0
        val response = handler(
            http,
            store,
            authenticated = { _, _ -> started += 1 },
            cleared = { stopped += 1 },
        ).handle("auth.login", mapOf("email" to email, "password" to password))

        assertFalse(response.ok)
        assertEquals(BridgeError.INTERNAL_ERROR, response.error)
        assertEquals(0, started)
        assertEquals(1, stopped)
        assertNull(store.token)
        assertFalse(response.toJson().contains(token))
        assertFalse(response.toJson().contains(password))
    }

    @Test
    fun authStateRestoresOnlyAProviderValidatedPersistedIdentity() {
        val http = FakeAuthHttpPort().apply {
            sessionAnswer = AccountAuthAnswer(200, JSONObject()
                .put("authenticated", true)
                .put("accountId", accountId)
                .toString())
        }
        val store = FakeSessionPersistence().apply {
            accountId = this@BridgeAuthHandlerTest.accountId
            token = this@BridgeAuthHandlerTest.token
            email = this@BridgeAuthHandlerTest.email
        }
        var started = 0
        val response = handler(http, store, authenticated = { _, _ -> started += 1 })
            .handle("auth.state", emptyMap())

        assertTrue(response.ok)
        assertEquals(true, response.data?.get("signedIn"))
        assertEquals(accountId, response.data?.get("accountId"))
        assertEquals(email, response.data?.get("email"))
        assertEquals(1, started)
        assertEquals(token, http.bearerTokens.single())
        assertFalse(response.toJson().contains(token))
    }

    @Test
    fun expiredSessionClearsStoreAndStopsAuthenticatedFlow() {
        val http = FakeAuthHttpPort().apply { sessionAnswer = AccountAuthAnswer(401, "{}") }
        val store = FakeSessionPersistence().apply {
            accountId = this@BridgeAuthHandlerTest.accountId
            token = this@BridgeAuthHandlerTest.token
            email = this@BridgeAuthHandlerTest.email
        }
        var stopped = 0
        val response = handler(http, store, cleared = { stopped += 1 })
            .handle("auth.state", emptyMap())

        assertTrue(response.ok)
        assertEquals(false, response.data?.get("signedIn"))
        assertNull(store.token)
        assertNull(store.accountId)
        assertEquals(1, stopped)
        assertFalse(response.toJson().contains(token))
    }

    @Test
    fun accountMismatchCannotRestoreAnotherLocalSession() {
        val http = FakeAuthHttpPort().apply {
            sessionAnswer = AccountAuthAnswer(200, JSONObject()
                .put("authenticated", true)
                .put("accountId", "acc_different")
                .toString())
        }
        val store = FakeSessionPersistence().apply {
            accountId = this@BridgeAuthHandlerTest.accountId
            token = this@BridgeAuthHandlerTest.token
            email = this@BridgeAuthHandlerTest.email
        }
        var stopped = 0
        val response = handler(http, store, cleared = { stopped += 1 })
            .handle("auth.state", emptyMap())

        assertTrue(response.ok)
        assertEquals(false, response.data?.get("signedIn"))
        assertNull(store.token)
        assertEquals(1, stopped)
    }

    @Test
    fun temporaryValidationFailureDoesNotClearOrEnableSession() {
        val http = FakeAuthHttpPort().apply { throwOnSession = true }
        val store = FakeSessionPersistence().apply {
            accountId = this@BridgeAuthHandlerTest.accountId
            token = this@BridgeAuthHandlerTest.token
            email = this@BridgeAuthHandlerTest.email
        }
        var started = 0
        val response = handler(http, store, authenticated = { _, _ -> started += 1 })
            .handle("auth.state", emptyMap())

        assertFalse(response.ok)
        assertEquals(BridgeError.UNAVAILABLE, response.error)
        assertEquals(token, store.token)
        assertEquals(0, started)
        assertFalse(response.toJson().contains(token))
    }

    @Test
    fun logoutClearsNativeSessionEvenIfRemoteRevocationFailsAndNeverReturnsToken() {
        val http = FakeAuthHttpPort().apply { throwOnLogout = true }
        val store = FakeSessionPersistence().apply {
            accountId = this@BridgeAuthHandlerTest.accountId
            token = this@BridgeAuthHandlerTest.token
            email = this@BridgeAuthHandlerTest.email
        }
        var stopped = 0
        val response = handler(http, store, cleared = { stopped += 1 })
            .handle("auth.logout", emptyMap())

        assertFalse(response.ok)
        assertEquals(BridgeError.UNAVAILABLE, response.error)
        assertNull(store.token)
        assertNull(store.accountId)
        assertEquals(1, stopped)
        assertFalse(response.toJson().contains(token))
        assertEquals(token, http.bearerTokens.single())
    }
}
