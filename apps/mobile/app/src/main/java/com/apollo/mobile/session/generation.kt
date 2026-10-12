package com.apollo.mobile.session

/**
 * BLOCK 12.5.1: contador de generacion de un socket.
 *
 * Cada socket que se abre recibe un numero. Un callback que llega de un socket
 * viejo —el que OkHttp todavia tiene en la cola cuando ya se abrio uno nuevo, o
 * el `onFailure` de un socket que se cerro a mano— no puede tocar el estado de la
 * sesion que lo reemplazo.
 *
 * Sin esto, reconectar es una carrera: el `onClosed` del socket viejo puede
 * desconectar el socket nuevo que ya estaba ONLINE, o un 1008 tardio puede
 * marcar como revocada una sesion recien recuperada.
 *
 * Vive aparte porque el concepto es separable del estado de la sesion, y porque
 * al estar aislado su invariante se lee de un vistazo: solo avanza.
 */
class ConnectionGeneration {

    private var current: Int = 0

    /** Numero de la generacion vigente. */
    fun read(): Int = current

    /** Invalida la actual. Todo socket abierto antes queda viejo. */
    fun invalidate() {
        current += 1
    }

    /** Un numero dado esta vencido si no es la generacion vigente. */
    fun isStale(generation: Int): Boolean = generation != current
}
