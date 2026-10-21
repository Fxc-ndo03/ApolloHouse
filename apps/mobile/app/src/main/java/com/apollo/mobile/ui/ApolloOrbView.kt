package com.apollo.mobile.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View

/**
 * Orbe de Apollo para movil: la misma idea que el orbe de escritorio (un nucleo
 * con degradado cian/turquesa) con una animacion que Android puede sostener sin
 * trabajo por frame en el hilo principal.
 *
 * No es un video ni una superficie: son un circulo, dos aros y un pulso de
 * escala. Es lo que mantiene la identidad visual del asistente sin introducir
 * un motor de animacion ni trabajo de IA local.
 */
class ApolloOrbView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private val corePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)

    private var phase = 0f
    private var running = false

    init {
        ringPaint.strokeWidth = 2f * resources.displayMetrics.density
        setLayerType(LAYER_TYPE_HARDWARE, null)
    }

    fun start() {
        if (running) return
        running = true
        postInvalidateOnAnimation()
    }

    fun stop() {
        running = false
    }

    override fun onDetachedFromWindow() {
        running = false
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cx = width / 2f
        val cy = height / 2f
        val radius = (minOf(width, height) / 2f) * 0.42f
        val accent = ApolloColors.accent(context)

        // Nucleo con degradado, igual que el escritorio.
        corePaint.shader = LinearGradient(
            cx, cy - radius,
            cx, cy + radius,
            intArrayOf(accent, blend(accent, Color.BLACK, 0.55f)),
            null,
            Shader.TileMode.CLAMP,
        )
        canvas.drawCircle(cx, cy, radius, corePaint)

        // Halo exterior.
        glowPaint.color = withAlpha(accent, 40)
        canvas.drawCircle(cx, cy, radius * 1.22f, glowPaint)

        // Anillo punteado que gira: el equivalente del anillo del orbe desktop.
        ringPaint.color = withAlpha(accent, 150)
        val ringRadius = radius * 1.45f
        val dotCount = 28
        val offset = phase % (2f * Math.PI.toFloat())
        for (i in 0 until dotCount) {
            val angle = offset + i * (2f * Math.PI.toFloat() / dotCount)
            val x = cx + ringRadius * kotlin.math.cos(angle)
            val y = cy + ringRadius * kotlin.math.sin(angle)
            canvas.drawCircle(x, y, 2.2f * resources.displayMetrics.density, ringPaint)
        }

        if (running) {
            phase += 0.05f
            postInvalidateOnAnimation()
        }
    }

    private fun blend(a: Int, b: Int, ratio: Float): Int {
        val inverse = 1f - ratio
        return Color.argb(
            (Color.alpha(a) * inverse + Color.alpha(b) * ratio).toInt(),
            (Color.red(a) * inverse + Color.red(b) * ratio).toInt(),
            (Color.green(a) * inverse + Color.green(b) * ratio).toInt(),
            (Color.blue(a) * inverse + Color.blue(b) * ratio).toInt(),
        )
    }

    private fun withAlpha(color: Int, alpha: Int): Int =
        Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color))
}
