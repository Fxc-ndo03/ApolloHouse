package com.apollo.mobile

import com.apollo.mobile.contract.Contract
import com.apollo.mobile.identity.DeviceIdentity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Test 1: identidad estable `mobile:<id>`. */
class IdentityTest {

    @Test
    fun generatesAStructuredMobileDeviceId() {
        val generatedDeviceId = DeviceIdentity.buildStableDeviceId(null)
        assertTrue(generatedDeviceId.startsWith(Contract.DEVICE_ID_PREFIX))
        assertTrue(DeviceIdentity.isValidDeviceId(generatedDeviceId))
    }

    @Test
    fun reusesTheSameDeviceIdOnTheNextBoot() {
        val firstBootDeviceId = DeviceIdentity.buildStableDeviceId(null)
        val secondBootDeviceId = DeviceIdentity.buildStableDeviceId(firstBootDeviceId)
        assertEquals(firstBootDeviceId, secondBootDeviceId)
    }

    @Test
    fun regeneratesWhenTheStoredValueIsNotAMobileDeviceId() {
        val regeneratedDeviceId = DeviceIdentity.buildStableDeviceId("desktop:PC-ESTUDIO")
        assertTrue(regeneratedDeviceId.startsWith(Contract.DEVICE_ID_PREFIX))
        assertFalse(DeviceIdentity.isValidDeviceId("mobile:"))
        assertFalse(DeviceIdentity.isValidDeviceId("mobile"))
        assertFalse(DeviceIdentity.isValidDeviceId("telefono"))
    }
}
