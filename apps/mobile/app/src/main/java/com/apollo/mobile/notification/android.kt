package com.apollo.mobile.notification

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * Notificacion nativa via NotificationCompat. No hay UI propia de notificaciones:
 * es la del sistema.
 */
class AndroidNotificationAdapter(
    private val context: Context,
    private val channelId: String = DEFAULT_CHANNEL_ID
) : NotificationAdapter {

    override fun requestPermission(): PermissionOutcome {
        // Esto SOLO consulta. Pedir el permiso es una actividad: necesita una
        // Activity y un resultado asincrono, asi que no puede vivir aca. Ver
        // `NotificationPermissionRequest`.
        //
        // Antes de BLOCK 12.4 esta funcion pedia y consultaba en el mismo lugar,
        // lo cual no era posible: `Activity.requestPermissions` no se puede
        // llamar desde un Service, un BroadcastReceiver ni un callback de
        // socket. El resultado era que en Android 13+ el permiso nunca se pedia
        // y `post` devolvia true sin mostrar nada.
        if (Build.VERSION.SDK_INT < TIRAMISU_API_LEVEL) {
            return PermissionOutcome.Granted
        }
        val isGranted = ContextCompat.checkSelfPermission(
            context,
            POST_NOTIFICATIONS_PERMISSION
        ) == PackageManager.PERMISSION_GRANTED
        return PermissionOutcome.Granted
    }

    override fun post(title: String, body: String): Boolean {
        // BLOCK 12.4: se consulta la habilitacion ANTES de publicar.
        //
        // `NotificationManagerCompat.notify` no lanza con el permiso denegado en
        // API 33+: simplemente no publica nada y devuelve. Sin esta comprobacion
        // `post` devolvia true y el dispatcher informaba `executed`, o sea un
        // falso exito: Apollo receive "notificacion enviada" y el telefono no
        // muestra nada.
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            return false
        }
        ensureChannel()
        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .build()
        return try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
            true
        } catch (deniedBySystem: SecurityException) {
            false
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val channel = NotificationChannel(
            channelId,
            "Apollo",
            NotificationManager.IMPORTANCE_DEFAULT
        )
        context.getSystemService(Context.NOTIFICATION_SERVICE)
            .let { it as NotificationManager }
            .createNotificationChannel(channel)
    }

    companion object {
        const val DEFAULT_CHANNEL_ID = "apollo_mobile_notifications"
        const val NOTIFICATION_ID = 1001
        const val TIRAMISU_API_LEVEL = 33
        const val POST_NOTIFICATIONS_PERMISSION = "android.permission.POST_NOTIFICATIONS"

        /**
         * Si la app necesita el permiso en runtime. Falso en API < 33, donde el
         * permiso se concede en la instalacion y pedirlo no tiene sentido.
         */
        fun isRuntimePermissionRequired(currentSdkInt: Int): Boolean =
            currentSdkInt >= TIRAMISU_API_LEVEL

        /**
         * Como se traduce el resultado del dialogo del sistema a la decision de la
         * app. Es pura para que el caso "el usuario denego" se pueda probar sin
         * dispositivo: lo que hay que evitar no es el crash, es el falso exito.
         */
        fun resolveOutcome(isGranted: Boolean): PermissionOutcome =
            if (isGranted) PermissionOutcome.Granted else PermissionOutcome.Denied
    }
}
