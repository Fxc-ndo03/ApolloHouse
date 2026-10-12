package com.apollo.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.apollo.mobile.session.MobileSessionOwner
import com.apollo.mobile.session.MobileSessionState
import com.apollo.mobile.session.shouldForegroundServiceKeepRunning

/**
 * BLOCK 12.5.2: el foreground service que sostiene la sesion en segundo plano.
 *
 * Por que recien ahora: hasta 12.5.1 la sesion vivia en una variable local de la
 * Activity, y cuando Android la cachaba (minimizada, pantalla apagada) mataba el
 * proceso con el socket adentro. El service no arregla la reconexion — eso ya lo
 * hace `MobileSessionOwner` — pero le da al proceso la prioridad que Android le
 * quita a una app en segundo plano, que es la diferencia entre "reconecta en
 * unos segundos" y "no existe hasta que abras la app".
 *
 * Que HACE: una notificacion persistente de baja prioridad y nada mas. No abre
 * sockets, no toca la sesion, no tiene estado propio: solo observa al dueno
 * (`ApolloApplication.sessionOwner`, que ya existia) y se apaga solo cuando la
 * sesion termina. La sesion sigue siendo del Application; si fuera del service,
 * un reinicio del service la mataria.
 *
 * Por que `specialUse` y no otro tipo:
 *
 *  - `dataSync` tiene tope de 6 horas cada 24 desde targetSdk 35: una sesion
 *    pensada para estar siempre conectada seria cortada a diario.
 *  - `connectedDevice` y `remoteMessaging` describen otras cosas (dispositivos
 *    externos, mensajeria entre equipos); declararlos seria sobredeclarar el
 *    uso real, que es un socket persistente a un Worker propio.
 *  - `specialUse` es el tipo que existe para "uso valido no cubierto por los
 *    demas", con declaracion de subtipo en el manifiesto. Para una app personal
 *    sideloaded es el unico tipo honesto. Si algun dia se publica en Play, ese
 *    subtipo es lo que se justifica en la consola.
 *
 * Limites, dichos explicitamente: esto NO garantiza supervivencia ante
 * force-stop, reinicio del telefono, o politicas del fabricante. Un force-stop
 * mata todo. `START_NOT_STICKY` porque al revivir el proceso no hay host ni
 * sesion que restaurar: el usuario vuelve a abrir la app, y eso es lo honesto.
 *
 * La notificacion del service en API 33+ depende del permiso
 * `POST_NOTIFICATIONS`, que la app ya pide en `MainActivity`. Sin el permiso, el
 * service corre igual y la notificacion no se ve: la prioridad la da el estado
 * foreground, no la visibilidad.
 */
class MobileService : Service() {

    /** El observador registrado contra el dueno; se guarda para poder descolgarlo. */
    private var stateListener: MobileSessionOwner.SessionListener? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val application = application as? ApolloApplication
        if (application == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        // Obligatorio dentro de los ~5s de startForegroundService. El tipo solo
        // existe desde API 34; abajo de ahi va 0 y ServiceCompat hace lo correcto.
        ServiceCompat.startForeground(
            this,
            SESSION_NOTIFICATION_ID,
            buildSessionNotification(),
            resolveForegroundServiceType()
        )
        registerStateListener(application.sessionOwner)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stateListener?.let { listener ->
            (application as? ApolloApplication)?.sessionOwner?.unobserve(listener)
        }
        stateListener = null
        super.onDestroy()
    }

    /**
     * Un solo listener por vida del service. `onStartCommand` puede llegar varias
     * veces (el usuario aprieta Conectar con el service ya vivo) y registrar uno
     * por llamada seria una fuga de listeners.
     */
    private fun registerStateListener(sessionOwner: MobileSessionOwner) {
        if (stateListener != null) {
            return
        }
        val listener = object : MobileSessionOwner.SessionListener {
            override fun onStateChanged(state: MobileSessionState) {
                if (!shouldForegroundServiceKeepRunning(state)) {
                    stopSelf()
                }
            }
        }
        stateListener = listener
        sessionOwner.observe(listener)
    }

    private fun buildSessionNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                SESSION_CHANNEL_ID,
                "Sesion de Apollo",
                NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        return NotificationCompat.Builder(this, SESSION_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Apollo")
            .setContentText("Sesion con el cuerpo activa")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun resolveForegroundServiceType(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0
        }

    companion object {
        /** Distinto del de `AndroidNotificationAdapter`: este no se toca nunca. */
        const val SESSION_NOTIFICATION_ID = 4202
        const val SESSION_CHANNEL_ID = "apollo_mobile_session"
    }
}
