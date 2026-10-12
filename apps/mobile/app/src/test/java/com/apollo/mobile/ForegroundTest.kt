package com.apollo.mobile

import com.apollo.mobile.session.MobileSessionState
import com.apollo.mobile.session.shouldForegroundServiceKeepRunning
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BLOCK 12.5.2: cuando vive y cuando muere el foreground service.
 *
 * La decision es una funcion pura porque el Service de Android no se puede
 * instanciar en un test unitario. Lo que se fija aca es la POLITICA: el service
 * acompana la intencion de estar conectado y se apaga cuando la sesion termina,
 * para no quedar como un "siempre conectado" falso con notificacion persistente
 * y el telefono desconectado.
 */
class ForegroundTest {

    @Test
    fun keepsRunningWhileTheSessionIsAliveOrReconnecting() {
        // Los cuatro estados en los que hay una sesion que merece el proceso.
        for (state in listOf(
            MobileSessionState.CONNECTING,
            MobileSessionState.AUTHENTICATED,
            MobileSessionState.ONLINE,
            MobileSessionState.RECONNECTING
        )) {
            assertTrue(
                "con la sesion en $state el service debe sostener el proceso",
                shouldForegroundServiceKeepRunning(state)
            )
        }
    }

    @Test
    fun stopsWhenTheSessionIsDisconnected() {
        // DISCONNECTED llega por revocacion (1008), por hello rechazado o por
        // stop(). En los tres casos no hay nada que sostener: dejar la
        // notificacion persistente con el telefono desconectado seria mentir.
        assertFalse(shouldForegroundServiceKeepRunning(MobileSessionState.DISCONNECTED))
    }

    @Test
    fun reconnectingKeepsTheServiceAliveEvenThoughTheSocketIsDown() {
        // El caso por el que el service existe: el socket se cayo, el backoff
        // esta corriendo, y matar el proceso ahi seria abortar la reconexion
        // que 12.5.1 construyo. Este test es el que impide "optimizar" eso.
        assertTrue(shouldForegroundServiceKeepRunning(MobileSessionState.RECONNECTING))
    }
}
