package com.apollo.mobile.transport

/**
 * BLOCK 12 §1: con que identidad se abre el socket.
 *
 * Dos formas, y no se mezclan:
 *
 *   Enrolled  Credencial individual de ESTE telefono. Va en el header
 *             `Authorization: Bearer`, nunca en la URL: un `?token=` aparece en
 *             access logs, en diagnosticos y en cualquier log de URL.
 *
 *   Legacy    El DEVICE_SHARED_SECRET global, por `?token=`. Es lo que usan
 *             Desktop y los telefonos que todavia no se enrolaron, y es el
 *             unico camino que el servidor acepta para un deviceId desconocido.
 *
 * Que sea un sealed class y no dos strings es lo que impide el error de mandar
 * la credencial individual como si fuera el secreto global, o al reves.
 */
sealed class DeviceCredential {

    /** Credencial individual emitida por enrollment. */
    data class Enrolled(val credential: String) : DeviceCredential()

    /** El secreto global, para Desktop y telefonos legacy. */
    data class LegacySharedSecret(val sharedSecret: String) : DeviceCredential()

    companion object {

        /**
         * Elige la credencial segun lo que hay guardado, con la regla que exige
         * §1: una credencial enrolada gana siempre, y NUNCA se degrada al
         * secreto global. Degradarse seria el bypass: un telefono revocado
         * podria volver por `?token=` si el cliente le dejara hacerlo.
         */
        fun resolve(
            enrolledCredential: String?,
            legacySharedSecret: String?
        ): DeviceCredential? {
            val resolvedEnrolledCredential = enrolledCredential?.takeIf { it.isNotBlank() }
            if (resolvedEnrolledCredential != null) {
                return Enrolled(resolvedEnrolledCredential)
            }
            val resolvedSharedSecret = legacySharedSecret?.takeIf { it.isNotBlank() }
            if (resolvedSharedSecret != null) {
                return LegacySharedSecret(resolvedSharedSecret)
            }
            return null
        }
    }
}
