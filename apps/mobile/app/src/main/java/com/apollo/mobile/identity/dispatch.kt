package com.apollo.mobile.identity

import java.util.concurrent.Executor

/**
 * BLOCK 12.5.2: el canje del desafio no puede correr en el hilo principal.
 *
 * El sintoma que lo manifesto: `NetworkOnMainThreadException`. El claim usa
 * `HttpURLConnection`, y desde targetSdk 11 Android lanza eso cuando se toca la
 * red desde el hilo de la UI. El error llegaba envuelto en `Unreachable`, que es
 * correcto: para el usuario el Worker no respondio.
 *
 * Por que estaba oculto antes: hasta ahora el claim fallaba antes, por el
 * transporte, y el error de red nunca llegaba a ocurrir. Arreglado el transporte,
 * aparecio el siguiente problema de la pila. No son dos bugs: es el mismo
 * recorrido, detenido en la primera falla.
 *
 * El executor y el posteo al hilo principal se inyectan para que el test pueda
 * correr esto sin Android.
 */
class EnrollmentClaimDispatcher(
    private val backgroundExecutor: Executor,
    private val mainThreadPoster: ((() -> Unit) -> Unit)
) {

    /**
     * Lanza el canje fuera del hilo principal y entrega el resultado en el hilo
     * principal, que es el unico que puede tocar la vista.
     *
     * `onResult` se invoca exactamente una vez: si el executor rechaza la tarea,
     * el resultado se entrega como `Unreachable` en vez de perderse en silencio.
     */
    fun submit(
        client: EnrollmentClaimClient,
        challenge: String,
        deviceId: String,
        onResult: (EnrollmentClaimResult) -> Unit
    ) {
        try {
            backgroundExecutor.execute {
                val result = try {
                    client.claim(challenge = challenge, deviceId = deviceId)
                } catch (unexpected: Exception) {
                    EnrollmentClaimResult.Unreachable(unexpected.javaClass.simpleName)
                }
                mainThreadPoster { onResult(result) }
            }
        } catch (rejectedByExecutor: RuntimeException) {
            mainThreadPoster {
                onResult(
                    EnrollmentClaimResult.Unreachable(rejectedByExecutor.javaClass.simpleName)
                )
            }
        }
    }
}
