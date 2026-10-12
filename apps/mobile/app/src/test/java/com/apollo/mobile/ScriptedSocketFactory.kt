package com.apollo.mobile

import com.apollo.mobile.transport.DeviceSocket
import com.apollo.mobile.transport.DeviceSocketFactory
import com.apollo.mobile.transport.DeviceSocketListener
import com.apollo.mobile.transport.DeviceSocketRequest

/**
 * Socket falso que recuerda TODOS los listeners que se abrieron.
 *
 * `RecordingSocketFactory` guarda solo el ultimo, y para el caso que importa acá
 * —un callback tardio de una conexion anterior— hace falta poder dirige el
 * mensaje a un socket viejo puntual. Sin eso, el test probaria el socket nuevo
 * dos veces y pasaria sin estar probando nada.
 *
 * Un indice es la unidad de la prueba: `openCount` es cuantos sockets se
 * abrieron, y el listener del socket N es `openedListenerList[N - 1]`.
 */
class ScriptedSocketFactory : DeviceSocketFactory {

    val openedListenerList = mutableListOf<DeviceSocketListener>()
    val openedRequestList = mutableListOf<DeviceSocketRequest>()
    val closeCountList = mutableListOf<Int>()

    var openCount: Int = 0
        private set

    override fun open(request: DeviceSocketRequest, listener: DeviceSocketListener): DeviceSocket {
        openCount += 1
        openedRequestList.add(request)
        openedListenerList.add(listener)
        return ScriptedSocket(openCount)
    }

    /** El listener del socket [index] de 1 a [openCount]. */
    fun listenerOf(index: Int): DeviceSocketListener {
        check(index in 1..openCount) { "no existe el socket $index" }
        return openedListenerList[index - 1]
    }

    fun deliverTo(index: Int, rawMessageText: String) {
        listenerOf(index).onMessage(rawMessageText)
    }

    /** Cierra el socket [index] como si se hubiera cortado la red. */
    fun dropSocketAt(index: Int) {
        listenerOf(index).onClosed()
    }

    /** Una caida de red puede llegar por `onClosed` o por `onFailure`. */
    fun failSocketAt(index: Int, detail: String = "timeout") {
        listenerOf(index).onFailure(detail)
    }

    private class ScriptedSocket(private val index: Int) : DeviceSocket {
        override fun send(rawMessageText: String) = Unit
        override fun close() = Unit
    }
}
