package com.apollo.mobile.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppSettingsStoreTest {
    private class MemoryPreferences : AppSettingsPreferences {
        val values = mutableMapOf<String, Any>()
        override fun getBoolean(key: String, defaultValue: Boolean): Boolean = values[key] as? Boolean ?: defaultValue
        override fun getString(key: String, defaultValue: String): String? = values[key] as? String ?: defaultValue
        override fun getFloat(key: String, defaultValue: Float): Float = values[key] as? Float ?: defaultValue
        override fun putValues(values: Map<String, Any>) { this.values.putAll(values) }
    }

    @Test
    fun readDevuelveLos17CamposYNuncaElSecretoDeDispositivo() {
        val preferences = MemoryPreferences()
        val data = AppSettingsStore(preferences) { "https://staging.example" }.read()
        assertEquals(17, data.size)
        assertEquals("https://staging.example", data["worker_url"])
        assertEquals("", data["device_shared_secret"])
    }

    @Test
    fun writePersisteSoloLasSeisClavesPermitidasYDescartaSecretos() {
        val preferences = MemoryPreferences()
        val store = AppSettingsStore(preferences)
        val accepted = store.write(
            mapOf(
                "mic_muted" to true,
                "tts_muted" to false,
                "tts_provider" to "cloudflare",
                "tts_voice" to "voice-test",
                "tts_language" to "es",
                "tts_speed" to 1.25,
                "device_shared_secret" to "not-a-real-secret",
                "worker_url" to "https://invalid.example",
            ),
        )
        assertEquals(AppSettingsStore.WRITABLE_KEYS, accepted)
        assertEquals(AppSettingsStore.WRITABLE_KEYS, preferences.values.keys)
        assertFalse("device_shared_secret" in preferences.values)
        assertEquals(1.25f, preferences.values["tts_speed"])
        assertTrue(store.read()["device_shared_secret"] == "")
    }
}
