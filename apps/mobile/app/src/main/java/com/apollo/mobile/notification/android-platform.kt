package com.apollo.mobile.notification

import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import java.util.Calendar

/**
 * Implementacion Android de [MobilePlatform] (BLOCK 11 §17).
 *
 * Usa las APIs nativas de la plataforma y ninguna UI propia.
 *
 * Android 7.1 es API 25 y el piso sigue ahi: `NotificationChannel` no existe (se
 * guarda el canal en otro lado) y se usan las variantes de `AlarmManager` que API
 * 25 soporta. Lo que si cambio en BLOCK 12.4 es el otro extremo del rango:
 * `PendingIntent.FLAG_IMMUTABLE` se aplica desde API 23 porque con targetSdk 31+
 * su ausencia es un crash, no un warning. `setExactAndAllowWhileIdle` sigue sin
 * usarse.
 *
 * `MediaPlayer` se mantiene como campo porque su estado es por comando: los
 * comandos media_* forman una sesion de reproduccion.
 */
class AndroidMobilePlatform(
    private val context: Context
) : MobilePlatform {

    private val calendarGateway: AndroidCalendarGateway by lazy { AndroidCalendarGateway(context) }

    private val alarmManager: AlarmManager =
        context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    private val audioManager: AudioManager =
        context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var mediaPlayer: MediaPlayer? = null

    override fun showNotification(title: String, body: String): Boolean = false

    override fun setAlarm(label: String, hourMinute: String, repeatDaily: Boolean): Boolean {
        val (hour, minute) = parseHourMinute(hourMinute) ?: return false
        val triggerAt = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, hour)
            set(Calendar.MINUTE, minute)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
            if (timeInMillis <= System.currentTimeMillis()) {
                add(Calendar.DAY_OF_YEAR, 1)
            }
        }
        val intent = Intent(context, AlarmBroadcast::class.java).apply {
            action = ACTION_ALARM
            putExtra(EXTRA_ALARM_LABEL, label)
        }
        // BLOCK 12.4: `FLAG_IMMUTABLE` es obligatorio con targetSdk >= 31 y sin el
        // esto es un crash, no un warning. La regla vive en `resolveAlarmPendingIntentFlag`
        // para poder testearla sin dispositivo.
        val pendingIntent = android.app.PendingIntent.getBroadcast(
            context,
            requestCodeFor(label),
            intent,
            resolveAlarmPendingIntentFlag(
                currentSdkInt = Build.VERSION.SDK_INT,
                baseFlag = android.app.PendingIntent.FLAG_UPDATE_CURRENT
            )
        )
        return try {
            if (repeatDaily) {
                alarmManager.setInexactRepeating(
                    AlarmManager.RTC_WAKEUP,
                    triggerAt.timeInMillis,
                    AlarmManager.INTERVAL_DAY,
                    pendingIntent
                )
            } else {
                alarmManager.setExact(AlarmManager.RTC_WAKEUP, triggerAt.timeInMillis, pendingIntent)
            }
            true
        } catch (deniedBySystem: SecurityException) {
            false
        }
    }

    override fun cancelAlarm(label: String): Boolean {
        val intent = Intent(context, AlarmBroadcast::class.java).apply {
            action = ACTION_ALARM
            putExtra(EXTRA_ALARM_LABEL, label)
        }
        // Mismo flag que al programar: la mutabilidad es una propiedad del
        // PendingIntent, y `cancel` tambien lanza IllegalArgumentException con
        // targetSdk >= 31 si falta.
        val pendingIntent = android.app.PendingIntent.getBroadcast(
            context,
            requestCodeFor(label),
            intent,
            resolveAlarmPendingIntentFlag(
                currentSdkInt = Build.VERSION.SDK_INT,
                baseFlag = android.app.PendingIntent.FLAG_NO_CREATE
            )
        )
        if (pendingIntent == null) {
            return false
        }
        alarmManager.cancel(pendingIntent)
        pendingIntent.cancel()
        return true
    }

    /**
     * El telefono no resuelve una query de texto a una URL: eso es del backend y
     * no existe todavia. Lo honesto es_NO_ fingir que se reprodujo: el peer
     * reproduce cuando la query YA es una URI jugable y devuelve `Unresolvable`
     * cuando no lo es, que es un fallo que Apollo puede distinguir de un error
     * real del player.
     */
    override fun createCalendarEvent(
        title: String,
        startsAt: String,
        location: String
    ): Boolean = calendarGateway.createEvent(title = title, startsAt = startsAt, location = location)

    override fun cancelCalendarEvent(title: String): Boolean =
        calendarGateway.deleteEventByTitle(title)

    override fun listCalendarEvents(withinDays: Int): List<CalendarEventSummary> =
        calendarGateway.listEvents(withinDays)

    override fun playMedia(query: String): MediaPlayOutcome {
        val playableUri = parsePlayableUri(query) ?: return MediaPlayOutcome.Unresolvable
        return try {
            mediaPlayer?.release()
            val nextPlayer = MediaPlayer()
            nextPlayer.setDataSource(context, playableUri)
            nextPlayer.setOnPreparedListener { preparedPlayer -> preparedPlayer.start() }
            nextPlayer.setOnErrorListener { failedPlayer, _, _ ->
                failedPlayer.release()
                if (mediaPlayer === failedPlayer) {
                    mediaPlayer = null
                }
                true
            }
            nextPlayer.prepareAsync()
            mediaPlayer = nextPlayer
            MediaPlayOutcome.Started
        } catch (rejectedByPlayer: Exception) {
            MediaPlayOutcome.Failed
        }
    }

    override fun pauseMedia(): Boolean {
        val player = mediaPlayer ?: return false
        return try {
            if (player.isPlaying) {
                player.pause()
            }
            true
        } catch (notPrepared: IllegalStateException) {
            false
        }
    }

    override fun nextMedia(): Boolean = seekMediaBy(MEDIA_SKIP_SECONDS)

    override fun previousMedia(): Boolean = seekMediaBy(-MEDIA_SKIP_SECONDS)

    override fun setVolume(level: Int): Boolean {
        val clampedLevel = level.coerceIn(0, 100)
        return try {
            audioManager.setStreamVolume(
                AudioManager.STREAM_MUSIC,
                (clampedLevel * audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)) / 100,
                0
            )
            true
        } catch (deniedBySystem: SecurityException) {
            false
        }
    }

    override fun getVolumeLevel(): Int? {
        val maximumLevel = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        if (maximumLevel <= 0) {
            return null
        }
        val currentLevel = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
        return (currentLevel * 100) / maximumLevel
    }

    override fun openApp(appName: String): Boolean {
        val launchIntent = context.packageManager
            .getLaunchIntentForPackage(appName)
            ?: return false
        return try {
            context.startActivity(launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (noLauncher: android.content.ActivityNotFoundException) {
            false
        }
    }

    private fun seekMediaBy(offsetSeconds: Int): Boolean {
        val player = mediaPlayer ?: return false
        return try {
            player.seekTo(player.currentPosition + offsetSeconds * 1000)
            true
        } catch (notPrepared: IllegalStateException) {
            false
        }
    }

    /** http(s), content y file son lo que `MediaPlayer` puede abrir sin permisos raros. */
    private fun parsePlayableUri(query: String): Uri? {
        val trimmedQuery = query.trim()
        if (trimmedQuery.isEmpty()) {
            return null
        }
        val parsedUri = Uri.parse(trimmedQuery)
        val parsedScheme = parsedUri.scheme ?: return null
        return if (parsedScheme in PLAYABLE_SCHEME_SET) parsedUri else null
    }

    /** La alarma la programa `setAlarm`, asi que el parseo vive en la plataforma. */
    private fun parseHourMinute(hourMinute: String): Pair<Int, Int>? {
        val parts = hourMinute.split(":")
        if (parts.size != 2) {
            return null
        }
        val hour = parts[0].toIntOrNull() ?: return null
        val minute = parts[1].toIntOrNull() ?: return null
        if (hour !in 0..23 || minute !in 0..59) {
            return null
        }
        return hour to minute
    }

    private fun requestCodeFor(label: String): Int = label.hashCode()

    companion object {
        const val ACTION_ALARM = "com.apollo.mobile.ALARM"
        const val EXTRA_ALARM_LABEL = "alarm_label"
        const val MEDIA_SKIP_SECONDS = 10
        private const val ISO_LOCAL_DATE_TIME_PATTERN = "yyyy-MM-dd'T'HH:mm:ss"
        private val PLAYABLE_SCHEME_SET = setOf("http", "https", "content", "file")
    }
}

/** Receptor de la alarma: la dispara el sistema cuando llega el momento. */
class AlarmBroadcast : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val label = intent.getStringExtra(AndroidMobilePlatform.EXTRA_ALARM_LABEL) ?: "Alarma"
        val adapter = AndroidNotificationAdapter(context)
        if (adapter.requestPermission() !is PermissionOutcome.Granted) {
            return
        }
        adapter.post(label, "Alarma de Apollo")
    }
}
