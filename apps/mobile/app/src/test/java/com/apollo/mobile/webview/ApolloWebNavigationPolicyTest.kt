package com.apollo.mobile.webview

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FASE 6.1 · Etapa 2 — la politica de navegacion es logica pura, asi que se
 * prueba sin emulador y sin dispositivo.
 *
 * Lo que se verifica aqui es el requisito del encargo: "no cargar URLs externas
 * ni habilitar acceso nativo indiscriminado desde JavaScript". La primera mitad
 * es esta clase; la segunda es que Etapa 2 no registra ningun
 * `@JavascriptInterface`, y lo cubre el guard de fuente del final.
 */
class ApolloWebNavigationPolicyTest {

    @Test
    fun `el origen local esta permitido`() {
        assertTrue(
            ApolloWebNavigationPolicy.isAllowedUrl(
                "https://appassets.androidplatform.net/assets/webapp/index.html",
            ),
        )
    }

    @Test
    fun `la entrada declarada usa el origen permitido`() {
        assertEquals(
            "https://appassets.androidplatform.net/assets/webapp/index.android.html",
            ApolloWebNavigationPolicy.ENTRY_URL,
        )
        assertFalse(ApolloWebNavigationPolicy.shouldBlockUrl(ApolloWebNavigationPolicy.ENTRY_URL))
    }

    @Test
    fun `atras se consume solo cuando React devuelve true`() {
        assertTrue(isWebBackConsumed("true"))
        assertFalse(isWebBackConsumed("false"))
        assertFalse(isWebBackConsumed(null))
    }

    @Test
    fun `una URL externa se bloquea`() {
        assertTrue(ApolloWebNavigationPolicy.shouldBlockUrl("https://example.com/login"))
        assertTrue(ApolloWebNavigationPolicy.shouldBlockUrl("http://example.com"))
    }

    /**
     * El ataque de sufijo: el host permitido como PREFIJO de otro host. Una
     * comparacion por texto lo aceptaria; comparar host y puerto no.
     */
    @Test
    fun `un host que empieza por el permitido no cuela`() {
        assertTrue(
            ApolloWebNavigationPolicy.shouldBlockUrl(
                "https://appassets.androidplatform.net.ejemplo.invalido/assets/webapp/index.html",
            ),
        )
    }

    @Test
    fun `otro protocolo sobre el mismo host se bloquea`() {
        assertTrue(
            ApolloWebNavigationPolicy.shouldBlockUrl(
                "http://appassets.androidplatform.net/assets/webapp/index.html",
            ),
        )
    }

    @Test
    fun `otro puerto se bloquea`() {
        assertTrue(
            ApolloWebNavigationPolicy.shouldBlockUrl(
                "https://appassets.androidplatform.net:8443/assets/webapp/index.html",
            ),
        )
    }

    /**
     * `file://` y `content://` son las dos formas de saltarse el origen. Con
     * `allowFileAccess = false` ya estan apagadas del lado del WebView, pero la
     * politica las rechaza tambien por si esa bandera cambia.
     */
    @Test
    fun `file y content se bloquean`() {
        assertTrue(ApolloWebNavigationPolicy.shouldBlockUrl("file:///data/data/com.apollo.mobile/files/x.html"))
        assertTrue(ApolloWebNavigationPolicy.shouldBlockUrl("content://com.apollo.mobile/x"))
        assertTrue(ApolloWebNavigationPolicy.shouldBlockUrl("javascript:alert(1)"))
    }

    @Test
    fun `una URL malformada se bloquea en vez de propagar`() {
        assertTrue(ApolloWebNavigationPolicy.shouldBlockUrl("no-es-una-url"))
        assertTrue(ApolloWebNavigationPolicy.shouldBlockUrl(""))
    }

    @Test
    fun `el mayusculas en el host no evita el bloqueo`() {
        assertTrue(
            ApolloWebNavigationPolicy.shouldBlockUrl(
                "https://APPASSETS.ANDROIDPLATFORM.NET.ejemplo.invalido/x",
            ),
        )
    }

    @Test
    fun `javascript solo queda habilitado para el origen propio`() {
        assertTrue(
            ApolloWebNavigationPolicy.isJavaScriptEnabledFor(
                "https://appassets.androidplatform.net/assets/webapp/index.html",
            ),
        )
        assertFalse(ApolloWebNavigationPolicy.isJavaScriptEnabledFor("https://example.com"))
    }
}
