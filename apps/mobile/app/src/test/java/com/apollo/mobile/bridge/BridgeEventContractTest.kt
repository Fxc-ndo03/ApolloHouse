package com.apollo.mobile.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeEventContractTest {
    @Test
    fun javascriptPayloadEscapaComillasYSaltosDeLinea() {
        val invocation = BridgeEventContract.javascriptInvocation(
            "text-response-chunk",
            "\"Hola\"\nApollo",
        )
        assertNotNull(invocation)
        assertTrue(invocation!!.contains("\\\"Hola\\\"\\nApollo"))
    }

    @Test
    fun eventoFueraDeLaListaCerradaNoSeEmite() {
        assertNull(BridgeEventContract.javascriptInvocation("auth-token", "{}"))
        assertFalse("auth-token" in BridgeEventContract.ALLOWED_NAMES)
    }
}
