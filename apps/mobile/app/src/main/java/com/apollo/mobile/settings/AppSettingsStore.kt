package com.apollo.mobile.settings

import android.content.SharedPreferences

/** Small persistence boundary so field policy can be tested without Android. */
interface AppSettingsPreferences {
    fun getBoolean(key: String, defaultValue: Boolean): Boolean
    fun getString(key: String, defaultValue: String): String?
    fun getFloat(key: String, defaultValue: Float): Float
    fun putValues(values: Map<String, Any>)
}

class SharedPreferencesAppSettingsPreferences(
    private val preferences: SharedPreferences,
) : AppSettingsPreferences {
    override fun getBoolean(key: String, defaultValue: Boolean): Boolean =
        preferences.getBoolean(key, defaultValue)
    override fun getString(key: String, defaultValue: String): String? =
        preferences.getString(key, defaultValue)
    override fun getFloat(key: String, defaultValue: Float): Float =
        preferences.getFloat(key, defaultValue)

    override fun putValues(values: Map<String, Any>) {
        val editor = preferences.edit()
        values.forEach { (key, value) ->
            when (value) {
                is Boolean -> editor.putBoolean(key, value)
                is String -> editor.putString(key, value)
                is Float -> editor.putFloat(key, value)
            }
        }
        editor.apply()
    }
}

/** Android-facing subset of the shared `AppSettingsData` contract. */
class AppSettingsStore(
    private val preferences: AppSettingsPreferences,
    private val workerUrl: () -> String = { "" },
) {

    fun read(): Map<String, Any?> = mapOf(
        "worker_url" to workerUrl(),
        "device_shared_secret" to "",
        "wake_words" to emptyList<String>(),
        "use_vosk_wake" to false,
        "wake_model_dir" to org.json.JSONObject.NULL,
        "response_output_target" to "",
        "autostart_enabled" to false,
        "mic_muted" to preferences.getBoolean("mic_muted", false),
        "tts_muted" to preferences.getBoolean("tts_muted", false),
        "use_local_core" to false,
        "core_lan_url" to "",
        "tts_provider" to preferences.getString("tts_provider", "cloudflare").orEmpty(),
        "tts_voice" to preferences.getString("tts_voice", "").orEmpty(),
        "tts_language" to preferences.getString("tts_language", "es").orEmpty(),
        "tts_speed" to preferences.getFloat("tts_speed", 1f).toDouble(),
        "input_device_name" to "",
        "output_device_name" to "",
    )

    /** Persists only the six Android-editable fields and returns their names. */
    fun write(patch: Map<String, Any?>): Set<String> {
        val accepted = linkedMapOf<String, Any>()
        for ((key, value) in patch) {
            when (key) {
                "mic_muted", "tts_muted" -> if (value is Boolean) accepted[key] = value
                "tts_provider", "tts_voice", "tts_language" -> if (value is String) accepted[key] = value
                "tts_speed" -> {
                    val speed = (value as? Number)?.toFloat()
                    if (speed != null && speed.isFinite()) accepted[key] = speed
                }
            }
        }

        if (accepted.isEmpty()) return emptySet()
        preferences.putValues(accepted)
        return accepted.keys
    }

    companion object {
        const val PREFERENCES_NAME = "apollo_settings"
        val WRITABLE_KEYS: Set<String> = setOf(
            "mic_muted",
            "tts_muted",
            "tts_provider",
            "tts_voice",
            "tts_language",
            "tts_speed",
        )
    }
}
