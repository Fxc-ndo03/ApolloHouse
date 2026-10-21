package com.apollo.mobile.bridge

import com.apollo.mobile.ApolloApplication
import com.apollo.mobile.contract.Contract
import com.apollo.mobile.identity.IdentityStore
import com.apollo.mobile.notification.AndroidNotificationAdapter
import com.apollo.mobile.notification.PermissionOutcome
import com.apollo.mobile.settings.AppSettingsStore
import com.apollo.mobile.session.MobileSessionState
import com.apollo.mobile.updates.AndroidUpdateInstallerGateway
import com.apollo.mobile.updates.UpdateDownloader
import com.apollo.mobile.updates.UpdateOwner
import android.content.Context
import android.util.Log

/**
 * FASE 6.3 · Etapa 4 — manejador de capacidades del puente.
 *
 * Expone capacidades nativas permitidas por el contrato React. Ajustes y
 * actualizaciones se resuelven localmente; voz delega al controlador de
 * SpeechRecognizer del host y solo se inicia por accion del usuario.
 */
class BridgeCapabilityHandler(
    private val application: ApolloApplication,
    private val context: Context,
    private val eventEmitter: (String, String) -> Unit = { _, _ -> },
    private val updateOwnerProvider: () -> UpdateOwner = { application.updateOwner },
    private val installedVersionNameProvider: () -> String = {
        AndroidUpdateInstallerGateway.readInstalledVersionName(context)
    },
    private val installPermissionProvider: () -> Boolean = {
        UpdateDownloader.canRequestInstall(context)
    },
    private val voiceOperation: ((String) -> Unit)? = null,
) {

    private val identityStore: IdentityStore = IdentityStore(context)
    private val notificationAdapter: AndroidNotificationAdapter =
        AndroidNotificationAdapter(context)
    private val settingsStore = AppSettingsStore(
        com.apollo.mobile.settings.SharedPreferencesAppSettingsPreferences(
            context.getSharedPreferences(AppSettingsStore.PREFERENCES_NAME, Context.MODE_PRIVATE),
        ),
    ) { application.workerHost }
    @Volatile private var installWhenReady = false

    private val updateListener: UpdateOwner.Listener = UpdateOwner.Listener { state: UpdateOwner.State ->
        if (state is UpdateOwner.State.Disponible ||
            state is UpdateOwner.State.AlDia ||
            state is UpdateOwner.State.Error
        ) {
            eventEmitter(
                "update://status",
                org.json.JSONObject(
                    updateStatusData(
                        state,
                        com.apollo.mobile.updates.UpdateManifest.channelOfThisBuild(),
                        installedVersionNameProvider(),
                    ),
                ).toString(),
            )
        }
        when (state) {
            is UpdateOwner.State.Descargando -> {
                if (state.manifest.sizeBytes > 0L) {
                    val progress = (state.bytesRead * 100L / state.totalBytes.coerceAtLeast(1L))
                        .coerceIn(0L, 100L)
                    eventEmitter("update://progress", progress.toString())
                }
            }
            is UpdateOwner.State.VerificadoParaInstalar -> {
                eventEmitter("update://ready", "{}")
                if (installWhenReady) {
                    installWhenReady = false
                    if (!updateOwner.abrirInstalador() &&
                        updateOwner.state() is UpdateOwner.State.FaltaPermisoDeInstalacion
                    ) {
                        eventEmitter("error", "{\"code\":\"permission_denied\",\"message\":\"Falta permiso para instalar actualizaciones.\"}")
                    }
                }
            }
            else -> Unit
        }
    }
    private val updateOwnerDelegate: Lazy<UpdateOwner> = lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        updateOwnerProvider().also { owner: UpdateOwner -> owner.observe(updateListener) }
    }
    private val updateOwner by updateOwnerDelegate

    fun handle(operation: String, arguments: Map<String, Any?>): BridgeResponse =
        when (operation) {
            "device.identity" -> handleDeviceIdentity()
            "capabilities.list" -> handleCapabilitiesList()
            "capabilities.state" -> handleCapabilitiesState()
            "notification.post" -> handleNotificationPost(arguments)
            "updates.check" -> handleUpdatesCheck()
            "updates.install" -> handleUpdatesInstall()
            "settings.read" -> handleSettingsRead()
            "settings.write" -> handleSettingsWrite(arguments)
            "voice.start", "voice.stop" -> handleVoice(operation)
            else -> BridgeValidator.error(null, BridgeError.UNSUPPORTED_OPERATION)
        }

    private fun handleDeviceIdentity(): BridgeResponse {
        val deviceId = identityStore.resolveStableDeviceId()
        return BridgeValidator.ok(
            null,
            mapOf("deviceId" to deviceId, "deviceType" to "mobile"),
        )
    }

    private fun handleCapabilitiesList(): BridgeResponse {
        return BridgeValidator.ok(
            null,
            mapOf("capabilities" to Contract.ANNOUNCED_CAPABILITY_LIST),
        )
    }

    private fun handleCapabilitiesState(): BridgeResponse {
        val state = application.sessionOwner.currentState
        return BridgeValidator.ok(null, mapOf("connectionState" to mapSessionState(state)))
    }

    private fun handleNotificationPost(arguments: Map<String, Any?>): BridgeResponse {
        val title = arguments["title"] as? String
            ?: return BridgeValidator.error(null, BridgeError.INVALID_ARGUMENTS)
        val body = arguments["body"] as? String
            ?: return BridgeValidator.error(null, BridgeError.INVALID_ARGUMENTS)

        if (notificationAdapter.requestPermission() != PermissionOutcome.Granted) {
            return BridgeValidator.error(null, BridgeError.PERMISSION_DENIED)
        }
        val posted = notificationAdapter.post(title, body)
        return if (posted) {
            BridgeValidator.ok(null, mapOf("posted" to true))
        } else {
            BridgeValidator.error(null, BridgeError.UNAVAILABLE)
        }
    }

    private fun handleUpdatesCheck(): BridgeResponse {
        updateOwner.comprobarAhora()
        return BridgeValidator.ok(
            null,
            updateStatusData(updateOwner.state(), updateOwner.currentChannel, installedVersionNameProvider()),
        )
    }

    private fun handleUpdatesInstall(): BridgeResponse {
        if (!installPermissionProvider()) {
            return BridgeValidator.error(null, BridgeError.PERMISSION_DENIED)
        }
        return when (updateOwner.state()) {
            is UpdateOwner.State.Disponible -> {
                installWhenReady = true
                if (updateOwner.descargar()) BridgeValidator.ok(null)
                else {
                    installWhenReady = false
                    BridgeValidator.error(null, BridgeError.UNAVAILABLE)
                }
            }
            is UpdateOwner.State.Descargando -> {
                installWhenReady = true
                BridgeValidator.ok(null)
            }
            is UpdateOwner.State.VerificadoParaInstalar -> {
                if (updateOwner.abrirInstalador()) BridgeValidator.ok(null)
                else if (updateOwner.state() is UpdateOwner.State.FaltaPermisoDeInstalacion) {
                    BridgeValidator.error(null, BridgeError.PERMISSION_DENIED)
                } else {
                    BridgeValidator.error(null, BridgeError.UNAVAILABLE)
                }
            }
            is UpdateOwner.State.InstaladorAbierto -> BridgeValidator.ok(null)
            UpdateOwner.State.FaltaPermisoDeInstalacion ->
                BridgeValidator.error(null, BridgeError.PERMISSION_DENIED)
            else -> BridgeValidator.error(null, BridgeError.UNAVAILABLE)
        }
    }

    private fun handleSettingsRead(): BridgeResponse =
        BridgeValidator.ok(null, settingsStore.read())

    private fun handleSettingsWrite(arguments: Map<String, Any?>): BridgeResponse {
        val patch = arguments["patch"] as? Map<*, *>
            ?: return BridgeValidator.error(null, BridgeError.INVALID_ARGUMENTS)
        val stringPatch: Map<String, Any?> = buildMap {
            patch.forEach { (key, value) ->
                (key as? String)?.let { put(it, value) }
            }
        }
        val writtenNames = settingsStore.write(stringPatch)
        if (writtenNames.isNotEmpty()) {
            Log.i("ApolloSettings", "settings.write keys=${writtenNames.sorted().joinToString(",")}")
        }
        return BridgeValidator.ok(null)
    }

    private fun handleVoice(operation: String): BridgeResponse {
        val handler = voiceOperation ?: return BridgeValidator.error(null, BridgeError.UNAVAILABLE)
        handler(operation)
        return BridgeValidator.ok(null)
    }

    private fun mapSessionState(state: MobileSessionState?): String =
        when (state) {
            MobileSessionState.ONLINE, MobileSessionState.AUTHENTICATED -> "online"
            MobileSessionState.CONNECTING -> "connecting"
            MobileSessionState.RECONNECTING -> "reconnecting"
            MobileSessionState.DISCONNECTED -> "disconnected"
            null -> "disconnected"
        }
}

internal fun updateStatusData(
    state: UpdateOwner.State,
    channel: String,
    installedVersion: String,
): Map<String, Any?> {
    val kind: String
    val latestVersion: String?
    val notes: String?
    val publishedAt: String?
    val reason: String?
    val message: String?
    when (state) {
        UpdateOwner.State.SinComprobar -> {
            kind = "idle"; latestVersion = null; notes = null; publishedAt = null; reason = null; message = null
        }
        UpdateOwner.State.Comprobando -> {
            kind = "checking"; latestVersion = null; notes = null; publishedAt = null; reason = null; message = null
        }
        is UpdateOwner.State.AlDia -> {
            kind = "upToDate"; latestVersion = installedVersion; notes = null; publishedAt = null; reason = null; message = null
        }
        is UpdateOwner.State.Disponible -> {
            kind = "available"; latestVersion = state.manifest.versionName; notes = state.manifest.notes
            publishedAt = state.manifest.publishedAt; reason = null; message = null
        }
        is UpdateOwner.State.Descargando -> {
            kind = "downloading"; latestVersion = state.manifest.versionName; notes = state.manifest.notes
            publishedAt = state.manifest.publishedAt; reason = null; message = null
        }
        is UpdateOwner.State.VerificadoParaInstalar -> {
            kind = "ready"; latestVersion = state.apk.versionName; notes = state.apk.manifest.notes
            publishedAt = state.apk.manifest.publishedAt; reason = null; message = null
        }
        is UpdateOwner.State.InstaladorAbierto -> {
            kind = "pendingRestart"; latestVersion = state.apk.versionName; notes = state.apk.manifest.notes
            publishedAt = state.apk.manifest.publishedAt; reason = null; message = null
        }
        UpdateOwner.State.FaltaPermisoDeInstalacion -> {
            kind = "failed"; latestVersion = null; notes = null; publishedAt = null
            reason = "missing_permission"; message = "Falta permiso para instalar actualizaciones."
        }
        is UpdateOwner.State.Error -> {
            kind = "failed"; latestVersion = null; notes = null; publishedAt = null
            reason = state.motivo; message = state.motivo
        }
    }
    val status = if (reason == null) mapOf("kind" to kind) else mapOf("kind" to kind, "reason" to reason)
    return mapOf(
        "channel" to channel,
        "installedVersion" to installedVersion,
        "status" to status,
        "latestVersion" to (latestVersion ?: org.json.JSONObject.NULL),
        "notes" to (notes ?: org.json.JSONObject.NULL),
        "publishedAt" to (publishedAt ?: org.json.JSONObject.NULL),
        "message" to (message ?: org.json.JSONObject.NULL),
    )
}
