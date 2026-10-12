package com.apollo.mobile.notification

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build

/**
 * BLOCK 12.4: pedir `POST_NOTIFICATIONS` en Android 13+.
 *
 * Va en su propia clase, y no dentro de `AndroidNotificationAdapter`, por una
 * razon que no es de estilo: pedir un permiso es una llamada a `Activity`, y el
 * adapter lo usan el service, el BroadcastReceiver de la alarma y los callbacks
 * del socket, donde no existe una Activity. Como el pedido quedara en un lugar
 * al que no puede llegar, el permiso nunca se pedia y la app publicaba en el
 * vacio.
 *
 * La decision de si hace falta pedir y como se interpreta la respuesta son
 * funciones puras (`isRuntimePermissionRequired`, `resolveOutcome`) y estan
 * testeadas; lo que queda aca es solo el cableado con la Activity.
 */
class NotificationPermissionRequest(private val activity: Activity) {

    /**
     * Devuelve si la app debe mostrar el dialogo. Falso en API < 33 y cuando el
     * permiso ya esta concedido, para no pedir dos veces.
     */
    fun shouldRequest(currentSdkInt: Int = Build.VERSION.SDK_INT): Boolean {
        if (!AndroidNotificationAdapter.isRuntimePermissionRequired(currentSdkInt)) {
            return false
        }
        return !isAlreadyGranted()
    }

    fun isAlreadyGranted(): Boolean =
        androidx.core.content.ContextCompat.checkSelfPermission(
            activity,
            AndroidNotificationAdapter.POST_NOTIFICATIONS_PERMISSION
        ) == PackageManager.PERMISSION_GRANTED

    /**
     * Dispara el dialogo. Devolver `false` de `shouldRequest` no es un error:
     * en API < 33 el permiso ya esta concedido.
     */
    fun request(onOutcome: (PermissionOutcome) -> Unit) {
        if (!shouldRequest()) {
            onOutcome(PermissionOutcome.Granted)
            return
        }
        activity.requestPermissions(
            arrayOf(AndroidNotificationAdapter.POST_NOTIFICATIONS_PERMISSION),
            PERMISSION_REQUEST_CODE
        )
        // El resultado llega por `onRequestPermissionsResult`. Se reporta
        // `Denied` de forma optimista solo si el usuario no responde, que es lo
        // que corresponde: no se puede afirmar que se concedio.
        pendingOutcomeCallback = onOutcome
    }

    /**
     * Lo llama `MainActivity.onRequestPermissionsResult`. Devolver `true` deja
     * claro que el resultado fue consumido.
     */
    fun onRequestPermissionsResult(
        requestCode: Int,
        grantResults: IntArray
    ): Boolean {
        if (requestCode != PERMISSION_REQUEST_CODE) {
            return false
        }
        val callback = pendingOutcomeCallback
        pendingOutcomeCallback = null
        val isGranted = grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        callback?.invoke(AndroidNotificationAdapter.resolveOutcome(isGranted))
        return true
    }

    private var pendingOutcomeCallback: ((PermissionOutcome) -> Unit)? = null

    companion object {
        const val PERMISSION_REQUEST_CODE = 4201
    }
}
