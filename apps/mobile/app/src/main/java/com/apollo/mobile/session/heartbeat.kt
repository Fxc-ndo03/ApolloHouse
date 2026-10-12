package com.apollo.mobile.session

/**
 * Un solo timer de heartbeat del cliente. Un reconnect no puede duplicarlo: `start`
 * devuelve false si ya habia uno vivo, igual que HeartbeatScheduler en el Worker.
 */
class HeartbeatScheduler(
    private val timerPort: TimerPort = SystemTimerPort
) {

    interface TimerPort {
        fun setInterval(callback: () -> Unit, milliseconds: Long): Any
        fun clearInterval(handle: Any)
    }

    object SystemTimerPort : TimerPort {
        override fun setInterval(callback: () -> Unit, milliseconds: Long): Any =
            android.os.Handler(android.os.Looper.getMainLooper()).let { handler ->
                val runnable = object : Runnable {
                    override fun run() {
                        callback()
                        handler.postDelayed(this, milliseconds)
                    }
                }
                handler.postDelayed(runnable, milliseconds)
                runnable
            }

        override fun clearInterval(handle: Any) {
            (handle as Runnable).let { runnable ->
                android.os.Handler(android.os.Looper.getMainLooper()).removeCallbacks(runnable)
            }
        }
    }

    var startCount: Int = 0
        private set

    private var handle: Any? = null
    private var intervalMilliseconds: Long = 0L

    val isRunning: Boolean
        get() = handle != null

    val currentIntervalMilliseconds: Long
        get() = intervalMilliseconds

    fun start(milliseconds: Long, beat: () -> Unit): Boolean {
        if (handle != null) {
            return false
        }
        intervalMilliseconds = milliseconds
        handle = timerPort.setInterval(beat, milliseconds)
        startCount += 1
        return true
    }

    fun stop(): Boolean {
        val liveHandle = handle ?: return false
        timerPort.clearInterval(liveHandle)
        handle = null
        return true
    }
}
