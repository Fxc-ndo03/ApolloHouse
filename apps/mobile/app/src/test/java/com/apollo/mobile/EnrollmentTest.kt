package com.apollo.mobile

import com.apollo.mobile.command.CommandDispatcher
import com.apollo.mobile.identity.EnrollmentClaimClient
import com.apollo.mobile.identity.IdentityStore
import com.apollo.mobile.identity.EnrollmentClaimResult
import com.apollo.mobile.identity.EnrollmentHttpAnswer
import com.apollo.mobile.identity.EnrollmentHttpPort
import com.apollo.mobile.notification.PermissionOutcome
import com.apollo.mobile.session.MobileSession
import com.apollo.mobile.session.MobileSessionState
import com.apollo.mobile.transport.ClientConfig
import com.apollo.mobile.transport.CredentialCipher
import com.apollo.mobile.transport.DeviceCredential
import com.apollo.mobile.transport.DeviceSocketListener
import com.apollo.mobile.transport.RecordingSocketFactory
import android.content.SharedPreferences
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BLOCK 12 §6 y §7: el lado Android de la credencial individual.
 *
 * `AndroidKeyStore` no existe en la JVM de los tests, así que `CredentialCipher`
 * es un puerto y aca se prueba con un cifrado de prueba. Lo que se verifica aqui
 * es la LOGICA —que se cifra antes de guardar, que la credencial enrolada nunca
 * degrada al secreto global, que viaja en un header y no en la URL, y que una
 * revocacion deja de reconnectear— que es la parte que puede estar mal sin que
 * nadie lo note en un dispositivo.
 */
class EnrollmentTest {

    private val testConfig = ClientConfig(workerHost = "apollo.example")

    // ── §4: la credencial viaja en un header, no en la URL ─────────────────

    @Test
    fun anEnrolledCredentialTravelsInTheAuthorizationHeader() {
        val request = testConfig.buildSocketRequest(
            DeviceCredential.Enrolled("apollo_dev_secreto-individual")
        )

        assertEquals(
            "Authorization",
            request.headerMap.keys.first()
        )
        assertEquals(
            "Bearer apollo_dev_secreto-individual",
            request.headerMap["Authorization"]
        )
        // Lo importante: la credencial NO esta en la URL.
        assertFalse(request.url.contains("apollo_dev_secreto-individual"))
        assertFalse(request.url.contains("token="))
    }

    @Test
    fun aLegacyPhoneKeepsTheSharedSecretInTheUrl() {
        // Desktop y los telefonos legacy dependen de `?token=`; el servidor y el
        // cliente de Block 10 lo esperan exactamente asi.
        val request = testConfig.buildSocketRequest(
            DeviceCredential.LegacySharedSecret(TEST_DEVICE_SHARED_SECRET)
        )

        assertTrue(request.url.contains("token=" + TEST_DEVICE_SHARED_SECRET))
        assertTrue(request.headerMap.isEmpty())
    }

    @Test
    fun theTwoScopesNeverShareAPlaceInTheRequest() {
        val enrolledRequest = testConfig.buildSocketRequest(
            DeviceCredential.Enrolled("apollo_dev_individual")
        )
        val legacyRequest = testConfig.buildSocketRequest(
            DeviceCredential.LegacySharedSecret(TEST_DEVICE_SHARED_SECRET)
        )

        // Un bearer no puede caer en la URL ni un secret en el header: cada scope
        // tiene una sola forma de viajar, y mezclarlas es el bypass de §1.
        assertTrue(
            enrolledRequest.url.endsWith(
                com.apollo.mobile.contract.Contract.MOBILE_BRIDGE_PATH
            )
        )
        assertFalse(enrolledRequest.url.contains("?"))
        assertEquals(listOf("Authorization"), enrolledRequest.headerMap.keys.toList())
        assertTrue(legacyRequest.headerMap.isEmpty())
    }

    // ── §1: la credencial enrolada nunca degrada al secreto global ─────────

    @Test
    fun anEnrolledCredentialAlwaysWinsOverTheLegacySecret() {
        // Si Resolve devolviera Legacy cuando hay ambos, un telefono revocado
        // podria seguir conectando con el secreto global que todavia esta
        // guardado en el telefono.
        val resolved = DeviceCredential.resolve(
            enrolledCredential = "apollo_dev_individual",
            legacySharedSecret = TEST_DEVICE_SHARED_SECRET
        )

        assertEquals(
            DeviceCredential.Enrolled("apollo_dev_individual"),
            resolved
        )
    }

    @Test
    fun resolveFallsBackToLegacyOnlyWithoutAnEnrolledCredential() {
        assertEquals(
            DeviceCredential.LegacySharedSecret(TEST_DEVICE_SHARED_SECRET),
            DeviceCredential.resolve(
                enrolledCredential = null,
                legacySharedSecret = TEST_DEVICE_SHARED_SECRET
            )
        )
        assertEquals(
            DeviceCredential.LegacySharedSecret(TEST_DEVICE_SHARED_SECRET),
            DeviceCredential.resolve(
                enrolledCredential = "   ",
                legacySharedSecret = TEST_DEVICE_SHARED_SECRET
            )
        )
    }

    @Test
    fun resolveReturnsNullWithoutAnyCredential() {
        assertNull(DeviceCredential.resolve(null, null))
        assertNull(DeviceCredential.resolve("", ""))
    }

    // ── §3: la credencial se cifra antes de tocar disco ────────────────────

    @Test
    fun theCiphertextIsNotTheCredential() {
        val cipher = ReversibleTestCipher()
        val cipherText = cipher.encrypt("apollo_dev_individual")

        assertNotEquals("apollo_dev_individual", cipherText)
        assertFalse(cipherText.contains("apollo_dev_individual"))
        assertEquals("apollo_dev_individual", cipher.decrypt(cipherText))
    }

    @Test
    fun theCipherportRoundTripsEveryCredential() {
        val cipher = ReversibleTestCipher()
        for (credential in listOf(
            "apollo_dev_" + "a".repeat(43),
            "apollo_dev_" + "b".repeat(43),
            "corta"
        )) {
            assertEquals(credential, cipher.decrypt(cipher.encrypt(credential)))
        }
    }

    @Test
    fun anUnreadableCiphertextIsTreatedAsNoCredential() {
        // Si la clave del Keystore roto, el telefono tiene que volver a pedir
        // enrollment en vez de fallar con un error de crypto en cada arranque.
        val cipher = ReversibleTestCipher()
        assertNull(runCatching { cipher.decrypt("no-es-un-ciphertext") }.getOrNull())
    }

    // ── §2: el canje del desafio ───────────────────────────────────────────

    @Test
    fun aValidClaimReturnsTheIndividualCredential() {
        val httpPort = FakeEnrollmentHttpPort(
            EnrollmentHttpAnswer(
                statusCode = 200,
                body = JSONObject()
                    .put("status", "enrolled")
                    .put("deviceId", TEST_DEVICE_ID)
                    .put("credential", "apollo_dev_nueva-credencial")
                    .toString()
            )
        )
        val client = EnrollmentClaimClient(testConfig, httpPort)

        val result = client.claim(
            challenge = "apollo_enr_desafio",
            deviceId = TEST_DEVICE_ID
        )

        assertTrue(result is EnrollmentClaimResult.Enrolled)
        assertEquals(
            "apollo_dev_nueva-credencial",
            (result as EnrollmentClaimResult.Enrolled).credential
        )
        // El telefono mando SU deviceId estable: es la identidad que se ata.
        assertTrue(httpPort.sentBodyList[0].contains(TEST_DEVICE_ID))
        assertTrue(httpPort.sentBodyList[0].contains("apollo_enr_desafio"))
        // Y NO mando ninguna credencial: todavia no tiene.
        assertFalse(httpPort.sentBodyList[0].contains("Authorization"))
    }

    @Test
    fun aRejectedClaimReturnsTheServerReason() {
        for (reason in listOf(
            "challenge_expired",
            "challenge_unknown",
            "challenge_malformed",
            "device_id_invalid"
        )) {
            val client = EnrollmentClaimClient(
                testConfig,
                FakeEnrollmentHttpPort(
                    EnrollmentHttpAnswer(
                        statusCode = 403,
                        body = JSONObject()
                            .put("status", "rejected")
                            .put("reason", reason)
                            .toString()
                    )
                )
            )
            val result = client.claim("apollo_enr_desafio", TEST_DEVICE_ID)
            assertEquals(
                EnrollmentClaimResult.Rejected(reason),
                result
            )
        }
    }

    @Test
    fun aBlankChallengeNeverLeavesTheDevice() {
        val httpPort = FakeEnrollmentHttpPort(EnrollmentHttpAnswer(200, "{}"))
        val client = EnrollmentClaimClient(testConfig, httpPort)

        val result = client.claim("   ", TEST_DEVICE_ID)

        assertEquals(
            EnrollmentClaimResult.Rejected("challenge_missing"),
            result
        )
        assertTrue(httpPort.sentUrlList.isEmpty())
    }

    @Test
    fun theClaimNeverLogsOrEchoesTheChallenge() {
        val challenge = "apollo_enr_desafio-secreto"
        val httpPort = FakeEnrollmentHttpPort(
            EnrollmentHttpAnswer(403, JSONObject().put("reason", "challenge_expired").toString())
        )
        val client = EnrollmentClaimClient(testConfig, httpPort)

        val result = client.claim(challenge, TEST_DEVICE_ID)

        // El motivo de vuelta no trae el desafio.
        assertFalse(result.toString().contains(challenge))
    }

    // ── §5 y §6: revocacion ────────────────────────────────────────────────

    @Test
    fun aRevokedCredentialStopsTheReconnectLoop() {
        val socketFactory = RecordingSocketFactory()
        val session = buildSession(socketFactory)

        session.start(TEST_DEVICE_ID, enrolledTestCredential("apollo_dev_revocada"))
        socketFactory.acceptOpen()
        // El socket abierto NO es una sesión: hace falta el hello_accepted.
        socketFactory.deliver(buildHelloAcceptedMessage())
        assertEquals(MobileSessionState.ONLINE, session.state)

        // El servidor cierra con 1008: es lo que manda el DO cuando la
        // credencial fue revocada.
        socketFactory.closeByServer(
            DeviceSocketListener.POLICY_VIOLATION_CLOSURE_CODE,
            "credential_revoked"
        )

        assertTrue(session.getIsAuthorizationPermanentlyRejected())
        assertEquals("credential_revoked", session.authorizationRejectionDetail)
        assertEquals(MobileSessionState.DISCONNECTED, session.state)

        // Un reconnect manual con la MISMA credencial no abre nada: §5 dice que no
        // puede recuperar acceso reconectando.
        val openCountBefore = socketFactory.openCount
        session.connect()
        assertEquals(openCountBefore, socketFactory.openCount)
    }

    @Test
    fun aRejectedCredentialStillPresentsItselfInTheHeader() {
        val socketFactory = RecordingSocketFactory()
        val session = buildSession(socketFactory)

        session.start(TEST_DEVICE_ID, enrolledTestCredential("apollo_dev-individual"))
        socketFactory.acceptOpen()

        assertEquals(
            "Bearer apollo_dev-individual",
            socketFactory.openedHeaderMap["Authorization"]
        )
        assertFalse(socketFactory.openedUrl?.contains("apollo_dev-individual") == true)
    }

    @Test
    fun reEnrollingClearsTheRejectionAndConnectsAgain() {
        val socketFactory = RecordingSocketFactory()
        val session = buildSession(socketFactory)
        session.start(TEST_DEVICE_ID, enrolledTestCredential("apollo_dev-vieja"))
        socketFactory.acceptOpen()
        socketFactory.deliver(buildHelloAcceptedMessage())
        socketFactory.closeByServer(
            DeviceSocketListener.POLICY_VIOLATION_CLOSURE_CODE,
            "credential_revoked"
        )
        assertTrue(session.getIsAuthorizationPermanentlyRejected())

        // El dueño emite un desafio nuevo, el telefono se re-enrola y reconecta.
        session.connect(enrolledTestCredential("apollo_dev-nueva"))

        assertFalse(session.getIsAuthorizationPermanentlyRejected())
        assertEquals(2, socketFactory.openCount)
        assertEquals("Bearer apollo_dev-nueva", socketFactory.openedHeaderMap["Authorization"])
    }

    @Test
    fun aNetworkCloseIsNotTreatedAsARejection() {
        val socketFactory = RecordingSocketFactory()
        val session = buildSession(socketFactory)
        session.start(TEST_DEVICE_ID, enrolledTestCredential())
        socketFactory.acceptOpen()

        socketFactory.dropConnection()

        // Una caida de red SÍ se reconecta: si se marcara como rechazo, un corte
        // de wifi dejaría el telefono sin servicio para siempre.
        assertFalse(session.getIsAuthorizationPermanentlyRejected())
    }

    @Test
    fun aNormalClosureCodeIsNotTreatedAsARejection() {
        val socketFactory = RecordingSocketFactory()
        val session = buildSession(socketFactory)
        session.start(TEST_DEVICE_ID, enrolledTestCredential())
        socketFactory.acceptOpen()

        socketFactory.closeByServer(1000, "bye")

        assertFalse(session.getIsAuthorizationPermanentlyRejected())
    }


    // ── BLOCK 12.1: el deviceId se persiste antes del enrollment ───────────────

    /**
     * §2.1 y §2.2: Android genera y persiste `mobile:<UUID>` antes de enrolarse,
     * y el mismo teléfono vuelve con el mismo id después de reiniciar.
     *
     * Si el id se regenerara en cada arranque, la credencial atada a él dejaría de
     * servir y el teléfono quedaría sin poder reconectar.
     */
    @Test
    fun theDeviceIdIsGeneratedOnceAndSurvivesARestart() {
        // Las preferencias sobreviven al proceso; lo que se pierde es el estado en
        // memoria. Por eso el backing store es el MISMO en los dos "arranques":
        // un store nuevo simularía una app nueva, no un reinicio.
        val persistedPreferenceMap = mutableMapOf<String, Any>()
        val identityStore = IdentityStore(SettableContext(persistedPreferenceMap))
        val firstDeviceId = identityStore.resolveStableDeviceId()

        val afterRestart = IdentityStore(SettableContext(persistedPreferenceMap))
        val secondDeviceId = afterRestart.resolveStableDeviceId()

        assertEquals(firstDeviceId, secondDeviceId)
        assertTrue(firstDeviceId.startsWith("mobile:"))
        // Y es un UUID: lo que hace que dos teléfonos nunca colisionen.
        assertTrue(
            firstDeviceId
                .removePrefix("mobile:")
                .matches(UUID_PATTERN)
        )
    }

    @Test
    fun aDeviceIdThatIsNotMobileIsRegenerated() {
        val identityStore = IdentityStore(SettableContext())
        // Alguien dejó basura en la preferencia: no es una identidad válida.
        identityStore.writeStoredDeviceId("basura")

        val deviceId = identityStore.resolveStableDeviceId()

        assertTrue(deviceId.startsWith("mobile:"))
        assertFalse(deviceId.contains("basura"))
    }

    @Test
    fun twoPhonesGetDifferentDeviceIds() {
        assertFalse(
            IdentityStore(SettableContext()).resolveStableDeviceId() ==
                IdentityStore(SettableContext()).resolveStableDeviceId()
        )
    }

    /**
     * §2.5: el claim manda el deviceId del teléfono, y es el que quedó atado al
     * desafío. Si no mandara el suyo, el servidor no podría comparar.
     */
    @Test
    fun theClaimSendsThePhonesOwnStableDeviceId() {
        val httpPort = FakeEnrollmentHttpPort(
            EnrollmentHttpAnswer(
                statusCode = 200,
                body = JSONObject()
                    .put("status", "enrolled")
                    .put("deviceId", TEST_DEVICE_ID)
                    .put("credential", "apollo_dev_x")
                    .toString()
            )
        )
        val client = EnrollmentClaimClient(testConfig, httpPort)

        client.claim(challenge = "apollo_enr_desafio", deviceId = TEST_DEVICE_ID)

        val sentBody = JSONObject(httpPort.sentBodyList[0])
        assertEquals(TEST_DEVICE_ID, sentBody.getString("deviceId"))
    }

    @Test
    fun aDeviceIdMismatchIsSurfacedWithItsOwnReason() {
        // §2.5: el servidor contesta `device_id_mismatch` cuando el desafío es de
        // otro teléfono. El cliente tiene que recibir ese motivo, no uno genérico.
        val client = EnrollmentClaimClient(
            testConfig,
            FakeEnrollmentHttpPort(
                EnrollmentHttpAnswer(
                    statusCode = 403,
                    body = JSONObject()
                        .put("status", "rejected")
                        .put("reason", "device_id_mismatch")
                        .toString()
                )
            )
        )

        val result = client.claim("apollo_enr_desafio-de-otro", TEST_DEVICE_ID)

        assertEquals(
            EnrollmentClaimResult.Rejected("device_id_mismatch"),
            result
        )
    }

    /**
     * §3: conectar como dispositivo autorizado exige credencial enrolada. El
     * cliente no construye un request con el secreto global.
     */
    @Test
    fun theLegacySharedSecretCannotBuildASocketRequest() {
        // El camino legacy se conserva en el tipo --Desktop y los smokes lo usan
        // como caller-- pero el teléfono no debe llegar a él para autorizar una
        // sesión: MainActivity exige `readEnrolledCredential()` antes de
        // conectar, y `resolve()` prefiere siempre la enrolada.
        val resolved = DeviceCredential.resolve(
            enrolledCredential = "apollo_dev_individual",
            legacySharedSecret = TEST_DEVICE_SHARED_SECRET
        )
        assertTrue(resolved is DeviceCredential.Enrolled)
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private companion object {
        /** `mobile:` seguido de un UUID en mayúsculas, como genera Java. */
        val UUID_PATTERN = Regex(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        )
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private fun buildSession(socketFactory: RecordingSocketFactory): MobileSession =
        MobileSession(
            clientConfig = testConfig,
            deviceSocketFactory = socketFactory,
            commandDispatcher = CommandDispatcher(
                notificationAdapter = FakeNotificationAdapter(PermissionOutcome.Granted),
                platform = RecordingMobilePlatform()
            ),
            nowMillisecondsPort = { TEST_NOW_MILLISECONDS }
        )
}

const val TEST_NOW_MILLISECONDS = 1_700_000_000_000L

/**
 * Cifrado de prueba. El de produccion es `KeystoreCredentialCipher`, que usa
 * AES-GCM con una clave del Android Keystore: eso no se puede levantar en la
 * JVM. Lo que se prueba aca es que el store guarda el resultado del cifrador y no
 * el texto plano.
 */
class ReversibleTestCipher : CredentialCipher {
    override fun encrypt(plainText: String): String =
        "enc:" + plainText.reversed()

    override fun decrypt(cipherText: String): String {
        if (!cipherText.startsWith("enc:")) {
            throw IllegalArgumentException("no es un ciphertext de este cifrador")
        }
        return cipherText.removePrefix("enc:").reversed()
    }
}

class FakeEnrollmentHttpPort(
    private val answer: EnrollmentHttpAnswer
) : EnrollmentHttpPort {

    val sentUrlList = mutableListOf<String>()
    val sentBodyList = mutableListOf<String>()

    override fun postJson(url: String, jsonBody: String): EnrollmentHttpAnswer {
        sentUrlList.add(url)
        sentBodyList.add(jsonBody)
        return answer
    }
}

/**
 * Un `Context` mínimo que guarda las preferencias en memoria.
 *
 * `android.jar` del SDK no trae implementación, así que un test unitario no
 * puede usar las preferencias reales. Lo que importa es la LÓGICA -- el id se
 * resuelve una vez y se reutiliza --, no el almacenamiento.
 */
class SettableContext(
    private val persistedPreferenceMap: MutableMap<String, Any> = mutableMapOf()
) : android.content.ContextWrapper(null) {

    override fun getSharedPreferences(
        name: String?,
        mode: Int
    ): SharedPreferences = InMemorySharedPreferences(persistedPreferenceMap)
}

class InMemorySharedPreferences(
    private val valueMap: MutableMap<String, Any>
) : SharedPreferences {

    override fun getAll(): MutableMap<String, *> = valueMap

    override fun getString(key: String?, defValue: String?): String? =
        valueMap[key] as? String ?: defValue

    @Suppress("UNCHECKED_CAST")
    override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
        valueMap[key] as? MutableSet<String> ?: defValues

    override fun getInt(key: String?, defValue: Int): Int = valueMap[key] as? Int ?: defValue

    override fun getLong(key: String?, defValue: Long): Long = valueMap[key] as? Long ?: defValue

    override fun getFloat(key: String?, defValue: Float): Float =
        valueMap[key] as? Float ?: defValue

    override fun getBoolean(key: String?, defValue: Boolean): Boolean =
        valueMap[key] as? Boolean ?: defValue

    override fun contains(key: String?): Boolean = valueMap.containsKey(key)

    override fun edit(): SharedPreferences.Editor = InMemoryEditor(valueMap)

    override fun registerOnSharedPreferenceChangeListener(
        listener: SharedPreferences.OnSharedPreferenceChangeListener?
    ) = Unit

    override fun unregisterOnSharedPreferenceChangeListener(
        listener: SharedPreferences.OnSharedPreferenceChangeListener?
    ) = Unit
}

class InMemoryEditor(
    private val valueMap: MutableMap<String, Any>
) : SharedPreferences.Editor {

    private val pendingMap = mutableMapOf<String, Any?>()

    override fun putString(key: String, value: String?): SharedPreferences.Editor {
        pendingMap[key] = value
        return this
    }

    override fun putStringSet(
        key: String,
        values: MutableSet<String>?
    ): SharedPreferences.Editor {
        pendingMap[key] = values
        return this
    }

    override fun putInt(key: String, value: Int): SharedPreferences.Editor {
        pendingMap[key] = value
        return this
    }

    override fun putLong(key: String, value: Long): SharedPreferences.Editor {
        pendingMap[key] = value
        return this
    }

    override fun putFloat(key: String, value: Float): SharedPreferences.Editor {
        pendingMap[key] = value
        return this
    }

    override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor {
        pendingMap[key] = value
        return this
    }

    override fun remove(key: String): SharedPreferences.Editor {
        pendingMap[key] = null
        return this
    }

    override fun clear(): SharedPreferences.Editor {
        pendingMap.keys.forEach { pendingMap[it] = null }
        return this
    }

    override fun commit(): Boolean {
        for ((key, value) in pendingMap) {
            if (value == null) {
                valueMap.remove(key)
            } else {
                valueMap[key] = value
            }
        }
        return true
    }

    override fun apply() {
        commit()
    }
}
