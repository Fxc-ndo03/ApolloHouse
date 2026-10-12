package com.apollo.mobile.transport

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/** Transporte real sobre OkHttp: Android 7.1 no tiene WebSocket en el framework. */
class OkHttpSocketFactory(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
) : DeviceSocketFactory {

    override fun open(
        request: DeviceSocketRequest,
        listener: DeviceSocketListener
    ): DeviceSocket {
        // BLOCK 12: los headers viajan en el handshake del WebSocket. La
        // credencial individual nunca pasa por la URL.
        val httpRequest = Request.Builder()
            .url(request.url)
            .apply {
                for ((headerName, headerValue) in request.headerMap) {
                    header(headerName, headerValue)
                }
            }
            .build()
        val webSocket = client.newWebSocket(httpRequest, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                listener.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                listener.onMessage(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                // BLOCK 12: el code y el reason se reponen al listener. Antes se
                // tragaban y se repondia 1000, que hacia que una revocacion fuera
                // indistinguible de una caida de red, y el telefono reconectaba en
                // loop con una credencial muerta.
                listener.onServerClose(code, reason)
                webSocket.close(NORMAL_CLOSURE_CODE, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                // OkHttp entrega el cierre en onClosing y despues en onClosed con
                // el 1000 que el propio cliente respondio, asi que reason llega
                // vacio. Solo se avisa si no se aviso antes.
                if (code != NORMAL_CLOSURE_CODE) {
                    listener.onServerClose(code, reason)
                }
                listener.onClosed()
            }

            override fun onFailure(webSocket: WebSocket, throwable: Throwable, response: Response?) {
                listener.onFailure(throwable.javaClass.simpleName)
            }
        })
        return OkHttpSocket(webSocket)
    }

    private class OkHttpSocket(private val webSocket: WebSocket) : DeviceSocket {
        override fun send(rawMessageText: String) {
            webSocket.send(rawMessageText)
        }

        override fun close() {
            webSocket.close(NORMAL_CLOSURE_CODE, null)
        }
    }

    private companion object {
        const val NORMAL_CLOSURE_CODE = 1000
    }
}
