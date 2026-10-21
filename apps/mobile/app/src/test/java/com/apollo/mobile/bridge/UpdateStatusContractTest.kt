package com.apollo.mobile.bridge

import com.apollo.mobile.updates.UpdateManifest
import com.apollo.mobile.updates.UpdateOwner
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateStatusContractTest {
    @Test
    fun updatesCheckDevuelveElSobreCompletoInclusoConCamposNulos() {
        val result = updateStatusData(UpdateOwner.State.SinComprobar, "staging", "0.1.1")
        assertEquals(
            setOf("channel", "installedVersion", "status", "latestVersion", "notes", "publishedAt", "message"),
            result.keys,
        )
        val json = JSONObject(result)
        assertEquals("staging", json.getString("channel"))
        assertEquals("0.1.1", json.getString("installedVersion"))
        assertEquals("idle", json.getJSONObject("status").getString("kind"))
        assertTrue(json.isNull("latestVersion"))
        assertTrue(json.isNull("notes"))
        assertTrue(json.isNull("publishedAt"))
        assertTrue(json.isNull("message"))
    }

    @Test
    fun updatesCheckMapeaDisponibleAlEstadoDelContrato() {
        val manifest = UpdateManifest(
            versionName = "0.2.0",
            versionCode = 2,
            channel = "staging",
            notes = "test release",
            publishedAt = "2026-10-17T00:00:00Z",
            apkUrl = "https://example.invalid/apollo.apk",
            sizeBytes = 10,
            sha256 = "a".repeat(64),
            minSdkInt = 33,
            minClientVersionCode = 1,
            minSigningCertificateSha256 = null,
        )
        val json = JSONObject(updateStatusData(UpdateOwner.State.Disponible(manifest), "staging", "0.1.1"))
        assertEquals("available", json.getJSONObject("status").getString("kind"))
        assertEquals("0.2.0", json.getString("latestVersion"))
        assertEquals("test release", json.getString("notes"))
        assertEquals("2026-10-17T00:00:00Z", json.getString("publishedAt"))
    }
}
