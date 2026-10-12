package com.apollo.mobile.session

import com.apollo.mobile.contract.Contract

/** Backoff acotado: nunca retry infinito agresivo. El ultimo valor es el tope. */
class ReconnectBackoff(
    private val backoffMillisecondList: List<Long> = Contract.RECONNECT_BACKOFF_MILLISECOND_LIST
) {

    var attemptCount: Int = 0
        private set

    fun nextDelayMilliseconds(): Long {
        if (backoffMillisecondList.isEmpty()) {
            throw IllegalStateException("la tabla de backoff no puede estar vacia")
        }
        val index = attemptCount.coerceAtMost(backoffMillisecondList.lastIndex)
        attemptCount += 1
        return backoffMillisecondList[index]
    }

    fun reset() {
        attemptCount = 0
    }
}
