package com.apollo.mobile

import com.apollo.mobile.session.reconnect.ReconnectScheduler
import com.apollo.mobile.session.reconnect.ReconnectTask

/**
 * Scheduler falso para probar reconexion sin dormir.
 *
 * El tiempo no avanza solo: el test decide cuando, con `advanceBy` o
 * `runPending`. Eso es lo que hace determinista a la prueba de backoff — con un
 * `Handler` real, verificar un tope de 30 segundos significaria esperar 30
 * segundos o tener una prueba que a veces pasa.
 */
class FakeReconnectScheduler : ReconnectScheduler {

    class PendingTask(
        val id: Int,
        var delayMilliseconds: Long,
        val action: () -> Unit
    ) : ReconnectTask {
        var isCancelled: Boolean = false
            private set
        var isExecuted: Boolean = false
            private set

        fun execute() {
            isExecuted = true
            action()
        }

        fun cancel() {
            isCancelled = true
        }
    }

    /** Cada tarea agendada, en el orden en que se agendaron. */
    val scheduledTaskList = mutableListOf<PendingTask>()

    val cancelledTaskIdList = mutableListOf<Int>()

    private var nowMilliseconds: Long = 0
    private var nextTaskId: Int = 1

    override fun scheduleOnce(delayMilliseconds: Long, action: () -> Unit): ReconnectTask {
        val task = PendingTask(nextTaskId++, delayMilliseconds, action)
        scheduledTaskList.add(task)
        return task
    }

    override fun cancel(task: ReconnectTask) {
        val pendingTask = task as? PendingTask ?: return
        pendingTask.cancel()
        cancelledTaskIdList.add(pendingTask.id)
    }

    /** La cantidad de reintentos que siguen esperando y no fueron cancelados. */
    fun getPendingCount(): Int =
        scheduledTaskList.count { !it.isCancelled && !it.isExecuted }

    /** El retraso del proximo reintento vivo, o null si no hay ninguno. */
    fun readNextPendingDelayMilliseconds(): Long? =
        scheduledTaskList.lastOrNull { !it.isCancelled && !it.isExecuted }?.delayMilliseconds

    /** Corre el reintento pendiente. Devuelve false si no habia ninguno. */
    fun runPending(): Boolean {
        val task = scheduledTaskList.lastOrNull { !it.isCancelled && !it.isExecuted } ?: return false
        task.execute()
        return true
    }

    /**
     * Corre hasta [runCount] reintentos, encadenando: cada reconexion que se
     * programa sola vuelve a entrar por aca. Es lo que permite probar el
     * crecimiento del backoff sin escribir un bucle en cada test.
     */
    fun runChain(runCount: Int): Int {
        var executed = 0
        while (executed < runCount && runPending()) {
            executed += 1
        }
        return executed
    }

    fun advanceClock(milliseconds: Long) {
        nowMilliseconds += milliseconds
    }

    fun readNowMilliseconds(): Long = nowMilliseconds
}
