package com.apollo.mobile.identity

import com.apollo.mobile.SettableContext
import com.apollo.mobile.transport.CredentialCipher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicLong

class AccountSessionStoreTest {

    private class PrefixCipher : CredentialCipher {
        var failEncryption = false

        override fun encrypt(plainText: String): String {
            check(!failEncryption)
            return "ciphertext:$plainText"
        }

        override fun decrypt(cipherText: String): String {
            check(cipherText.startsWith("ciphertext:"))
            return cipherText.removePrefix("ciphertext:")
        }
    }

    @Test
    fun writesOnlyEncryptedTokenAndRestoresAccountIdentity() {
        val persisted = mutableMapOf<String, Any>()
        val context = SettableContext(persisted)
        val cipher = PrefixCipher()
        val now = AtomicLong(10_000L)
        val store = AccountSessionStore(context, cipher) { now.get() }

        assertTrue(store.writeSession("acc-test", "session-token-test", "Person@Example.com", 20_000L))

        assertEquals("ciphertext:session-token-test", persisted["session_token"])
        assertFalse(persisted.values.contains("session-token-test"))
        assertFalse(persisted.keys.any { it.contains("password", ignoreCase = true) })

        val restored = AccountSessionStore(context, cipher) { now.get() }
        assertTrue(restored.hasSession())
        assertEquals("acc-test", restored.readAccountId())
        assertEquals("person@example.com", restored.readEmail())
        assertEquals("session-token-test", restored.readSessionToken())
    }

    @Test
    fun expiryClearsThePersistedSession() {
        val persisted = mutableMapOf<String, Any>()
        val context = SettableContext(persisted)
        val now = AtomicLong(10_000L)
        val store = AccountSessionStore(context, PrefixCipher()) { now.get() }

        assertTrue(store.writeSession("acc-test", "session-token-test", "a@example.com", 20_000L))
        now.set(20_000L)

        assertNull(store.readSessionToken())
        assertFalse(store.hasSession())
        assertFalse(persisted.containsKey("session_token"))
        assertFalse(persisted.containsKey("account_id"))
        assertFalse(persisted.containsKey("account_email"))
    }

    @Test
    fun cipherFailureDoesNotLeaveThePreviousSessionAuthenticated() {
        val persisted = mutableMapOf<String, Any>()
        val context = SettableContext(persisted)
        val cipher = PrefixCipher()
        val store = AccountSessionStore(context, cipher) { 10_000L }
        assertTrue(store.writeSession("acc-old", "old-session-token", "old@example.com", 20_000L))

        cipher.failEncryption = true
        assertFalse(store.writeSession("acc-new", "new-session-token", "new@example.com", 30_000L))

        assertFalse(store.hasSession())
        assertNull(store.readAccountId())
        assertFalse(persisted.containsKey("session_token"))
    }

    @Test
    fun logoutClearsTokenIdentityAndExpiry() {
        val persisted = mutableMapOf<String, Any>()
        val store = AccountSessionStore(SettableContext(persisted), PrefixCipher()) { 10_000L }
        assertTrue(store.writeSession("acc-test", "session-token-test", "a@example.com", 20_000L))

        assertTrue(store.clearSession())

        assertFalse(store.hasSession())
        assertTrue(persisted.isEmpty())
    }
}
