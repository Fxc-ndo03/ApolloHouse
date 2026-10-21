package com.apollo.mobile.updates

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers

/**
 * FASE 3.5 — pruebas de la integración REAL del actualizador.
 *
 * Nada de esto prueba una copia: los tests llaman a [UpdateOwner],
 * [UpdateService] y [UpdateDownloader], los mismos objetos que usa la app.
 *
 * Lo inyectado son las fronteras del mundo real —la red, el reloj y el
 * instalador del sistema— porque un test unitario no puede abrir un socket ni
 * mostrar un `PackageInstaller`. El resto, incluido todo el flujo de descarga,
 * verificación y decisión, es el código de producción sin tocar.
 *
 * NO se prueba aquí, y queda pendiente de dispositivo: que Android acepte el
 * paquete, que aparezca el instalador oficial y la continuidad real del
 * certificado entre versiones.
 */
class UpdateOwnerIntegrationTest {

    // ----------------------------------------------------------------------
    // Dobles de las fronteras
    // ----------------------------------------------------------------------

    /** Instalador simulado: la app real usa `AndroidUpdateInstallerGateway`. */
    private class FakeInstaller(override val cacheDirectory: File) : UpdateInstallerGateway {
        var permisoConcedido = true
        var launchResult: UpdateDownloader.InstallerLaunch =
            UpdateDownloader.InstallerLaunch.Iniciado
        var installedVersionCode = 100L
        var installedVersionName = "1.0.1"
        var apKsRecibidos = mutableListOf<UpdateDownloader.VerifiedApk>()

        override fun canRequestInstall(): Boolean = permisoConcedido

        override fun openInstaller(apk: UpdateDownloader.VerifiedApk): UpdateDownloader.InstallerLaunch {
            apKsRecibidos.add(apk)
            return launchResult
        }

        override fun installedVersionCode(): Long = installedVersionCode

        override fun installedVersionName(): String = installedVersionName
    }

    /** APK servido desde memoria: el `UpdateDownloader` real lo consume igual. */
    private class MemoryApkSource(private val content: ByteArray) : UpdateDownloader.ApkSource {
        var llamadas = 0
            private set
        override fun open(url: String): kotlin.Result<UpdateDownloader.ApkStream> {
            llamadas++
            return kotlin.Result.success(
                UpdateDownloader.ApkStream(ByteArrayInputStream(content), content.size.toLong())
            )
        }
    }

    private class FailingApkSource(private val motivo: String) : UpdateDownloader.ApkSource {
        override fun open(url: String): kotlin.Result<UpdateDownloader.ApkStream> =
            kotlin.Result.failure(IllegalStateException(motivo))
    }

    // ----------------------------------------------------------------------
    // Utilidades
    // ----------------------------------------------------------------------

    private fun manifestOf(
        channel: String = UpdateManifest.CHANNEL_STABLE,
        versionCode: Long = 200,
        versionName: String = "1.4.1",
        notes: String = "notas",
        sizeBytes: Long,
        sha256: String
    ) = UpdateManifest(
        versionName = versionName,
        versionCode = versionCode,
        channel = channel,
        notes = notes,
        publishedAt = "2026-10-14T00:00:00Z",
        apkUrl = "https://github.com/Fxc-ndo03/ApolloHouse/releases/download/v$versionName/Apollo.apk",
        sizeBytes = sizeBytes,
        sha256 = sha256,
        minSdkInt = 25,
        minClientVersionCode = 0,
        minSigningCertificateSha256 = null
    )

    /** Manifiesto cuyo hash y tamaño describen el contenido dado. */
    private fun manifestFor(
        content: ByteArray,
        channel: String = UpdateManifest.CHANNEL_STABLE,
        versionCode: Long = 200
    ): UpdateManifest = manifestOf(
        channel = channel,
        versionCode = versionCode,
        sizeBytes = content.size.toLong(),
        sha256 = MessageDigest.getInstance("SHA-256").digest(content).toHexString()
    )

    private fun manifestJson(
        channel: String = UpdateManifest.CHANNEL_STABLE,
        versionCode: Long = 200,
        versionName: String = "1.4.1",
        notes: String = "notas",
        sizeBytes: Long = 1024,
        sha: String = "c".repeat(64),
        minSdkInt: Int = 25
    ): String = """
        {
          "version": "$versionName",
          "versionCode": $versionCode,
          "channel": "$channel",
          "notes": "$notes",
          "publishedAt": "2026-10-14T00:00:00Z",
          "apkUrl": "https://github.com/Fxc-ndo03/ApolloHouse/releases/download/v$versionName/Apollo.apk",
          "sizeBytes": $sizeBytes,
          "sha256": "$sha",
          "minSdk": $minSdkInt
        }
    """.trimIndent()

    private fun nuevoCache(): File {
        val root = File.createTempFile("apollo-updates-test", "")
        root.delete()
        root.mkdirs()
        return root
    }

    private class Escenario(
        val cache: File,
        val installer: FakeInstaller,
        val manifestCalls: MutableList<String>,
        var ahora: Long = 1_000_000L,
        var intervalo: Long = UpdateOwner.DEFAULT_MINIMUM_CHECK_INTERVAL_MILLIS,
        var apkSource: UpdateDownloader.ApkSource = FailingApkSource("sin configurar"),
        var manifestBody: String,
        var manifestFailure: String? = null,
        var installedVersionCode: Long = 100L,
        var channel: String = UpdateManifest.CHANNEL_STABLE
    ) {
        lateinit var owner: UpdateOwner
        lateinit var service: UpdateService

        fun iniciar() {
            // Una sola fuente para el `versionCode` instalado: el gateway.
            // Antes el owner tenía su propio contador y podía discrepar del
            // que usa `UpdateService`, que es justo lo que hace fallar una
            // comprobación de "¿quedó instalada?".
            installer.installedVersionCode = installedVersionCode
            installer.installedVersionName = "1.0.1"
            service = UpdateService(
                installer = installer,
                manifestUrl = "https://ejemplo.invalid/android.json",
                appChannel = channel,
                manifestFetcher = { url ->
                    manifestCalls.add(url)
                    manifestFailure?.let { throw IllegalStateException(it) }
                    manifestBody
                },
                apkSource = apkSource,
                ioDispatcher = Dispatchers.Unconfined,
                deviceSdkIntProvider = { 34 }
            )
            owner = UpdateOwner(
                serviceFactory = { service },
                workScope = CoroutineScope(Dispatchers.Unconfined),
                mainThreadPoster = { it.run() },
                clock = { ahora },
                minimumCheckIntervalMillis = intervalo,
                installedVersionCodeProvider = { installer.installedVersionCode() }
            )
            return
        }
    }

    private fun escenario(
        manifestBody: String = manifestJson(versionCode = 200),
        manifestFailure: String? = null,
        installedVersionCode: Long = 100L,
        channel: String = UpdateManifest.CHANNEL_STABLE,
        intervalo: Long = UpdateOwner.DEFAULT_MINIMUM_CHECK_INTERVAL_MILLIS,
        apkSource: UpdateDownloader.ApkSource = FailingApkSource("sin configurar")
    ): Escenario {
        val cache = nuevoCache()
        val escenario = Escenario(
            cache = cache,
            installer = FakeInstaller(cache),
            manifestCalls = mutableListOf(),
            intervalo = intervalo,
            apkSource = apkSource,
            manifestBody = manifestBody,
            manifestFailure = manifestFailure,
            installedVersionCode = installedVersionCode,
            channel = channel
        )
        escenario.iniciar()
        return escenario
    }

    // ======================================================================
    // 1 y 2 — arranque al día / arranque con actualización disponible
    // ======================================================================

    @Test
    fun al_iniciar_con_la_app_al_dia_no_ofrece_nada() {
        val e = escenario(manifestBody = manifestJson(versionCode = 5, versionName = "1.0.1"))
        e.owner.comprobarAlIniciar()
        assertTrue("esperaba AlDia, hubo ${e.owner.state()}", e.owner.state() is UpdateOwner.State.AlDia)
    }

    @Test
    fun al_iniciar_con_una_actualizacion_disponible_la_presenta_con_sus_notas() {
        val e = escenario(manifestBody = manifestJson(notes = "arregla la voz", versionCode = 200))
        e.owner.comprobarAlIniciar()
        val estado = e.owner.state()
        assertTrue("esperaba Disponible, hubo $estado", estado is UpdateOwner.State.Disponible)
        val disponible = estado as UpdateOwner.State.Disponible
        assertEquals(200L, disponible.manifest.versionCode)
        assertEquals("1.4.1", disponible.manifest.versionName)
        assertEquals("arregla la voz", disponible.manifest.notes)
    }

    @Test
    fun el_primer_lanzamiento_siempre_comprueba_aunque_el_intervalo_sea_cero() {
        val e = escenario(intervalo = 0L)
        assertTrue("la primera comprobación debe pasar", e.owner.comprobarAlIniciar())
        assertEquals(1, e.manifestCalls.size)
    }

    // ======================================================================
    // 3 — reanudación repetida sin consultas duplicadas
    // ======================================================================

    @Test
    fun reanudar_dentro_del_intervalo_no_genera_consultas_duplicadas() {
        val e = escenario(manifestBody = manifestJson(versionCode = 200))
        e.owner.comprobarAlIniciar()
        assertEquals("la primera comprobación siempre pasa", 1, e.manifestCalls.size)

        repeat(10) {
            e.ahora += 60_000L
            e.owner.comprobarAlReanudar()
        }
        assertEquals(
            "diez vueltas a primer plano dentro del intervalo no consultan",
            1,
            e.manifestCalls.size
        )

        e.ahora += UpdateOwner.DEFAULT_MINIMUM_CHECK_INTERVAL_MILLIS
        e.owner.comprobarAlReanudar()
        assertEquals("pasado el intervalo vuelve a comprobar", 2, e.manifestCalls.size)
    }

    @Test
    fun reanudar_y_empezar_se_comportan_igual_para_no_duplicar() {
        val e = escenario()
        e.owner.comprobarAlIniciar()
        e.ahora += 1_000L
        e.owner.comprobarAlReanudar()
        assertEquals(1, e.manifestCalls.size)
    }

    @Test
    fun reintentar_ignora_el_intervalo_porque_lo_pidio_la_persona() {
        val e = escenario()
        e.owner.comprobarAlIniciar()
        e.ahora += 1_000L
        assertTrue(e.owner.comprobarAhora())
        assertEquals(2, e.manifestCalls.size)
    }

    // ======================================================================
    // 4 — peticiones concurrentes para la misma versión
    // ======================================================================

    @Test
    fun una_descarga_ya_verificada_no_se_vuelve_a_bajar() {
        val contenido = "contenido-del-apk".toByteArray()
        val manifest = manifestFor(contenido, versionCode = 200)
        val source = MemoryApkSource(contenido)
        val e = escenario(
            manifestBody = manifestJson(
                versionCode = 200,
                sizeBytes = contenido.size.toLong(),
                sha = manifest.sha256
            ),
            apkSource = source
        )

        e.owner.comprobarAlIniciar()
        assertTrue("la primera descarga debe encolarse", e.owner.descargar())
        assertTrue(e.owner.state() is UpdateOwner.State.VerificadoParaInstalar)

        assertFalse("no debe volver a descargar lo ya verificado", e.owner.descargar())
        assertEquals("el APK se descargó una sola vez", 1, source.llamadas)
    }

    @Test
    fun comprobar_mientras_hay_una_descarga_en_vuelo_no_pisa_el_estado() {
        val contenido = "apk".toByteArray()
        val manifest = manifestFor(contenido, versionCode = 200)
        val e = escenario(
            manifestBody = manifestJson(
                versionCode = 200,
                sizeBytes = contenido.size.toLong(),
                sha = manifest.sha256
            ),
            apkSource = MemoryApkSource(contenido)
        )
        e.owner.comprobarAlIniciar()
        e.owner.descargar()
        // Tras verificar, una comprobación de la misma versión vuelve a ofrecer
        // instalar, no a volver a descargar.
        e.owner.comprobarAhora()
        val estado = e.owner.state()
        assertTrue("esperaba VerificadoParaInstalar, hubo $estado", estado is UpdateOwner.State.VerificadoParaInstalar)
    }

    // ======================================================================
    // 5, 6, 7 — descarga correcta, hash incorrecto, archivo incompleto
    // ======================================================================

    @Test
    fun una_descarga_correcta_verifica_tamano_y_hash_y_deja_el_archivo_listo() {
        val contenido = ByteArray(8192) { (it % 251).toByte() }
        val manifest = manifestFor(contenido, versionCode = 300)
        val e = escenario(
            manifestBody = manifestJson(
                versionCode = 300,
                sizeBytes = contenido.size.toLong(),
                sha = manifest.sha256
            ),
            apkSource = MemoryApkSource(contenido)
        )

        e.owner.comprobarAlIniciar()
        e.owner.descargar()

        val estado = e.owner.state()
        assertTrue("esperaba VerificadoParaInstalar, hubo $estado", estado is UpdateOwner.State.VerificadoParaInstalar)
        val apk = (estado as UpdateOwner.State.VerificadoParaInstalar).apk
        assertTrue("el archivo debe existir", apk.file.exists())
        assertEquals(contenido.size.toLong(), apk.file.length())
        assertEquals(
            "el hash del archivo debe ser el del manifiesto",
            manifest.sha256,
            UpdateDownloader.sha256Of(apk.file)
        )
        assertEquals("el nombre sale del versionCode", "apollo-300.apk", apk.file.name)
        assertEquals(300L, apk.versionCode)
    }

    @Test
    fun un_hash_que_no_cuadra_rechaza_el_archivo_y_no_lo_deja_listo() {
        val contenidoServido = "contenido-real".toByteArray()
        // El manifiesto anuncia un hash que NO es el del contenido servido.
        val falso = manifestOf(
            versionCode = 400,
            sizeBytes = contenidoServido.size.toLong(),
            sha256 = "b".repeat(64)
        )
        val e = escenario(
            manifestBody = manifestJson(
                versionCode = 400,
                sizeBytes = contenidoServido.size.toLong(),
                sha = falso.sha256
            ),
            apkSource = MemoryApkSource(contenidoServido)
        )

        e.owner.comprobarAlIniciar()
        e.owner.descargar()

        val estado = e.owner.state()
        assertTrue("un hash incorrecto no puede quedar listo: $estado", estado is UpdateOwner.State.Error)
        assertTrue((estado as UpdateOwner.State.Error).recuperable)
        assertTrue(
            "no debe quedar ningún APK listo, quedaron ${UpdateDownloader.cachedApks(e.cache)}",
            UpdateDownloader.cachedApks(e.cache).isEmpty()
        )
        assertTrue(
            "tampoco un parcial",
            File(e.cache, "updates").listFiles()?.none { it.name.endsWith(".parcial") } ?: true
        )
    }

    @Test
    fun un_archivo_incompleto_se_rechaza_por_tamano() {
        val completo = ByteArray(4096) { (it % 251).toByte() }
        val truncado = completo.copyOf(1000)
        val manifest = manifestFor(completo, versionCode = 500)
        val e = escenario(
            manifestBody = manifestJson(
                versionCode = 500,
                sizeBytes = completo.size.toLong(),
                sha = manifest.sha256
            ),
            apkSource = MemoryApkSource(truncado)
        )

        e.owner.comprobarAlIniciar()
        e.owner.descargar()

        val estado = e.owner.state()
        assertTrue("una descarga incompleta no puede quedar lista: $estado", estado is UpdateOwner.State.Error)
        assertTrue("el parcial debe borrarse", UpdateDownloader.cachedApks(e.cache).isEmpty())
        assertTrue(
            "no debe quedar ningún archivo en el directorio de descargas",
            File(e.cache, "updates").listFiles()?.isEmpty() ?: true
        )
    }

    @Test
    fun una_descarga_cancelada_no_deja_archivo_util() {
        val completo = ByteArray(2048) { 3 }
        val manifest = manifestFor(completo, versionCode = 600)
        val e = escenario(
            manifestBody = manifestJson(
                versionCode = 600,
                sizeBytes = completo.size.toLong(),
                sha = manifest.sha256
            ),
            apkSource = FailingApkSource("fallo de red")
        )
        e.owner.comprobarAlIniciar()
        e.owner.descargar()

        val estado = e.owner.state()
        assertTrue("esperaba Error, hubo $estado", estado is UpdateOwner.State.Error)
        assertTrue("un fallo de red debe ser reintentable", (estado as UpdateOwner.State.Error).recuperable)
        assertTrue("no debe quedar nada en caché", UpdateDownloader.cachedApks(e.cache).isEmpty())
    }

    // ======================================================================
    // 8 — manifiesto de otro canal
    // ======================================================================

    @Test
    fun una_app_estable_no_acepta_un_manifiesto_de_staging() {
        val e = escenario(
            manifestBody = manifestJson(channel = UpdateManifest.CHANNEL_STAGING, versionCode = 200),
            channel = UpdateManifest.CHANNEL_STABLE
        )
        e.owner.comprobarAlIniciar()
        val estado = e.owner.state()
        assertTrue(
            "un manifiesto de staging no puede ofrecerse en estable: $estado",
            estado is UpdateOwner.State.AlDia
        )
        assertFalse("no debe quedar nada descargable", e.owner.descargar())
    }

    @Test
    fun una_app_de_staging_no_acepta_un_manifiesto_de_produccion() {
        val e = escenario(
            manifestBody = manifestJson(channel = UpdateManifest.CHANNEL_STABLE, versionCode = 200),
            channel = UpdateManifest.CHANNEL_STAGING
        )
        e.owner.comprobarAlIniciar()
        assertTrue(
            "un manifiesto de producción no puede ofrecerse en staging: ${e.owner.state()}",
            e.owner.state() is UpdateOwner.State.AlDia
        )
        assertFalse(e.owner.descargar())
    }

    // ======================================================================
    // 9 — APK obsoleto o con versionCode incorrecto
    // ======================================================================

    @Test
    fun una_version_igual_o_menor_a_la_instalada_no_se_ofrece() {
        for (versionCode in listOf(50L, 100L)) {
            val e = escenario(manifestBody = manifestJson(versionCode = versionCode))
            e.owner.comprobarAlIniciar()
            assertTrue(
                "versionCode $versionCode no debe ofrecerse sobre 100: ${e.owner.state()}",
                e.owner.state() is UpdateOwner.State.AlDia
            )
        }
    }

    @Test
    fun un_cliente_mas_viejo_que_el_minimo_no_recibe_la_actualizacion() {
        val cuerpo = manifestJson(versionCode = 200).replace(
            "\"minSdk\": 25",
            "\"minSdk\": 25, \"minClientVersionCode\": 500"
        )
        val e = escenario(manifestBody = cuerpo, installedVersionCode = 100)
        e.owner.comprobarAlIniciar()
        assertTrue(
            "un cliente por debajo del mínimo no puede instalar: ${e.owner.state()}",
            e.owner.state() is UpdateOwner.State.AlDia
        )
    }

    @Test
    fun un_manifiesto_que_exige_un_android_mas_nuevo_no_se_ofrece() {
        val e = escenario(manifestBody = manifestJson(versionCode = 200, minSdkInt = 99))
        e.owner.comprobarAlIniciar()
        assertTrue(
            "un APK que exige Android 99 no se ofrece en un API 34: ${e.owner.state()}",
            e.owner.state() is UpdateOwner.State.AlDia
        )
    }

    // ======================================================================
    // 10 — reutilización accidental de otro APK en caché
    // ======================================================================

    @Test
    fun descargar_limpia_los_apk_de_otras_versiones_para_no_reusarlos() {
        val contenido = ByteArray(3000) { 9 }
        val manifest = manifestFor(contenido, versionCode = 700)
        val e = escenario(
            manifestBody = manifestJson(
                versionCode = 700,
                sizeBytes = contenido.size.toLong(),
                sha = manifest.sha256
            ),
            apkSource = MemoryApkSource(contenido)
        )

        // Se planta un APK viejo, más reciente por fecha, como el que el
        // antiguo `latestDownloadedApk()` habría elegido por error.
        val directorio = File(e.cache, "updates").apply { mkdirs() }
        val apogo = File(directorio, "apollo-100.apk")
        apogo.writeText("apk obsoleto")
        apogo.setLastModified(System.currentTimeMillis() + 60_000L)

        e.owner.comprobarAlIniciar()
        e.owner.descargar()

        val estado = e.owner.state()
        assertTrue(estado is UpdateOwner.State.VerificadoParaInstalar)
        val elegido = (estado as UpdateOwner.State.VerificadoParaInstalar).apk.file
        assertEquals("el APK elegido es el de la versión 700", "apollo-700.apk", elegido.name)
        assertFalse(
            "el APK obsoleto debe haberse borrado, no quedar a mano",
            apogo.exists()
        )
    }

    @Test
    fun el_instalador_recibe_el_archivo_exacto_que_se_verifico() {
        val contenido = ByteArray(2500) { 11 }
        val manifest = manifestFor(contenido, versionCode = 800)
        val e = escenario(
            manifestBody = manifestJson(
                versionCode = 800,
                sizeBytes = contenido.size.toLong(),
                sha = manifest.sha256
            ),
            apkSource = MemoryApkSource(contenido)
        )
        e.owner.comprobarAlIniciar()
        e.owner.descargar()

        val verificado = (e.owner.state() as UpdateOwner.State.VerificadoParaInstalar).apk

        // Un intruso con fecha más nueva no puede ser el que se instale.
        val directorio = File(e.cache, "updates")
        val intruso = File(directorio, "apollo-900.apk")
        intruso.writeText("no autorizado")
        intruso.setLastModified(System.currentTimeMillis() + 120_000L)

        val resultado = e.service.openInstaller(verificado)
        assertTrue("esperaba ListoParaInstalar, hubo $resultado", resultado is UpdateService.Outcome.ListoParaInstalar)
        val recibido = e.installer.apKsRecibidos.single()
        assertEquals(
            "el instalador debe recibir el archivo verificado, no el más nuevo",
            verificado.file.absolutePath,
            recibido.file.absolutePath
        )
        assertEquals(800L, recibido.versionCode)
    }

    @Test
    fun si_el_archivo_cambio_despues_de_verificar_no_se_abre_el_instalador() {
        val contenido = ByteArray(1500) { 13 }
        val manifest = manifestFor(contenido, versionCode = 850)
        val e = escenario(
            manifestBody = manifestJson(
                versionCode = 850,
                sizeBytes = contenido.size.toLong(),
                sha = manifest.sha256
            ),
            apkSource = MemoryApkSource(contenido)
        )
        e.owner.comprobarAlIniciar()
        e.owner.descargar()
        val verificado = (e.owner.state() as UpdateOwner.State.VerificadoParaInstalar).apk

        // Alguien modifica el APK entre la descarga y la instalación.
        verificado.file.writeText("contenido alterado")

        val resultado = e.service.openInstaller(verificado)
        assertTrue(
            "un archivo alterado no puede abrir el instalador: $resultado",
            resultado is UpdateService.Outcome.Error
        )
        assertTrue("el instalador no debe haberse invocado", e.installer.apKsRecibidos.isEmpty())
        assertFalse("el archivo alterado debe borrarse", verificado.file.exists())
    }

    // ======================================================================
    // 11 y 12 — permiso concedido y permiso denegado
    // ======================================================================

    @Test
    fun con_el_permiso_concedido_el_instalador_se_abre() {
        val e = escenarioConApkListo(versionCode = 1000)
        e.installer.permisoConcedido = true
        val resultado = e.service.openInstaller(apkDe(e, 1000))
        assertTrue("esperaba ListoParaInstalar, hubo $resultado", resultado is UpdateService.Outcome.ListoParaInstalar)
        assertEquals(1, e.installer.apKsRecibidos.size)
    }

    @Test
    fun sin_el_permiso_no_se_abre_el_instalador_y_se_avisa() {
        val e = escenarioConApkListo(versionCode = 1100)
        e.installer.permisoConcedido = false
        val resultado = e.service.openInstaller(apkDe(e, 1100))
        assertTrue(
            "sin permiso debe pedirlo, no instalar: $resultado",
            resultado is UpdateService.Outcome.FaltaPermisoDeInstalacion
        )
        assertTrue("el instalador no debe invocarse", e.installer.apKsRecibidos.isEmpty())
        assertTrue(
            "el mensaje debe explicar qué habilitar",
            e.service.explainMissingPermission().contains("desconocidas")
        )
    }

    @Test
    fun el_permiso_pendiente_no_impide_que_se_muestre_el_estado() {
        val e = escenarioConApkListo(versionCode = 1200)
        e.installer.permisoConcedido = false
        e.owner.comprobarPermisoDeInstalacion(concedido = false)
        assertTrue(
            "la UI debe poder ofrecer abrir los ajustes del sistema",
            e.owner.state() is UpdateOwner.State.FaltaPermisoDeInstalacion
        )
    }

    // ======================================================================
    // 13 y 14 — cancelación y regreso tras instalar
    // ======================================================================

    @Test
    fun cancelar_la_instalacion_no_se_reporta_como_instalada() {
        // El helper ya dejó el APK descargado y verificado.
        val e = escenarioConApkListo(versionCode = 1300)
        val verificado = apkDe(e, 1300)
        // Se abrió el instalador.
        assertTrue(e.service.openInstaller(verificado) is UpdateService.Outcome.ListoParaInstalar)
        e.owner.alVolverDelInstalador()

        // La persona canceló: el versionCode instalado sigue siendo el viejo.
        assertTrue(
            "cancelar no puede terminar en 'al día': ${e.owner.state()}",
            e.owner.state() is UpdateOwner.State.Error
        )
        assertFalse("el APK obsoleto no debe quedar reutilizable", verificado.file.exists())
    }

    @Test
    fun al_veces_de_una_instalacion_real_se_actualiza_el_estado() {
        val e = escenarioConApkListo(versionCode = 1400)
        val verificado = apkDe(e, 1400)
        e.service.openInstaller(verificado)

        // El sistema instaló de verdad: el versionCode instalado ya es el nuevo.
        e.installer.installedVersionCode = 1400L
        e.owner.alVolverDelInstalador()

        assertTrue(
            "instalada de verdad debe quedar al día: ${e.owner.state()}",
            e.owner.state() is UpdateOwner.State.AlDia
        )
        assertFalse("el APK instalado debe liberarse", verificado.file.exists())
    }

    @Test
    fun abrir_el_instalador_no_afirma_que_se_instalo() {
        val e = escenarioConApkListo(versionCode = 1500)
        e.owner.comprobarAlIniciar()
        e.owner.descargar()
        val verificado = (e.owner.state() as UpdateOwner.State.VerificadoParaInstalar).apk
        e.service.openInstaller(verificado)

        // Todavía no se volvió: el estado no puede ser "instalada".
        val estadoAntesDeVolver = e.owner.state()
        assertFalse(
            "no se puede declarar instalada antes de volver: $estadoAntesDeVolver",
            estadoAntesDeVolver is UpdateOwner.State.AlDia
        )
        assertTrue(
            "el APK sigue pendiente hasta volver",
            UpdateDownloader.cachedApks(e.cache).any { it.name == "apollo-1500.apk" }
        )
    }

    // ======================================================================
    // 15 — conservación de datos y sesión
    // ======================================================================

    @Test
    fun la_descarga_no_toca_los_datos_de_la_app() {
        val e = escenarioConApkListo(versionCode = 1600)
        // Un archivo de preferencias o sesión, fuera del directorio de descargas.
        val sessionFile = File(e.cache, "apollo_mobile_preferences.xml")
        sessionFile.parentFile.mkdirs()
        sessionFile.writeText("session=abc123")

        e.owner.comprobarAlIniciar()
        e.owner.descargar()

        assertTrue("las preferencias deben seguir ahí", sessionFile.exists())
        assertTrue("y con su contenido", sessionFile.readText().contains("abc123"))
        assertNotNull(
            "debe haber un APK verificado, separado de los datos",
            UpdateDownloader.cachedApks(e.cache).firstOrNull()
        )
        // El APK vive en su propio subdirectorio: nunca encima de las
        // preferencias, y el sistema puede limpiar la caché sin tocar la sesión.
        assertTrue(
            "el APK debe estar en cache/updates",
            UpdateDownloader.cachedApks(e.cache).all { it?.parentFile?.name == "updates" }
        )
    }

    // ======================================================================
    // 16 — compatibilidad con las APIs mínimas admitidas
    // ======================================================================

    @Test
    fun el_canal_de_esta_build_es_explicito_y_no_se_infiere_del_host() {
        // El canal sale del `BuildConfig` que fija el flavor, no de buscar
        // texto dentro de una URL. Cualquier valor reconocido se devuelve tal
        // cual; lo que no se reconoce cae a `stable`, el destino conservador.
        val esperado = if (com.apollo.mobile.BuildConfig.UPDATE_CHANNEL == UpdateManifest.CHANNEL_STAGING) {
            UpdateManifest.CHANNEL_STAGING
        } else {
            UpdateManifest.CHANNEL_STABLE
        }
        assertEquals(esperado, UpdateManifest.channelOfThisBuild())
        assertTrue(
            "el canal debe ser uno de los dos conocidos",
            UpdateManifest.channelOfThisBuild() in listOf(
                UpdateManifest.CHANNEL_STABLE,
                UpdateManifest.CHANNEL_STAGING
            )
        )
    }

    /**
     * FASE 3.6 — el paquete y el canal de ESTA variante.
     *
     * Corre en las cuatro variantes (`stableDebug`, `stableRelease`,
     * `stagingDebug`, `stagingRelease`), así que la misma prueba afirma las dos
     * identidades: producción debe ser `com.apollo.mobile` con canal `stable`, y
     * staging `com.apollo.mobile.staging` con canal `staging`.
     *
     * El paquete real se toma de `BuildConfig.APPLICATION_ID`, que AGP genera
     * con el `applicationId` ya combinado con el sufijo del flavor: no hay forma
     * de que el test y el APK discrepen.
     */
    @Test
    fun el_paquete_y_el_canal_de_esta_variante_son_del_mismo_canal() {
        val canal = UpdateManifest.channelOfThisBuild()
        val paquete = com.apollo.mobile.BuildConfig.APPLICATION_ID
        val esStaging = canal == UpdateManifest.CHANNEL_STAGING

        assertEquals(
            "el canal compilado debe ser el del flavor",
            if (esStaging) UpdateManifest.CHANNEL_STAGING else UpdateManifest.CHANNEL_STABLE,
            canal
        )
        assertEquals(
            "el paquete debe ser el del canal: un APK de staging publicado como estable rompería el aislamiento",
            if (esStaging) "com.apollo.mobile.staging" else "com.apollo.mobile",
            paquete
        )
        assertEquals(
            "staging no puede llevar el paquete de producción",
            esStaging,
            paquete.endsWith(".staging")
        )
    }

    @Test
    fun produccion_no_trae_sufijo_de_variante_en_su_paquete() {
        // El caso exacto que rompe actualizaciones: si producción saliera con
        // sufijo, las instalaciones reales de `com.apollo.mobile` dejarían de
        // recibir actualizaciones.
        val paquete = com.apollo.mobile.BuildConfig.APPLICATION_ID
        if (UpdateManifest.channelOfThisBuild() == UpdateManifest.CHANNEL_STABLE) {
            assertFalse(
                "producción debe conservar exactamente com.apollo.mobile, no $paquete",
                paquete != "com.apollo.mobile"
            )
        }
    }

    @Test
    fun cada_canal_consulta_su_propio_endpoint_y_son_distintos() {
        val estable = UpdateManifest.manifestUrlFor(UpdateManifest.CHANNEL_STABLE)
        val staging = UpdateManifest.manifestUrlFor(UpdateManifest.CHANNEL_STAGING)
        assertTrue("estable va a releases/latest: $estable", estable.contains("releases/latest/download"))
        assertTrue("staging va a su etiqueta: $staging", staging.contains("releases/download/staging"))
        assertFalse("los endpoints no pueden ser el mismo", estable == staging)
        assertTrue(estable.startsWith("https://"))
        assertTrue(staging.startsWith("https://"))
    }

    @Test
    fun el_manifesto_se_pide_por_https_y_un_url_inseguro_se_rechaza() {
        val cache = nuevoCache()
        val servicioInseguro = UpdateService(
            installer = FakeInstaller(cache),
            manifestUrl = "http://ejemplo.invalid/android.json",
            appChannel = UpdateManifest.CHANNEL_STABLE,
            manifestFetcher = { manifestJson(versionCode = 200) },
            ioDispatcher = Dispatchers.Unconfined,
            deviceSdkIntProvider = { 34 }
        )
        val resultado = kotlinx.coroutines.runBlocking { servicioInseguro.check() }
        assertTrue("un manifiesto http no se consulta: $resultado", resultado is UpdateService.Outcome.Error)
        assertFalse("y no debe ser recuperable", (resultado as UpdateService.Outcome.Error).recuperable)
    }

    @Test
    fun un_fallo_de_red_al_consultar_el_manifesto_es_reintentable() {
        val e = escenario(manifestFailure = "sin red")
        e.owner.comprobarAlIniciar()
        val estado = e.owner.state()
        assertTrue("esperaba Error, hubo $estado", estado is UpdateOwner.State.Error)
        assertTrue("sin red debe poder reintentarse", (estado as UpdateOwner.State.Error).recuperable)
        assertFalse(e.owner.descargar())
    }

    @Test
    fun un_manifiesto_malformado_no_se_trata_como_actualizacion() {
        val e = escenario(manifestBody = "{ esto no es json")
        e.owner.comprobarAlIniciar()
        val estado = e.owner.state()
        assertTrue("esperaba Error, hubo $estado", estado is UpdateOwner.State.Error)
        assertFalse("no debe poder descargarse", e.owner.descargar())
    }

    // ----------------------------------------------------------------------
    // Escenario con un APK ya descargado y verificado.
    // ----------------------------------------------------------------------

    private fun escenarioConApkListo(versionCode: Long): Escenario {
        val contenido = ByteArray(2048) { (it % 97).toByte() }
        val manifest = manifestFor(contenido, versionCode = versionCode)
        val e = escenario(
            manifestBody = manifestJson(
                versionCode = versionCode,
                sizeBytes = contenido.size.toLong(),
                sha = manifest.sha256
            ),
            apkSource = MemoryApkSource(contenido),
            installedVersionCode = 100L
        )
        e.owner.comprobarAlIniciar()
        e.owner.descargar()
        return e
    }

    private fun apkDe(e: Escenario, versionCode: Long): UpdateDownloader.VerifiedApk {
        val estado = e.owner.state()
        assertTrue("el APK de $versionCode debería estar verificado: $estado", estado is UpdateOwner.State.VerificadoParaInstalar)
        val apk = (estado as UpdateOwner.State.VerificadoParaInstalar).apk
        assertEquals(versionCode, apk.versionCode)
        return apk
    }
}
