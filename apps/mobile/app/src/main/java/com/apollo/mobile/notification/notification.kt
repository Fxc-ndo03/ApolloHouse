package com.apollo.mobile.notification

/** Resultado de pedir el permiso de notificacion. No reintenta solo. */
sealed class PermissionOutcome {
    object Granted : PermissionOutcome()
    object Denied : PermissionOutcome()
}

/**
 * Adapter de plataforma. La sesion no sabe de Android: solo pide permiso y muestra.
 */
interface NotificationAdapter {
    fun requestPermission(): PermissionOutcome
    fun post(title: String, body: String): Boolean
}
