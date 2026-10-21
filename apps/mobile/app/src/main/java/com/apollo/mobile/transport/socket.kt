package com.apollo.mobile.transport

/** Transporte: solo bytes. No sabe de capabilities, de comandos ni de respuestas. */
interface DeviceSocket {
    fun send(rawMessageText: String)
    fun close()
}

interface DeviceSocketListener {
    fun onOpen()
    fun onMessage(rawMessageText: String)
    /** Raw WebSocket binary payload, used by streamed PCM responses. */
    fun onBinaryMessage(payload: ByteArray) = Unit
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
