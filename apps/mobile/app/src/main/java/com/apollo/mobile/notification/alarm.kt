package com.apollo.mobile.notification

import android.app.PendingIntent

/**
 * Los flags del `PendingIntent` de la alarma, como funcion pura.
 *
 * Existe separada del `AndroidMobilePlatform` por una razon concreta: la regla
 * que decide si hace falta `FLAG_IMMUTABLE` no se puede ejercitar en un test
 * unitario sin dispositivo, porque `PendingIntent.getBroadcast` es una llamada al
 * framework. La decision, en cambio, es aritmetica sobre el nivel de API, y eso
 * si se prueba de punta a punta.
 *
 * Por que `IMMUTABLE` y no `MUTABLE`:
 *
 * - Android 12 (API 31) exige declarar la mutabilidad de TODO `PendingIntent`.
 *   Sin el flag, `PendingIntent.getBroadcast` lanza `IllegalArgumentException`
 *   ("Targeting S+ requires that one of FLAG_IMMUTABLE or FLAG_MUTABLE"), y con
 *   targetSdk >= 31 eso es un crash, no un warning.
 * - La guia de Google dice usar `IMMUTABLE` salvo que algo NECESITE que otro
 *   proceso llene los extras. Aca el `Intent` lo arma la propia app: clase
 *   destino, action y label salen de acá. No hay ningun actor externo que
 *   complete el Intent, asi que `MUTABLE` no aporta nada y solo abriria la
 *   puerta a que otro app modifique una alarma que ya fue programada.
 * - `FLAG_IMMUTABLE` existe desde API 23. Por eso el corte es 23 y no 31: en
 *   API 25..30 el flag no es obligatorio pero si es correcto, y aplicarlo siempre
 *   desde 23 deja un solo camino de codigo en vez de dos.
 */
fun resolveAlarmPendingIntentFlag(currentSdkInt: Int, baseFlag: Int): Int =
    if (currentSdkInt >= FLAG_IMMUTABLE_MINIMUM_API) {
        baseFlag or PendingIntent.FLAG_IMMUTABLE
    } else {
        baseFlag
    }

/**
 * API 23 (Marshmallow) es donde aparece `FLAG_IMMUTABLE`. En 31 (Android 12) deja
 * de ser opcional, pero aplicarlo desde 23 cubre los dos tramos.
 */
const val FLAG_IMMUTABLE_MINIMUM_API = 23
