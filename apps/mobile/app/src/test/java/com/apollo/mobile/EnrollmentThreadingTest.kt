package com.apollo.mobile

import com.apollo.mobile.identity.EnrollmentClaimClient
import com.apollo.mobile.identity.EnrollmentClaimDispatcher
import com.apollo.mobile.identity.EnrollmentClaimResult
import com.apollo.mobile.identity.EnrollmentHttpAnswer
import com.apollo.mobile.identity.EnrollmentHttpPort
import com.apollo.mobile.transport.ClientConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * BLOCK 12.5.2: el claim no puede correr en el hilo principal.
 *
 * El sintoma real en el Moto G35: `no se pudo contactar al Worker
 * (NetworkOnMainThreadException)`. Estos tests fijan la causa raiz para que
 * volver a la UI no seNOTE: `HttpURLConnection` desde el hilo principal lanza
 * desde targetSdk 11.
 */
class EnrollmentThreadingTest {

    private class RecordingHttpPort(
        private val answer: EnrollmentHttpAnswer,
        private val thrown: Exception? = null
    ) : EnrollmentHttpPort {
        var callingThreadName: String? = null
            private set

        override fun postJson(url: String, jsonBody: String): EnrollmentHttpAnswer {
            callingThreadName = Thread.currentThread().name
            thrown?.let { throw it }
            return answer
        }
    }

    private fun buildDispatcher(
        background: java.util.concurrent.Executor,
        poster: ((() -> Unit) -> Unit)
    ) = EnrollmentClaimDispatcher(backgroundExecutor = background, mainThreadPoster = poster)

    @Test
    fun theClaimDoesNotRunOnTheCallingThread() {
        val port = RecordingHttpPort(
            EnrollmentHttpAnswer(
                statusCode = 200,
                body = """{"status":"enrolled","deviceId":"mobile:abc","credential":"apollo_dev_x"}"""
            )
        )
        val latch = CountDownLatch(1)
        var posterCallCount: Int = 0
        var result: EnrollmentClaimResult? = null
        // Un hilo dedicado con nombre propio, para poder compararlo con el
        // hilo que llama. Un executor en un pool no alcanza: los nombres varian.
        val namedThreadFactory = java.util.concurrent.ThreadFactory { runnable ->
            Thread(runnable, "apollo-enrollment-worker")
        }
        val executor = Executors.newSingleThreadExecutor(namedThreadFactory)

        val dispatcher = buildDispatcher(executor) { action ->
            // El poster es la costura que en produccion salta al hilo principal
            // con `Handler(Looper.getMainLooper()).post`. Acá se cuenta que pasa
            // por ahi, que es la garantia que importa.
            posterCallCount += 1
            action()
        }

        dispatcher.submit(
            client = EnrollmentClaimClient(ClientConfig(workerHost = "apollo.example"), port),
            challenge = "apollo_enr_c",
            deviceId = "mobile:abc"
        ) { delivered ->
            result = delivered
            latch.countDown()
        }

        assertTrue("el resultado no llego", latch.await(5, TimeUnit.SECONDS))
        executor.shutdown()

        assertEquals(
            "el claim NO puede ejecutarse en el hilo que dispara",
            "apollo-enrollment-worker",
            port.callingThreadName
        )
        assertEquals("el resultado debe pasar por el poster, exactamente una vez", 1, posterCallCount)
        assertTrue(result is EnrollmentClaimResult.Enrolled)
    }

    @Test
    fun aNetworkFailureBecomesUnreachableAndStillReachesTheMainThread() {
        val port = RecordingHttpPort(
            answer = EnrollmentHttpAnswer(statusCode = 0, body = ""),
            thrown = java.net.SocketTimeoutException("timeout")
        )
        val latch = CountDownLatch(1)
        var delivered: EnrollmentClaimResult? = null
        var postedOnMain: Boolean? = null

        val dispatcher = buildDispatcher(Executors.newSingleThreadExecutor()) { action ->
            postedOnMain = true
            action()
        }

        dispatcher.submit(
            client = EnrollmentClaimClient(ClientConfig(workerHost = "apollo.example"), port),
            challenge = "apollo_enr_c",
            deviceId = "mobile:abc"
        ) { result ->
            delivered = result
            latch.countDown()
        }

        assertTrue(latch.await(5, TimeUnit.SECONDS))
        assertEquals(true, postedOnMain)
        assertTrue("una caida de red no es un rechazo", delivered is EnrollmentClaimResult.Unreachable)
    }

    @Test
    fun aRejectedAnswerStillArrivesWithoutTouchingTheCredential() {
        val port = RecordingHttpPort(
            EnrollmentHttpAnswer(statusCode = 403, body = """{"reason":"device_id_mismatch"}""")
        )
        val latch = CountDownLatch(1)
        var delivered: EnrollmentClaimResult? = null

        val dispatcher = buildDispatcher(Executors.newSingleThreadExecutor()) { it() }
        dispatcher.submit(
            client = EnrollmentClaimClient(ClientConfig(workerHost = "apollo.example"), port),
            challenge = "apollo_enr_c",
            deviceId = "mobile:abc"
        ) { result ->
            delivered = result
            latch.countDown()
        }

        assertTrue(latch.await(5, TimeUnit.SECONDS))
        assertEquals(EnrollmentClaimResult.Rejected("device_id_mismatch"), delivered)
    }
}
