package com.apollo.mobile.transport

/** Transporte: solo bytes. No sabe de capabilities, de comandos ni de respuestas. */
interface DeviceSocket {
    fun send(rawMessageText: String)
    fun close()
}

interface DeviceSocketListener {
    fun onOpen()
    fun onMessage(rawMessageText: String)
    fun onClosed()
    fun onFailure(detail: String)

    /**
     * BLOCK 12: el servidor cerro el socket con un codigo y un motivo. El
     * transporte no interpreta nada: reporta los hechos y la sesion decide que
     * significa. `POLICY_VIOLATION_CLOSURE_CODE` es el que usa el DO cuando la
     * credencial es invalida o esta revocada.
     */
    fun onServerClose(closeCode: Int, reason: String) {
        // Por defecto no cambia nada: una sesion que no sabe de autorizacion
        // (o un test) sigue el camino normal de reconexion.
    }

    companion object {
        /** RFC 6455, seccion 7.4.1: el endpointViola la politica del servidor. */
        const val POLICY_VIOLATION_CLOSURE_CODE = 1008
    }
}

/**
 * BLOCK 12 §4: la peticion lleva la credencial en un header, no en la URL.
 *
 * `url` y `headerMap` van separados a proposito: la URL es lo que puede terminar
 * en un access log, y `headerMap` es lo que no.
 */
data class DeviceSocketRequest(
    val url: String,
    val headerMap: Map<String, String> = emptyMap()
)

interface DeviceSocketFactory {
    fun open(request: DeviceSocketRequest, listener: DeviceSocketListener): DeviceSocket
}

/**
 * Permite inyectar un socket falso en tests sin levantar workerd: la sesion no
 * depende de OkHttp, solo de esta interfaz.
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
