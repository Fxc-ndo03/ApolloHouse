package com.apollo.mobile.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnErrorTest {

    @Test
    fun elLimitePorMinutoNoSePresentaComoErrorDeConexion() {
        val notice = TurnError.describe("quota_exceeded", "Límite de uso alcanzado (requestsPerMinute)")
        assertEquals(TurnErrorNotice.Category.QUOTA_PER_MINUTE, notice.category)
        assertFalse(notice.isConnectionFailure)
        assertEquals("Esperá un momento", notice.title)
    }

    @Test
    fun laCuotaAgotadaDiceQueNoEsProblemaDeConexion() {
        val notice = TurnError.describe("quota_exceeded", "Límite de uso alcanzado (dailyTokens)")
        assertEquals(TurnErrorNotice.Category.QUOTA_EXHAUSTED, notice.category)
        assertFalse(notice.isConnectionFailure)
        assertTrue(notice.detail.contains("No es un problema de tu conexión"))
    }

    @Test
    fun unFalloDeRedSiEsErrorDeConexion() {
        assertTrue(TurnError.describe("network_error", "sin red").isConnectionFailure)
    }

    @Test
    fun noFiltraLaClaveInternaDelLimiteAlUsuario() {
        val notice = TurnError.describe("quota_exceeded", "Límite de uso alcanzado (requestsPerMinute)")
        assertFalse(notice.detail.contains("requestsPerMinute"))
    }

    @Test
    fun conservaElMensajeDelServidorCuandoNoSabeQuePasa() {
        assertEquals("detalle real", TurnError.describe("raro", "detalle real").detail)
    }

    @Test
    fun laAsignacionDiariaDelProveedorNoSeDisfrazadeCuotaDeApollo() {
        val notice = TurnError.describe(
            "turn_failed",
            "Se agotó la asignación diaria gratuita de Cloudflare Workers AI (10.000 neurons).",
        )
        assertEquals(TurnErrorNotice.Category.PROVIDER_ALLOCATION, notice.category)
        assertFalse(notice.isConnectionFailure)
        assertTrue(notice.detail.contains("Apollo"))
    }

    @Test
    fun reconoceElCodigo4006CrudoDeCloudflare() {
        val notice = TurnError.describe(
            "turn_failed",
            "4006: you have used up your daily free allocation of 10,000 neurons",
        )
        assertEquals(TurnErrorNotice.Category.PROVIDER_ALLOCATION, notice.category)
    }

    @Test
    fun distingueModeloNoDisponibleDeAsignacionAgotada() {
        val notice = TurnError.describe(
            "turn_failed",
            "El modelo WORKERS_AI_LLM_MODEL configurado no esta disponible",
        )
        assertEquals(TurnErrorNotice.Category.PROVIDER_UNAVAILABLE, notice.category)
    }
}
