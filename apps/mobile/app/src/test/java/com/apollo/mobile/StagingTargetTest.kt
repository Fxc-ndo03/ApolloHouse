import com.apollo.mobile.transport.ClientConfig
import com.apollo.mobile.transport.normalizeWorkerHostInput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** FASE 2.11 — el destino del cliente Android se resuelve al compilar. */
class StagingTargetTest {

    @Test
    fun default_worker_host_carries_no_secret() {
        val host = com.apollo.mobile.BuildConfig.DEFAULT_WORKER_HOST
        assertTrue("el host por defecto no lleva token", !host.contains("token"))
        assertTrue("el host por defecto no lleva secret", !host.contains("secret"))
    }

    @Test
    fun default_worker_host_is_valid_input_when_present() {
        val host = com.apollo.mobile.BuildConfig.DEFAULT_WORKER_HOST
        if (host.isEmpty()) {
            return
        }
        assertEquals(host, normalizeWorkerHostInput(host))
    }

    @Test
    fun enrollment_and_socket_share_the_same_environment() {
        val host = com.apollo.mobile.BuildConfig.DEFAULT_WORKER_HOST
        if (host.isEmpty()) {
            return
        }
        val config = ClientConfig(workerHost = host, isDebugBuild = false)
        assertTrue("el transporte va cifrado", config.useSecureWebSocket)
        val socketUrl = config
            .buildSocketRequest(com.apollo.mobile.transport.DeviceCredential.LegacySharedSecret("x"))
            .url
        assertTrue("el socket usa el mismo host", socketUrl.contains(host))
        assertTrue("el socket usa wss", socketUrl.startsWith("wss://"))
    }
}