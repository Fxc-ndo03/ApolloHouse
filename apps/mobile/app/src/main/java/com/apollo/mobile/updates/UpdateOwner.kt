package com.apollo.mobile.updates

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * FASE 3.5 — dueño del ciclo de vida del actualizador.
 *
 * Vive en la `Application` y no en la `Activity`, por el mismo motivo que
 * `sessionOwner` y `conversationOwner`: la `Activity` se recrea al rotar o al
 * navegar, y una descarga que viviera ahí se perdería o se duplicaría. Esta
 * clase tiene una sola instancia por proceso y la UI la observa.
 *
 * No hay servicio en segundo plano: la comprobación ocurre al abrir la app y al
 * volver a primer plano, que es exactamente cuando hay alguien mirando. Una
 * tarea periódica en background sería trabajo que la app no necesita y que
 * Android penaliza.
 *
 * Todo el trabajo sale del hilo principal en [workScope]; la UI recibe el
 * estado de vuelta en [mainThreadPoster].
 */
class UpdateOwner(
    private val serviceFactory: () -> UpdateService,
    private val workScope: CoroutineScope,
    private val mainThreadPoster: (Runnable) -> Unit,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val minimumCheckIntervalMillis: Long = DEFAULT_MINIMUM_CHECK_INTERVAL_MILLIS,
    private val installedVersionCodeProvider: () -> Long = { 0L }
) {

    /**
     * Lo que la interfaz dibuja.
     *
     * Es un tipo cerrado a propósito: la UI no inventa estados y el dueño no
     * publica objetos de Tauri/Windows que acá no existen.
     */
    sealed class State {
        /** Todavía no se comprobó nada en esta sesión. */
        object SinComprobar : State()

        object Comprobando : State()

        /** No hay nada nuevo. `ultimaComprobacionMillis` es epoch. */
        data class AlDia(val ultimaComprobacionMillis: Long) : State()

        /** Hay una versión nueva verificada contra el canal de esta build. */
        data class Disponible(val manifest: UpdateManifest) : State()

        data class Descargando(
            val manifest: UpdateManifest,
            val bytesRead: Long,
            val totalBytes: Long
        ) : State()

        /** Descargado, con tamaño y hash ya comparados contra el manifiesto. */
        data class VerificadoParaInstalar(val apk: UpdateDownloader.VerifiedApk) : State()

        /** El instalador del sistema está abierto. NO significa que se instaló. */
        data class InstaladorAbierto(val apk: UpdateDownloader.VerifiedApk) : State()

        /** Falta el permiso de "instalar apps desconocidas". */
        object FaltaPermisoDeInstalacion : State()

        data class Error(val motivo: String, val recuperable: Boolean) : State()
    }

    fun interface Listener {
        fun onStateChanged(state: State)
    }

    private val lock = Any()
    private val listenerList = mutableListOf<Listener>()

    private var currentState: State = State.SinComprobar
    private var lastCheckMillis: Long = 0L
    private var didCheckOnce: Boolean = false

    /** Petición de comprobación en vuelo. Evita consultas duplicadas. */
    private var isChecking: Boolean = false

    /** Descarga en vuelo, por `versionCode`. Evita bajar dos veces lo mismo. */
    private var downloadingVersionCode: Long? = null

    /**
     * APK ya descargado, verificado y listo para instalar.
     *
     * Se guarda el archivo, no sólo su versión: es lo que permite ofrecer
     * "instalar" sin volver a bajar, y lo que se revalida contra el manifiesto
     * antes de abrir el sistema.
     */
    private var verifiedApk: UpdateDownloader.VerifiedApk? = null

    private val channel: String = UpdateManifest.channelOfThisBuild()

    val currentChannel: String get() = channel

    fun state(): State = synchronized(lock) { currentState }

    /** Registra un observador y le entrega el estado actual de inmediato. */
    fun observe(listener: Listener) {
        val current = synchronized(lock) {
            listenerList.add(listener)
            currentState
        }
        listener.onStateChanged(current)
    }

    fun unobserve(listener: Listener) {
        synchronized(lock) { listenerList.remove(listener) }
    }

    /**
     * Comprobación al abrir la app.
     *
     * La primera vez siempre pasa; después respeta el intervalo para no
     * pegarle un request a GitHub cada vez que se abre la pantalla.
     */
    fun comprobarAlIniciar() = comprobar(forzar = false)

    /**
     * Comprobación al volver a primer plano.
     *
     * Idéntica a la de inicio a propósito: el throttle ya impide el trabajo
     * inútil, y Differenciar las dos solo abriría la puerta a saltarse el
     * intervalo.
     */
    fun comprobarAlReanudar() = comprobar(forzar = false)

    /**
     * Comprobación pedida por la persona ("Reintentar"). Ignora el intervalo.
     *
     * @return `true` si la comprobación llegó a encolarse.
     */
    fun comprobarAhora(): Boolean = comprobar(forzar = true)

    private fun comprobar(forzar: Boolean): Boolean {
        synchronized(lock) {
            if (isChecking) return false
            if (!forzar) {
                val ahora = clock()
                // La primera vez siempre pasa. Después sólo si pasó el
                // intervalo: volver a primer plano no puede pegarle un request
                // a GitHub cada vez que se abre la pantalla.
                if (didCheckOnce && ahora - lastCheckMillis < minimumCheckIntervalMillis) {
                    return false
                }
            }
            isChecking = true
            publishLocked(State.Comprobando)
        }
        enqueue {
            try {
                when (val outcome = serviceFactory().check()) {
                    is UpdateService.Outcome.HayActualizacion -> manejarConsulta(outcome)
                    UpdateService.Outcome.SinActualizaciones -> {
                        synchronized(lock) { didCheckOnce = true; lastCheckMillis = clock() }
                        publish(State.AlDia(clock()))
                    }
                    is UpdateService.Outcome.Error -> {
                        synchronized(lock) { didCheckOnce = true; lastCheckMillis = clock() }
                        publish(State.Error(outcome.motivo, outcome.recuperable))
                    }
                    else -> publish(State.Error("Respuesta inesperada del servidor", true))
                }
            } finally {
                synchronized(lock) { isChecking = false }
            }
        }
        return true
    }

    /**
     * Traduce el veredicto a estado visible.
     *
     * Un rechazo NO es un error: es la respuesta correcta cuando, por ejemplo,
     * el manifiesto es de otro canal. Decirlo evita que la UI muestre un fallo
     * donde en realidad el aislamiento funcionó.
     */
    private fun manejarConsulta(outcome: UpdateService.Outcome.HayActualizacion) {
        val rejection = outcome.rejection
        synchronized(lock) { didCheckOnce = true; lastCheckMillis = clock() }

        if (rejection != null) {
            publish(State.AlDia(clock()))
            return
        }
        val manifest = outcome.manifest
        // Si esta versión ya está descargada y verificada, no se vuelve a
        // proponer la descarga: se ofrece directamente instalarla.
        val yaVerificado = synchronized(lock) { verifiedApk }
        if (yaVerificado != null && yaVerificado.versionCode == manifest.versionCode) {
            publish(State.VerificadoParaInstalar(yaVerificado))
            return
        }
        publish(State.Disponible(manifest))
    }

    /**
     * Descarga la versión que el estado está ofreciendo.
     *
     * Sólo actúa desde [State.Disponible]. Dos entradas en primer plano seguidas
     * no producen dos descargas: la segunda vez la petición en vuelo se rechaza.
     */
    fun descargar(): Boolean {
        val manifest = (state() as? State.Disponible)?.manifest ?: return false
        synchronized(lock) {
            if (downloadingVersionCode != null) return false
            if (verifiedApk?.versionCode == manifest.versionCode) return false
            downloadingVersionCode = manifest.versionCode
            publishLocked(State.Descargando(manifest, 0, manifest.sizeBytes))
        }
        enqueue {
            try {
                when (val outcome = serviceFactory().download(manifest) { leidos, total ->
                    if (leidos == total || leidos % PROGRESS_STEP_BYTES == 0L) {
                        publish(State.Descargando(manifest, leidos, total))
                    }
                }) {
                    is UpdateService.Outcome.ListoParaInstalar -> {
                        synchronized(lock) { verifiedApk = outcome.apk }
                        publish(State.VerificadoParaInstalar(outcome.apk))
                    }
                    UpdateService.Outcome.FaltaPermisoDeInstalacion ->
                        publish(State.FaltaPermisoDeInstalacion)
                    is UpdateService.Outcome.Error ->
                        publish(State.Error(outcome.motivo, outcome.recuperable))
                    else -> publish(State.Error("La descarga no pudo completarse", true))
                }
            } finally {
                synchronized(lock) { downloadingVersionCode = null }
            }
        }
        return true
    }

    /**
     * Abre el instalador del sistema con el APK verificado.
     *
     * Va al hilo principal porque llama a `startActivity`. El dueño no sabe de
     * `Activity`: recibe el resultado por [alVolverDelInstalador].
     */
    fun abrirInstalador(): Boolean {
        val apk = when (val current = state()) {
            is State.VerificadoParaInstalar -> current.apk
            is State.InstaladorAbierto -> current.apk
            else -> return false
        }
        return try {
            when (val outcome = serviceFactory().openInstaller(apk)) {
                UpdateService.Outcome.FaltaPermisoDeInstalacion -> {
                    publish(State.FaltaPermisoDeInstalacion)
                    false
                }
                is UpdateService.Outcome.ListoParaInstalar -> {
                    publish(State.InstaladorAbierto(outcome.apk))
                    true
                }
                is UpdateService.Outcome.Error -> {
                    publish(State.Error(outcome.motivo, outcome.recuperable))
                    false
                }
                else -> false
            }
        } catch (error: Exception) {
            publish(State.Error("No se pudo abrir el instalador: ${error.message ?: "sin detalle"}", true))
            false
        }
    }

    /**
     * Qué pasó realmente al volver de la pantalla de instalación.
     *
     * FASE 3.5: abrir el instalador no es instalar. Se relee el `versionCode`
     * instalado y se decide con eso, no con la suposición de que la persona
     * aceptó.
     */
    fun alVolverDelInstalador() {
        val apk = when (val current = state()) {
            is State.InstaladorAbierto -> current.apk
            is State.VerificadoParaInstalar -> current.apk
            else -> return
        }
        val estabaInstalada = installedVersionCodeProvider()
        val quedoInstalada = estabaInstalada >= apk.versionCode
        if (!quedoInstalada) {
            // El archivo verificado ya no sirve: el manifiesto pudo moverse y
            // el sistema pudo rechazarlo. Se descarta y se pide comprobar.
            apk.file.delete()
            synchronized(lock) { verifiedApk = null }
            publish(State.Error("La actualizacion no quedo instalada", recuperable = true))
            return
        }
        synchronized(lock) { verifiedApk = null }
        // Ya instalado: el APK cumplió su función. Dejarlo son decenas de
        // megabytes ocupando caché sin que nada los vuelva a usar.
        apk.file.delete()
        publish(State.AlDia(clock()))
    }

    /**
     * Vuelve a comprobar desde cero.
     *
     * Es lo que se llama tras volver de los ajustes de permiso: el permiso pudo
     * concederse y hace falta saber si la app ya puede instalar.
     */
    fun comprobarPermisoDeInstalacion(concedido: Boolean) {
        if (concedido) {
            descargar()
        } else {
            publish(State.FaltaPermisoDeInstalacion)
        }
    }

    private fun enqueue(trabajo: suspend () -> Unit) {
        workScope.launch {
            runCatching { trabajo() }
        }
    }

    private fun publish(state: State) {
        synchronized(lock) { currentState = state }
        notifyListeners(state)
    }

    /** El llamador ya tiene el lock. */
    private fun publishLocked(state: State) {
        currentState = state
        notifyListeners(state)
    }

    private fun notifyListeners(state: State) {
        val listeners = synchronized(lock) { listenerList.toList() }
        mainThreadPoster {
            listeners.forEach { listener -> listener.onStateChanged(state) }
        }
    }

    companion object {
        /**
         * Seis horas. Suficiente para notar una publicación nueva sin castigar
         * a quien abre y cierra la app durante el día.
         */
        const val DEFAULT_MINIMUM_CHECK_INTERVAL_MILLIS = 6L * 60L * 60L * 1000L

        /** Se publica el progreso cada 256 KiB: más fino es ruido. */
        private const val PROGRESS_STEP_BYTES = 256L * 1024L

        fun forApplication(context: Context): UpdateOwner = UpdateOwner(
            serviceFactory = { UpdateService.forThisBuild(context) },
            workScope = CoroutineScope(Dispatchers.IO),
            mainThreadPoster = { action ->
                android.os.Handler(android.os.Looper.getMainLooper()).post(action)
            },
            installedVersionCodeProvider = { AndroidUpdateInstallerGateway.readInstalledVersionCode(context) }
        )
    }
}
