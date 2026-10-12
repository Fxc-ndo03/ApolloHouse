package com.apollo.mobile.identity

import android.content.Context
import android.content.SharedPreferences

/**
 * Almacenamiento persistente de la plataforma. Las preferencias de la app viven en
 * el sandbox privado del paquete, asi que ningun otro app puede leerlas.
 */
class IdentityStore(context: Context) {

    private val preferences: SharedPreferences =
        context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun readStoredDeviceId(): String? = preferences.getString(DEVICE_ID_KEY, null)

    fun writeStoredDeviceId(deviceId: String) {
        preferences.edit().putString(DEVICE_ID_KEY, deviceId).apply()
    }

    /** Resuelve el deviceId una sola vez y lo reutiliza en cada arranque. */
    fun resolveStableDeviceId(): String {
        val existingDeviceId = readStoredDeviceId()
        if (existingDeviceId != null && DeviceIdentity.isValidDeviceId(existingDeviceId)) {
            return existingDeviceId
        }
        val stableDeviceId = DeviceIdentity.buildStableDeviceId(existingDeviceId)
        writeStoredDeviceId(stableDeviceId)
        return stableDeviceId
    }

    private companion object {
        const val PREFERENCES_NAME = "apollo_mobile_identity"
        const val DEVICE_ID_KEY = "device_id"
    }
}
