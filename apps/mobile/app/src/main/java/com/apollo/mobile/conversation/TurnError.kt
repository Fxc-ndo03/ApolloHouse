package com.apollo.mobile.conversation

/**
 * Traduccion de los errores de TURNO que manda el Worker a un texto que dice
 * que paso y que se puede hacer.
 *
 * El Worker manda `code` + `message`, y el mensaje puede traer la clave interna
 * del limite (`requestsPerMinute`), que no le sirve a la persona. Ademas un
 * rechazo por cuota NO es una caida de la conexion: el socket sigue vivo y el
 * turno siguiente funciona, asi que no debe marcarse como error de red.
 */
data class TurnErrorNotice(
    val category: Category,
    val title: String,
    val detail: String,
    val isConnectionFailure: Boolean,
) {
    enum class Category {
        QUOTA_PER_MINUTE,
        QUOTA_EXHAUSTED,
        NOT_AUTHENTICATED,
        NOT_AUTHORIZED,
BILLING,
        PROVIDER_ALLOCATION,
        PROVIDER_UNAVAILABLE,
        PROVIDER,
        NETWORK,
        UNKNOWN,
    }

    val text: String get() = "$title: $detail"
}

object TurnError {

    private const val CATEGORY_QUOTA_PER_MINUTE = "requestsperminute"

    /**
     * FASE 3.19: `rate_limited` ya NO es una cuota de producto. El Worker lo
     * emite cuando la barrera antiinundacion frena trafico automatizado. Debe
     * decir eso, o la persona cree que se le termino la cuota.
     */
    fun describeFloodBlock(): TurnErrorNotice = TurnErrorNotice(
        category = TurnErrorNotice.Category.QUOTA_PER_MINUTE,
        title = "Esperá un momento",
        detail = "Demasiadas peticiones seguidas. Esperá un segundo y seguí; " +
            "no se te terminó la cuota.",
        isConnectionFailure = false,
    )

    fun describe(code: String?, message: String?): TurnErrorNotice {
        val normalizedMessage = (message ?: "").lowercase()
        val normalizedCode = (code ?: "").lowercase()

        if (normalizedCode == "rate_limited") {
            return describeFloodBlock()
        }

        if (normalizedMessage.contains(CATEGORY_QUOTA_PER_MINUTE) ||
            normalizedMessage.contains("requests_per_minute")
        ) {
            return TurnErrorNotice(
                category = TurnErrorNotice.Category.QUOTA_PER_MINUTE,
                title = "Esperá un momento",
                detail = "Se alcanzó el máximo de turnos por minuto de este entorno. " +
                    "Esperá a que se libere el intervalo de 60 segundos y volvé a intentar.",
                isConnectionFailure = false,
            )
        }

        if (normalizedMessage.contains("límite de uso alcanzado") ||
            normalizedMessage.contains("limite de uso alcanzado")
        ) {
            return TurnErrorNotice(
                category = TurnErrorNotice.Category.QUOTA_EXHAUSTED,
                title = "Límite de uso alcanzado",
                detail = "Este entorno tiene un límite de consumo configurado y se agotó. " +
                    "No es un problema de tu conexión.",
                isConnectionFailure = false,
            )
        }

        // FASE 3.22: la asignacion diaria del PROVEEDOR no es cuota de Apollo.
        // El mensaje real de Cloudflare no dice "quota": dice
        // "4006: you have used up your daily free allocation of 10,000 neurons".
        if (normalizedMessage.contains("4006") ||
            normalizedMessage.contains("asignación diaria") ||
            normalizedMessage.contains("neurons")
        ) {
            return TurnErrorNotice(
                category = TurnErrorNotice.Category.PROVIDER_ALLOCATION,
                title = "Se agotó la cuota diaria del proveedor",
                detail = "Cloudflare Workers AI agotó su asignación diaria gratuita. " +
                    "Vuelve mañana o amplía el plan de Cloudflare. Tu cuota de Apollo no es el problema.",
                isConnectionFailure = false,
            )
        }

        if (normalizedMessage.contains("workers_ai_llm_model") ||
            normalizedMessage.contains("no such model") ||
            normalizedMessage.contains("no está disponible") ||
            normalizedMessage.contains("no esta disponible")
        ) {
            return TurnErrorNotice(
                category = TurnErrorNotice.Category.PROVIDER_UNAVAILABLE,
                title = "El modelo de IA no está disponible",
                detail = "Cloudflare no tiene disponible el modelo configurado. " +
                    "No es un problema de tu conexión.",
                isConnectionFailure = false,
            )
        }

        if (normalizedCode == "payment_required" || normalizedCode == "billing") {
            return TurnErrorNotice(
                category = TurnErrorNotice.Category.BILLING,
                title = "Cuenta sin crédito",
                detail = "El proveedor rechazó la petición por facturación.",
                isConnectionFailure = false,
            )
        }

        if (normalizedCode.contains("network") || normalizedMessage.contains("network") ||
            normalizedCode.contains("timeout")
        ) {
            return TurnErrorNotice(
                category = TurnErrorNotice.Category.NETWORK,
                title = "Sin conexión",
                detail = "No se pudo contactar al servicio.",
                isConnectionFailure = true,
            )
        }

        val fallback = message?.trim().orEmpty().ifEmpty { code?.trim().orEmpty() }
        return TurnErrorNotice(
            category = TurnErrorNotice.Category.UNKNOWN,
            title = "Algo salió mal",
            detail = fallback.ifEmpty { "El servicio devolvió un error sin detalle." },
            isConnectionFailure = false,
        )
    }
}
