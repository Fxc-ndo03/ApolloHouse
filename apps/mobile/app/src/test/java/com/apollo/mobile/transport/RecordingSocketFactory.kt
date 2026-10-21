package com.apollo.mobile.transport

/**
 * Permite inyectar un socket falso en tests sin levantar workerd: la sesion no
 * depende de OkHttp, solo de esta interfaz.
 *
 * Vive en `src/test` y no en `src/main`: es un doble de pruebas. En produccion
 * solo existe la interfaz `DeviceSocketFactory` y su implementacion real
 * (`transport/okhttp.kt`). El paquete se conserva para que los tests que ya lo
 * importan (`SessionTest`, `HeartbeatTest`, `EnrollmentTest`) compilen sin cambios.
 */
class RecordingSocketFactory : DeviceSocketFactory {

    val sentMessageList = mutableListOf<String>()
    var openedUrl: String? = null
    var openedHeaderMap: Map<String, String> = emptyMap()
    var openCount = 0
    var closeCount = 0
    private var listener: DeviceSocketListener? = null
    private var isOpen = false

    override fun open(
        request: DeviceSocketRequest,
        listener: DeviceSocketListener
    ): DeviceSocket {
        openedUrl = request.url
        openedHeaderMap = request.headerMap
        openCount += 1
        this.listener = listener
        isOpen = true
        return RecordingSocket(this)
    }

    /** El ultimo `Authorization` presentado, o null si no se presento ninguno. */
    fun readPresentedBearerCredential(): String? =
        openedHeaderMap.entries
            .firstOrNull { it.key.equals("Authorization", ignoreCase = true) }
            ?.value
            ?.removePrefix("Bearer ")

    fun acceptOpen() {
        isOpen = true
        listener?.onOpen()
    }

    fun deliver(rawMessageText: String) {
        check(isOpen) { "el socket no esta abierto" }
        listener?.onMessage(rawMessageText)
    }

    fun dropConnection() {
        isOpen = false
        listener?.onClosed()
    }

    /** Simula que el servidor cerro el socket con un motivo (revocacion). */
    fun closeByServer(closeCode: Int, reason: String) {
        isOpen = false
        listener?.onServerClose(closeCode, reason)
        listener?.onClosed()
    }

    fun fail(detail: String) {
        isOpen = false
        listener?.onFailure(detail)
    }

    private class RecordingSocket(private val factory: RecordingSocketFactory) : DeviceSocket {
        override fun send(rawMessageText: String) {
            check(factory.isOpen) { "el socket no esta abierto" }
            factory.sentMessageList.add(rawMessageText)
        }

        override fun close() {
            factory.closeCount += 1
            factory.isOpen = false
        }
    }
}
