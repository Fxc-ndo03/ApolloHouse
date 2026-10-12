package com.apollo.mobile.session

/**
 * BLOCK 12.5.2: la unica regla que decide si el foreground service sigue vivo.
 *
 * Es una funcion pura a proposito: el "cuando" es politica del dueno de la
 * sesion, y tiene que poder probarse sin levantar un Service de Android, que no
 * se puede instanciar en un test unitario.
 *
 * La regla: el service acompana a la sesion mientras exista una intencion de
 * estar conectado. `DISCONNECTED` significa que la sesion termino — porque el
 * servidor la cerro con 1008 (revocacion o credencial rotada), porque el hello
 * fue rechazado, o porque alguien llamo a `stop()`. En todos esos casos el
 * service no tiene nada que sostener y debe pararse solo: dejarlo corriendo con
 * una sesion muerta seria exactamente el "falso siempre conectado" que este
 * bloque vino a eliminar.
 *
 * `RECONNECTING` mantiene el service vivo: es el caso por el que existe —
 * sostener el proceso mientras el backoff hace su trabajo.
 */
fun shouldForegroundServiceKeepRunning(state: MobileSessionState): Boolean =
    state != MobileSessionState.DISCONNECTED
