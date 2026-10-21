package com.apollo.mobile.ui

import android.content.Context
import com.apollo.mobile.ApolloTheme

/**
 * Acceso a la paleta de Apollo desde Kotlin.
 *
 * Los layouts usan `@color/apollo_*` para lo estatico; lo que cambia con el
 * tema del sistema en vivo (fondo de pantallas, color de texto, burbujas) se
 * resuelve aqui para que el cambio se vea sin recrear la Activity.
 */
object ApolloColors {
    fun background(context: Context): Int = ApolloTheme.color(context, "bg")
    fun surface(context: Context): Int = ApolloTheme.color(context, "surface")
    fun surfaceAlt(context: Context): Int = ApolloTheme.color(context, "surfaceAlt")
    fun line(context: Context): Int = ApolloTheme.color(context, "line")
    fun text(context: Context): Int = ApolloTheme.color(context, "text")
    fun muted(context: Context): Int = ApolloTheme.color(context, "muted")
    fun accent(context: Context): Int = ApolloTheme.color(context, "accent")

    fun isDark(context: Context): Boolean = ApolloTheme.isDark(context)
}
