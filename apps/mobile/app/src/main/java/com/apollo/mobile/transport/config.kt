package com.apollo.mobile.transport

/**
 * Config del endpoint. El host llega por constructor: no hay un default compilado.
 *
 * BLOCK 12.5.2: `useSecureWebSocket` dejo de ser un booleano que el que llama
 * elige y paso a derivarse del host y de la variante de build. El motivo exacto
 * esta en `resolveIsSecureTransport`.
 *
 * El host debe venir ya normalizado por [normalizeWorkerHostInput]: sin esquema
 * y sin barra final. La app lo normaliza una vez, en el borde, y lo que llega
 * aca es siempre `host` o `host:puerto`.
 */
data class ClientConfig(
    val workerHost: String,
    val isDebugBuild: Boolean = false
) {

    /**
     * Si el transporte va cifrado. Es la misma respuesta para el enrollment
     * (`https`) y para el socket (`wss`), y sale de una sola funcion.
     */
    val useSecureWebSocket: Boolean
        get() = resolveIsSecureTransport(workerHost, isDebugBuild)

    /**
     * BLOCK 12 §4: arma la peticion del socket segun la credencial.
     *
     *  - Enrolled: la credencial va en `Authorization: Bearer` y la URL queda
     *    limpia. Es lo que evita que la credencial de un telefono termine en un
     *    log de URL del servidor o de un proxy.
     *  - Legacy: el secreto global sigue en `?token=`, porque el servidor y
     *    Desktop ya esperan exactamente eso y el bloque exige no romperlos.
     *
     * Los dos caminos nunca se mezclan: si hay credencial enrolada, no se manda
     * el secreto global aunque tambien este guardado. Esa es la regla anti-bypass
     * del lado del cliente.
     */
    fun buildSocketRequest(credential: DeviceCredential): DeviceSocketRequest {
        val scheme = if (useSecureWebSocket) "wss" else "ws"
        val baseUrl = "$scheme://$workerHost" +
            com.apollo.mobile.contract.Contract.MOBILE_BRIDGE_PATH
        return when (credential) {
            is DeviceCredential.Enrolled -> DeviceSocketRequest(
                url = baseUrl,
                headerMap = mapOf(AUTHORIZATION_HEADER to "Bearer " + credential.credential)
            )
            is DeviceCredential.LegacySharedSecret -> DeviceSocketRequest(
                url = baseUrl + "?token=" + java.net.URLEncoder.encode(
                    credential.sharedSecret,
                    "UTF-8"
                )
            )
        }
    }

    companion object {
        const val AUTHORIZATION_HEADER = "Authorization"
    }
}
