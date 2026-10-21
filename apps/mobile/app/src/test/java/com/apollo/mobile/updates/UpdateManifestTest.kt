package com.apollo.mobile.updates

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FASE 3.1 — pruebas del actualizador de Android.
 *
 * Son pruebas UNITARIAS: no simulan que una descarga occurred ni que una
 * instalación happened. Verifican las DECISIONES (qué versión, de qué canal,
 * con qué requisitos) y el parseo del manifiesto. La descarga real y el
 * instalador del sistema se prueban en dispositivo, no acá.
 */
class UpdateManifestTest {

    private val hashValido = "a".repeat(64)

    private fun manifiesto(
        version: String = "0.2.0",
        versionCode: Long = 12,
        channel: String = "stable",
        apkUrl: String = "https://github.com/o/r/releases/download/v0.2.0/apollo.apk",
        sha256: String = hashValido,
        sizeBytes: Long = 12345,
        minSdkInt: Int = 25,
        minClientVersionCode: Long = 0
    ): UpdateManifest = UpdateManifest(
        versionName = version,
        versionCode = versionCode,
        channel = channel,
        notes = "notas",
        publishedAt = "2026-03-01T00:00:00Z",
        apkUrl = apkUrl,
        sizeBytes = sizeBytes,
        sha256 = sha256,
        minSdkInt = minSdkInt,
        minClientVersionCode = minClientVersionCode,
        minSigningCertificateSha256 = null
    )

    private fun json(
        version: String = "0.2.0",
        versionCode: Long = 12,
        channel: String = "stable",
        apkUrl: String = "https://example.invalid/apollo.apk",
        sha256: String = hashValido,
        sizeBytes: Long = 12345,
        minSdkInt: Int = 25,
        minClientVersionCode: Long = 0
    ): String = """
        {
          "schemaVersion": 1,
          "version": "$version",
          "versionCode": $versionCode,
          "channel": "$channel",
          "notes": "notas",
          "publishedAt": "2026-03-01T00:00:00Z",
          "apkUrl": "$apkUrl",
          "sizeBytes": $sizeBytes,
          "sha256": "$sha256",
          "minSdkInt": $minSdkInt,
          "minClientVersionCode": $minClientVersionCode
        }
    """.trimIndent()

    // 1. No hay actualizacion disponible.
    @Test
    fun sin_version_nueva_no_se_instala() {
        val manifest = manifiesto(versionCode = 12)
        val decision = UpdateEvaluator.evaluate(12, 33, "stable", manifest)
        assertFalse(decision.shouldInstall)
        assertEquals(
            UpdateRejection.NoEsMasNueva(12, 12),
            UpdateEvaluator.findRejection(12, 33, "stable", manifest)
        )
    }

    @Test
    fun una_version_anterior_tampoco_se_instala() {
        val manifest = manifiesto(versionCode = 12)
        assertFalse(UpdateEvaluator.evaluate(20, 33, "stable", manifest).shouldInstall)
    }

    // 2. Existe una version nueva.
    @Test
    fun version_nueva_si_se_ofrece() {
        val decision = UpdateEvaluator.evaluate(11, 33, "stable", manifiesto(versionCode = 12))
        assertTrue(decision.shouldInstall)
        assertNull(UpdateEvaluator.findRejection(11, 33, "stable", decision.manifest))
        assertEquals(12L, decision.manifest.versionCode)
    }

    // 3. Manifiesto invalido o incompleto.
    @Test
    fun manifiesto_invalido_o_incompleto_se_descarta() {
        assertNull(UpdateManifest.parse("no es json"))
        assertNull(UpdateManifest.parse("{}"))

        assertNull(UpdateManifest.parse(json(version = "")))
        assertNull(UpdateManifest.parse(json(versionCode = 0)))
        assertNull(UpdateManifest.parse(json(channel = "")))
        assertNull(UpdateManifest.parse(json(channel = "canal-inventado")))
        assertNull(UpdateManifest.parse(json(apkUrl = "")))
        assertNull(UpdateManifest.parse(json(sizeBytes = 0)))
        assertNull(UpdateManifest.parse(json(sha256 = "corto")))
    }

    // 8. Un APK por http:// no se acepta aunque tenga todo lo demás bien.
    @Test
    fun un_apk_que_no_es_https_se_descarta() {
        assertNull(UpdateManifest.parse(json(apkUrl = "http://example.invalid/apollo.apk")))
    }

    // 8 (bis). Aislamiento de canales en las DOS direcciones.
    @Test
    fun staging_no_instala_un_manifiesto_de_produccion() {
        val manifest = manifiesto(versionCode = 99, channel = "stable")
        assertFalse(UpdateEvaluator.evaluate(1, 33, "staging", manifest).shouldInstall)
        assertEquals(
            UpdateRejection.CanalDistinto("staging", "stable"),
            UpdateEvaluator.findRejection(1, 33, "staging", manifest)
        )
    }

    @Test
    fun produccion_no_instala_un_manifiesto_de_staging() {
        val manifest = manifiesto(versionCode = 99, channel = "staging")
        assertFalse(UpdateEvaluator.evaluate(1, 33, "stable", manifest).shouldInstall)
        assertEquals(
            UpdateRejection.CanalDistinto("stable", "staging"),
            UpdateEvaluator.findRejection(1, 33, "stable", manifest)
        )
    }

    @Test
    fun un_cliente_muy_viejo_no_puede_instalar_un_artefacto_que_lo_exige() {
        val manifest = manifiesto(versionCode = 50, minClientVersionCode = 40)
        assertFalse(UpdateEvaluator.evaluate(2, 33, "stable", manifest).shouldInstall)
        assertEquals(
            UpdateRejection.ClienteAntiguo(40, 2),
            UpdateEvaluator.findRejection(2, 33, "stable", manifest)
        )
    }

    @Test
    fun un_dispositivo_muy_viejo_no_ofrece_un_apk_que_no_puede_ejecutar() {
        val manifest = manifiesto(versionCode = 50, minSdkInt = 26)
        assertFalse(UpdateEvaluator.evaluate(1, 24, "stable", manifest).shouldInstall)
        assertEquals(
            UpdateRejection.IncompatibleConElDispositivo(26, 24),
            UpdateEvaluator.findRejection(1, 24, "stable", manifest)
        )
    }

    @Test
    fun el_orden_de_las_reglas_importa_el_canal_gana_siempre() {
        // Con canal equivocado Y version menor, el motivo reportado es el canal:
        // es el problema que hay que arreglar primero.
        val manifest = manifiesto(versionCode = 5, channel = "staging")
        val rejection = UpdateEvaluator.findRejection(50, 33, "stable", manifest)
        assertTrue(rejection is UpdateRejection.CanalDistinto)
    }

    // 5. El hash incompleto o de longitud incorrecta nunca llega a la descarga.
    @Test
    fun un_hash_que_no_es_sha256_se_rechaza_al_parsear() {
        assertNull(UpdateManifest.parse(json(sha256 = "abcd")))
        assertNull(UpdateManifest.parse(json(sha256 = "z".repeat(64))))
    }

    // 13. El manifiesto que se publica tiene la forma que el cliente consume.
    @Test
    fun un_manifiesto_bien_formado_se_interpreta_completo() {
        val parsed = UpdateManifest.parse(json(minSdkInt = 26, minClientVersionCode = 10))
        assertNotNull(parsed)
        requireNotNull(parsed)
        assertEquals("0.2.0", parsed.versionName)
        assertEquals(12L, parsed.versionCode)
        assertEquals("stable", parsed.channel)
        assertEquals(12345L, parsed.sizeBytes)
        assertEquals(hashValido, parsed.sha256)
        assertEquals(26, parsed.minSdkInt)
        assertEquals(10L, parsed.minClientVersionCode)
    }

    // 10. Actualizar no puede cambiar la identidad de la app.
    @Test
    fun el_manifiesto_no_pide_cambiar_de_identidad_ni_de_certificado() {
        val parsed = UpdateManifest.parse(json())
        requireNotNull(parsed)
        // La identidad la fija el build (applicationId) y el certificado, no el
        // manifiesto: por eso UpdateManifest no tiene ningun campo para eso.
        assertNull(parsed.minSigningCertificateSha256)
    }
}