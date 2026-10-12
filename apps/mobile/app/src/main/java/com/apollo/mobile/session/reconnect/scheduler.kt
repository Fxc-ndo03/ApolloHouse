package com.apollo.mobile.session.reconnect

/**
 * BLOCK 12.5.1: programar un reintento mas adelante y poder cancelarlo.
 *
 * Es un puerto, y no una llamada directa a `Handler`, por la misma razon que
 * `HeartbeatScheduler.TimerPort`: la Politica —cuando reintentar y con que
 * retraso— se prueba con un reloj falso, y eso exige que el reloj entre por
 * inyeccion. Con `Handler` adentro, cada test tendria que dormir de verdad y los
 * seis escenarios de reconexion serian lentos y flakes.
 */
interface ReconnectScheduler {
    /** Agenda una accion una sola vez. Devuelve el handle para poder cancelarla. */
    fun scheduleOnce(delayMilliseconds: Long, action: () -> Unit): ReconnectTask

    fun cancel(task: ReconnectTask)
}

/**
 * Handle opaco de una tarea agendada.
 *
 * Va al nivel del archivo y no dentro de `ReconnectScheduler` porque un
 * clasificador anidado en una interfaz no se hereda al scope del objeto que la
 * implementa: `ReconnectTask` solo se resolveria escribiendolo
 * `ReconnectScheduler.ReconnectTask` en cada uso.
 */
interface ReconnectTask

/** Implementacion real sobre el looper principal. */
object SystemReconnectScheduler : ReconnectScheduler {

    override fun scheduleOnce(delayMilliseconds: Long, action: () -> Unit): ReconnectTask {
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        val runnable = Runnable { action() }
        handler.postDelayed(runnable, delayMilliseconds)
        return RunnableTask(handler, runnable)
    }

    override fun cancel(task: ReconnectTask) {
        val runnableTask = task as? RunnableTask ?: return
        runnableTask.handler.removeCallbacks(runnableTask.runnable)
    }

    private class RunnableTask(
        val handler: android.os.Handler,
        val runnable: Runnable
    ) : ReconnectTask
}

/**
 * Calculo del retraso real de reconexion: la tabla del contrato mas jitter.
 *
 * El jitter vive aca y no en [ReconnectBackoff] porque la tabla es un contrato
 * compartido con el Worker —los tests de paridad la comparan— y esta funcion es
 * una politica local del cliente.
 *
 * Sin jitter, N telefonos que pierden la conexion a la vez reconectan a la vez
 * contra el mismo Durable Object: eso es el thundering herd que el backoff solo
 * no evita.
 *
 * `randomPort` devuelve un valor en [0, 1). Es inyectable para que el test no
 * tenga queinterpolarse con el azar.
 */
fun resolveReconnectDelayMilliseconds(
    baseDelayMilliseconds: Long,
    randomPort: () -> Double
): Long {
    val jitterFraction = randomPort().coerceIn(0.0, 0.999_999)
    // Se suma hasta un 20% del base: suficiente para desfasar clientes que
    // compartieron backoff, sin volver el retraso impredecible para el usuario.
    val jitterBound = (baseDelayMilliseconds * JITTER_RATIO).toLong().coerceAtLeast(1L)
    return baseDelayMilliseconds + (jitterBound * jitterFraction).toLong()
}

private const val JITTER_RATIO = 0.2
