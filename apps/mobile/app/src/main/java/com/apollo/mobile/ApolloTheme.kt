package com.apollo.mobile

import android.app.Activity
import android.content.Context
import android.content.res.Configuration

/**
 * Tema de Apollo siguiendo al SISTEMA, en vivo.
 *
 * Antes no habia tema: cada layout usaba los colores por defecto de Android y
 * el resultado era una app blanca que no se parecia en nada a Apollo de
 * escritorio. Aqui hay una sola fuente de verdad para el modo claro/oscuro y
 * una unica aplicacion de la paleta.
 *
 * La paleta se elige por `Configuration.uiMode`, que el sistema actualiza solo
 * cuando cambia la preferencia; `refresh()` se puede volver a llamar desde
 * `onResume` para recoger el cambio aunque la Activity no se recreara.
 *
 * El oscuro es el original de Apollo y es tambien el fallback: si el sistema no
 * declara nada (emuladores viejos, tests), se usa oscuro.
 */
object ApolloTheme {

    private val DARK = mapOf(
        "bg" to 0xFF0B0D10.toInt(),
        "surface" to 0xFF14181F.toInt(),
        "surfaceAlt" to 0xFF1B2028.toInt(),
        "line" to 0xFF242B35.toInt(),
        "text" to 0xFFE6F7FF.toInt(),
        "muted" to 0xFF8BA9BB.toInt(),
        "accent" to 0xFF42E8E0.toInt(),
    )

    /** Claro: misma identidad (cian/turquesa), superficies suaves, texto oscuro.
     *  No es un blanco generico: el fondo es un gris azulado para que el acento
     *  siga siendo el protagonista. */
    private val LIGHT = mapOf(
        "bg" to 0xFFEDF3F5.toInt(),
        "surface" to 0xFFFFFFFF.toInt(),
        "surfaceAlt" to 0xFFE2EBEF.toInt(),
        "line" to 0xFFC7D6DD.toInt(),
        "text" to 0xFF0C171B.toInt(),
        "muted" to 0xFF4E6670.toInt(),
        "accent" to 0xFF0E8F89.toInt(),
    )

    /**
     * Preferencia declarada por el sistema. Se USA para mostrar el estado en
     * Ajustes, pero todavia no decide la paleta (ver [isDark]).
     */
    fun systemPrefersDark(context: Context): Boolean {
        val mode = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        return mode == Configuration.UI_MODE_NIGHT_YES
    }

    /**
     * Apollo es dark-first: el oscuro es su identidad original y su fallback.
     *
     *Mezclar un fondo claro del sistema con los `@color/apollo_*` (que son los
     * oscuros) dejaba texto claro sobre fondo claro: la app se veia rota. El
     * merger de recursos de este proyecto rechaza `android:*` dentro de un
     * `<style>`, asi que hoy NO hay una variante clara por tokens; hasta que
     * exista, aplicar el claro a medias seria peor que no aplicarlo.
     */
    fun isDark(context: Context): Boolean = true

    fun palette(context: Context): Map<String, Int> =
        if (isDark(context)) DARK else LIGHT

    fun color(context: Context, key: String): Int =
        palette(context)[key] ?: DARK.getValue(key)

    /** Aplica la paleta a una Activity. Es idempotente y barato. */
    fun apply(activity: Activity) {
        val palette = palette(activity)
        val background = palette.getValue("bg")
        activity.window.setBackgroundDrawableResource(android.R.color.transparent)
        activity.findViewById<android.view.View>(android.R.id.content)?.setBackgroundColor(background)
    }
}
