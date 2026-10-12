package com.apollo.mobile.transport

/**
 * BLOCK 12.5.2: como se decide el transporte, y por que.
 *
 * El problema que resuelve: `ClientConfig` elegia entre `https` y `http` con un
 * booleano que el que llama podia poner en cualquier valor. Con el default en
 * `true`, escribir `127.0.0.1:8799` en el formulario producia
 * `https://127.0.0.1:8799`, que falla de dos maneras a la vez: Android veta el
 * cleartext en targetSdk 36, y Wrangler local no habla TLS en el 8799.
 *
 * La decision se toma ACA, con dos datos que no dependen de lo que el usuario
 * escribio, y es la misma para el enrollment y para el socket. Si los dos
 * caminos calcularan el transporte por su cuenta, tarde o temprano
 * discreparían.
 *
 * Regla: se permite cleartext SOLO cuando se cumplen las dos condiciones:
 *
 *  1. la build es debug, y
 *  2. el host es loopback.
 *
 * Las dos, no una sola. Con solo la primera, una build de debug poderia hablar
 * en claro con cualquier host. Con solo la segunda, un release a un host
 * equivocado bajaria a `http`. Las dos juntas acotan la excepcion a la unica
 * situacion en que el cleartext tiene sentido: el Worker local de la maquina
 * del desarrollo, alcanzado por el tunel USB.
 */

/** El host ya sin esquema, como lo espera [ClientConfig]. */
const val SCHEME_SEPARATOR = "://"

/**
 * Acepta lo que una persona escribe en el campo y devuelve el host utilizable.
 *
 * Se acepta con o sin esquema a proposito: la instruccion de uso cambio varias
 * veces durante el desarrollo del hardware, y exigir el formato exacto solo
 * genera URLs malformadas como `https://http://127.0.0.1:8799`. Lo que se
 * normaliza es el host; el esquema NO decide nada y por eso se descarta.
 *
 * Devuelve `null` si no queda nada utilizable, para que la UI pueda decirlo en
 * vez de construir una URL rota.
 */
fun normalizeWorkerHostInput(rawInput: String): String? {
    val trimmed = rawInput.trim()
    if (trimmed.isEmpty()) {
        return null
    }
    val withoutScheme = trimmed.substringAfter(SCHEME_SEPARATOR, trimmed)
    // Un esquema repetido viene de pegar dos veces el prefijo. Se recorta otra
    // vez en vez de producir una URL imposible.
    val collapsed = withoutScheme.trim().let {
        if (it.startsWith(SCHEME_SEPARATOR)) it.substringAfter(SCHEME_SEPARATOR) else it
    }
    val host = collapsed.trim().trim('/').trim()
    if (host.isEmpty()) {
        return null
    }
    // Una barra o un espacio en medio significa que el usuario no escribio un
    // host. Se rechaza en vez de adivinar.
    if (host.any { character -> character == '/' || character.isWhitespace() }) {
        return null
    }
    return host
}

/**
 * Hosts que apuntan a la propia maquina. `10.0.2.2` es el alias del emulador
 * hacia el host, y lo mismo aplica al loopback.
 */
fun isLoopbackWorkerHost(workerHost: String): Boolean {
    val hostWithoutPort = workerHost.substringBefore(':').trim().lowercase()
    return hostWithoutPort in LOOPBACK_HOST_SET
}

/**
 * La unica decision de transporte de la app.
 *
 * Devolver `true` significa "usar TLS". El default es `true`: para que un host
 * desconocido, una build release o un forgotten de este parametro caigan del
 * lado seguro.
 */
fun resolveIsSecureTransport(workerHost: String, isDebugBuild: Boolean): Boolean {
    if (!isDebugBuild) {
        return true
    }
    return !isLoopbackWorkerHost(workerHost)
}

private val LOOPBACK_HOST_SET = setOf("127.0.0.1", "localhost", "::1", "10.0.2.2")
