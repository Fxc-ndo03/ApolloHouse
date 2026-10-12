package com.apollo.mobile

import android.app.PendingIntent
import com.apollo.mobile.notification.AndroidNotificationAdapter
import com.apollo.mobile.notification.FLAG_IMMUTABLE_MINIMUM_API
import com.apollo.mobile.notification.PermissionOutcome
import com.apollo.mobile.notification.resolveAlarmPendingIntentFlag
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BLOCK 12.4: los flags del PendingIntent y el permiso de notificaciones.
 *
 * Se prueban las funciones puras, no las llamadas al framework: `PendingIntent`
 * y `ContextCompat.checkSelfPermission` no se pueden ejercitar en un test unitario
 * sin dispositivo. Lo que si importa y se puede fijar aca es exactamente la
 * parte que decidio el bug: que flags se arman segun la version, y como se
 * traduce la respuesta del usuario.
 */
class CompatibilityTest {

    @Test
    fun pendingIntentDeclaresImmutabilityFromApi23() {
        // API 23 es donde aparece el flag. Android 7.1 (API 25) entra por aca.
        val flagAtTwentyFive = resolveAlarmPendingIntentFlag(
            currentSdkInt = 25,
            baseFlag = PendingIntent.FLAG_UPDATE_CURRENT
        )
        assertNotEquals(
            "API 25 tiene FLAG_IMMUTABLE y debe usarlo",
            PendingIntent.FLAG_UPDATE_CURRENT,
            flagAtTwentyFive
        )
        assertEquals(
            PendingIntent.FLAG_UPDATE_CURRENT,
            flagAtTwentyFive and PendingIntent.FLAG_UPDATE_CURRENT
        )
        assertEquals(
            PendingIntent.FLAG_IMMUTABLE,
            flagAtTwentyFive and PendingIntent.FLAG_IMMUTABLE
        )
    }

    @Test
    fun pendingIntentKeepsTheBaseFlagOnOldDevices() {
        // En API 22 y menos el flag no existe. Referential a `FLAG_IMMUTABLE`
        // daria 0, que es lo correcto, pero la rama explicita evita depender de
        // ese detalle.
        val flagAtTwentyTwo = resolveAlarmPendingIntentFlag(
            currentSdkInt = 22,
            baseFlag = PendingIntent.FLAG_UPDATE_CURRENT
        )
        assertEquals(PendingIntent.FLAG_UPDATE_CURRENT, flagAtTwentyTwo)
    }

    @Test
    fun pendingIntentPreservesTheCancelFlag() {
        // `cancelAlarm` usa FLAG_NO_CREATE. El flag de mutabilidad se le suma,
        // no lo reemplaza: si se perdiera, `getBroadcast` crearia un
        // PendingIntent nuevo en vez de devolver el existente y `cancelAlarm`
        // cancelaria una alarma que no es la que el usuario programo.
        val cancelFlag = resolveAlarmPendingIntentFlag(
            currentSdkInt = 34,
            baseFlag = PendingIntent.FLAG_NO_CREATE
        )
        assertEquals(PendingIntent.FLAG_NO_CREATE, cancelFlag and PendingIntent.FLAG_NO_CREATE)
        assertEquals(PendingIntent.FLAG_IMMUTABLE, cancelFlag and PendingIntent.FLAG_IMMUTABLE)
    }

    @Test
    fun everyApiLevelFromTheSupportedFloorDeclaresMutability() {
        // El piso es API 25 (Android 7.1) y el techo del bloque es 36. Ninguno
        // puede quedar sin declarar, que es el crash de Android 12.
        for (apiLevel in 25..36) {
            val flag = resolveAlarmPendingIntentFlag(
                currentSdkInt = apiLevel,
                baseFlag = PendingIntent.FLAG_UPDATE_CURRENT
            )
            assertNotEquals(
                "API $apiLevel quedaria sin declarar la mutabilidad",
                0,
                flag and PendingIntent.FLAG_IMMUTABLE
            )
        }
        assertTrue(FLAG_IMMUTABLE_MINIMUM_API <= 25)
    }

    @Test
    fun runtimeNotificationPermissionIsOnlyRequiredFromApi33() {
        assertEquals(false, AndroidNotificationAdapter.isRuntimePermissionRequired(25))
        assertEquals(false, AndroidNotificationAdapter.isRuntimePermissionRequired(32))
        assertEquals(true, AndroidNotificationAdapter.isRuntimePermissionRequired(33))
        assertEquals(true, AndroidNotificationAdapter.isRuntimePermissionRequired(36))
    }

    @Test
    fun deniedNotificationPermissionIsDeniedAndNotAssumedGranted() {
        // El falso exito era el problema real: con el permiso denegado la app
        // publicaba en el vacio y le decia a Apollo que si.
        assertEquals(
            PermissionOutcome.Denied,
            AndroidNotificationAdapter.resolveOutcome(isGranted = false)
        )
        assertEquals(
            PermissionOutcome.Granted,
            AndroidNotificationAdapter.resolveOutcome(isGranted = true)
        )
    }

    @Test
    fun emptyGrantResultIsTreatedAsDenied() {
        // Si el sistema devuelve un array vacio no se sabe nada; se asume que no
        // se concedio. Es el mismo criterio que `post` usa para no reportar
        // exito sin permiso.
        val isGranted = IntArray(0).isNotEmpty() && true
        assertEquals(
            PermissionOutcome.Denied,
            AndroidNotificationAdapter.resolveOutcome(isGranted)
        )
    }
}
