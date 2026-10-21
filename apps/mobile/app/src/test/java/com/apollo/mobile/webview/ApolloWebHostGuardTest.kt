package com.apollo.mobile.webview

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FASE 6.1 · Etapa 2 — guardas de fuente del host WebView.
 *
 * Los tres requisitos de la etapa se cumplen con codigo que un test unitario no
 * puede observar (una Activity no se instancia en JUnit). Estos guardas leen el
 * fuente, que es donde se puede comprobar sin emulador:
 *
 *  1. No hay puente: ningun `@JavascriptInterface` en produccion.
 *  2. La navegacion se delega a la politica, no a un juicio inline.
 *  3. Las funciones nativas que el encargo manda preservar siguen existiendo.
 */
class ApolloWebHostGuardTest {

    private fun mainSourceFile(relativePath: String): File {
        val projectDirectory = File(System.getProperty("user.dir") ?: ".")
        return File(
            File(projectDirectory, "src/main/java/com/apollo/mobile"),
            relativePath,
        )
    }

    private fun readMainSource(relativePath: String): String {
        val sourceFile = mainSourceFile(relativePath)
        assertTrue("no existe el archivo ${sourceFile.path}", sourceFile.isFile)
        return sourceFile.readText()
    }

    @Test
    fun `la Etapa 2 no registra ninguna interfaz JavaScript`() {
        val productionPackage = File(System.getProperty("user.dir") ?: ".", "src/main/java")
        val offendingFileList = productionPackage
            .walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .filter { it.readText().contains("@JavascriptInterface") }
            .map { it.path }
            .toList()

        assertTrue(
            "Etapa 2 no debe registrar un puente; aparece en: $offendingFileList",
            offendingFileList.isEmpty(),
        )
    }

    @Test
    fun `la politica de navegacion bloquea, no permite`() {
        val policySource = readMainSource("webview/ApolloWebNavigationPolicy.kt")
        assertTrue(policySource.contains("fun shouldBlockUrl("))
        assertTrue(policySource.contains("ALLOWED_ORIGIN"))
    }

    @Test
    fun `la actividad delega la navegacion en la politica`() {
        val activitySource = readMainSource("webview/ApolloWebActivity.kt")
        assertTrue(activitySource.contains("shouldOverrideUrlLoading"))
        assertTrue(
            activitySource.contains("ApolloWebNavigationPolicy.shouldBlockUrl"),
        )
    }

    @Test
    fun `la actividad no usa el origen file para cargar`() {
        val activitySource = readMainSource("webview/ApolloWebActivity.kt")
        assertTrue(activitySource.contains("WebViewAssetLoader"))
        assertFalse(
            "el host no puede cargar con file://",
            activitySource.contains("\"file://"),
        )
        assertFalse(
            "el host no puede cargar con content://",
            activitySource.contains("\"content://"),
        )
    }

    @Test
    fun `el host apaga el acceso a archivos`() {
        val activitySource = readMainSource("webview/ApolloWebActivity.kt")
        assertTrue(activitySource.contains("allowFileAccess = false"))
        assertTrue(activitySource.contains("allowContentAccess = false"))
    }

    /**
     * Las funciones que el encargo prohibe eliminar o duplicar. Esta guarda no
     * comprueba comportamiento: comprueba que los objetos siguen ahi, para que
     * una etapa futura no los pueda borrar en silencio.
     */
    @Test
    fun `las funciones nativas que hay que preservar siguen presentes`() {
        val requiredFileList = listOf(
            "ApolloApplication.kt",
            "LoginActivity.kt",
            "ShellActivity.kt",
            "DeviceActivity.kt",
            "conversation/ConversationActivity.kt",
            "conversation/owner.kt",
            "session/owner.kt",
            "identity/account-auth-client.kt",
            "identity/account-session-store.kt",
            "updates/UpdateOwner.kt",
            "command/allowlist.kt",
            "transport/socket.kt",
        )
        for (relativePath in requiredFileList) {
            assertTrue(
                "falta la funcion nativa obligatoria: $relativePath",
                mainSourceFile(relativePath).isFile,
            )
        }
    }

    /** `ApolloApplication` expone los owners una sola vez: no hay duplicados. */
    @Test
    fun `los owners se declaran una sola vez en ApolloApplication`() {
        val applicationSource = readMainSource("ApolloApplication.kt")
        assertEqualsCount(1, applicationSource, "val sessionOwner")
        assertEqualsCount(1, applicationSource, "val conversationOwner")
    }

    private fun assertEqualsCount(expected: Int, source: String, fragment: String) {
        val actual = source.split(fragment).size - 1
        assertTrue(
            "«$fragment» aparece $actual veces y se esperaba $expected",
            actual == expected,
        )
    }
}
