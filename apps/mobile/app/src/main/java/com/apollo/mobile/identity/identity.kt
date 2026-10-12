package com.apollo.mobile.identity

import com.apollo.mobile.contract.Contract
import java.util.UUID

/** Resolucion del deviceId estable `mobile:<id>`. */
object DeviceIdentity {

    /**
     * No hay hostname en Android y no se puede regenerar en cada arranque: el id
     * vive en el almacenamiento de la plataforma y el mismo telefono vuelve con
     * el mismo deviceId.
     */
    fun buildStableDeviceId(storedValue: String?): String {
        val existingValue = storedValue?.trim().orEmpty()
        if (isValidDeviceId(existingValue)) {
            return existingValue
        }
        return Contract.DEVICE_ID_PREFIX + UUID.randomUUID().toString()
    }

    fun isValidDeviceId(candidateDeviceId: String): Boolean {
        if (candidateDeviceId.length < 3 || candidateDeviceId.length > 128) {
            return false
        }
        if (!candidateDeviceId.startsWith(Contract.DEVICE_ID_PREFIX)) {
            return false
        }
        return candidateDeviceId
            .removePrefix(Contract.DEVICE_ID_PREFIX)
            .trim()
            .isNotEmpty()
    }
}
