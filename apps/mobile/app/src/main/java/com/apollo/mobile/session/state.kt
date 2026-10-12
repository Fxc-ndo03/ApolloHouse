package com.apollo.mobile.session

/**
 * Estado local del cliente. El Worker sigue siendo owner de online/degraded/offline
 * (presence); el cliente solo refleja como esta su propio socket.
 */
enum class MobileSessionState {
    DISCONNECTED,
    CONNECTING,
    AUTHENTICATED,
    ONLINE,
    RECONNECTING
}
