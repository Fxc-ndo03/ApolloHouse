package com.apollo.mobile.webview

/**
 * FASE 6.1 · Etapa 2 — politica de navegacion del WebView privilegiado.
 *
 * El WebView carga EXCLUSIVAMENTE recursos locales empaquetados en el APK a
 * traves de `WebViewAssetLoader`, con origen `https://appassets.androidplatform.net`.
 * Todo lo demas queda bloqueado: si una URL se escapa de ese origen, no se
 * carga, no se abre en otra pestana y no se delega a otra app.
 *
 * Es logica pura a proposito: no toca Android, asi que se prueba en JUnit sin
 * emulador. `ApolloWebActivity` la consulta y aplica la decision.
 *
 * No hay metodo generico que ejecute codigo nativo desde JavaScript: la Etapa 4
 * (puente) anade un allowlist explicito, no una reflexion. Aqui no se expone
 * nada.
 */
object ApolloWebNavigationPolicy {

    /** Origen unico permitido. Es el que `WebViewAssetLoader` intercepta. */
    const val ALLOWED_ORIGIN: String = "https://appassets.androidplatform.net"

    /** Prefijo del origen local. Incluye la barra final. */
    const val ALLOWED_URL_PREFIX: String = "$ALLOWED_ORIGIN/"

    /** Ruta de entrada de la interfaz empaquetada. */
    const val ENTRY_URL: String = "${ALLOWED_URL_PREFIX}assets/webapp/index.android.html"

    /**
     * Decision taken for a URL before it loads.
     *
     * `ALLOW` means it can load inside the privileged WebView. `BLOCK` means it
     * is refused: no request, no external browser, no intent.
     */
    enum class NavigationDecision {
        ALLOW,
        BLOCK,
    }

    /**
     * `true` when the URL is inside the single allowed local origin.
     *
     * The comparison is on scheme, host and port, never on a prefix of the whole
     * text: a string comparison would accept
     * `https://appassets.androidplatform.net.evil.example/`, which is exactly the
     * shape of attack this policy exists to stop.
     */
    fun isAllowedUrl(candidateUrl: String): Boolean =
        parseUrl(candidateUrl)?.let { url ->
            url.scheme == "https" &&
                url.host == "appassets.androidplatform.net" &&
                (url.port == -1 || url.port == 443)
        } ?: false

    /** Convenience for `shouldOverrideUrlLoading`: returns true when blocked. */
    fun shouldBlockUrl(candidateUrl: String): Boolean = !isAllowedUrl(candidateUrl)

    /**
     * JavaScript is enabled only for our own document. A blocked page never gets
     * to run anything, and the bridge (Etapa 4) is not registered in Etapa 2.
     */
    fun isJavaScriptEnabledFor(candidateUrl: String): Boolean = isAllowedUrl(candidateUrl)

    /**
     * Parsing is delegated so this object stays free of Android. On a malformed
     * or relative URL there is nothing to allow: the answer is `null` and the
     * caller blocks.
     */
    private fun parseUrl(candidateUrl: String): ParsedUrl? = try {
        java.net.URL(candidateUrl).let { url ->
            ParsedUrl(
                scheme = url.protocol.lowercase(),
                host = url.host.lowercase(),
                port = url.port,
            )
        }
    } catch (_: java.net.MalformedURLException) {
        null
    }

    private data class ParsedUrl(
        val scheme: String,
        val host: String,
        val port: Int,
    )
}

/** `evaluateJavascript` returns the literal JSON string `true` only if React consumed Back. */
internal fun isWebBackConsumed(evaluationResult: String?): Boolean = evaluationResult == "true"
