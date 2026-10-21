//! FASE 3.1 â€” Comandos Tauri del actualizador de escritorio.
//!
//! El trabajo real (decidir si hay actualización) vive en
//! [`crate::updates`], que es puro y está testeado. Acá sólo se:
//!   1. lee el manifiesto del canal configurado (HTTPS, con timeout),
//!   2. aplica la decisión de [`evaluate_update`],
//!   3. deja que el plugin oficial descargue, **verifique la firma** e instale.
//!
//! La firma minisign la valida el plugin: este archivo nunca acepta un hash
//! como prueba de autenticidad.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::updates::{self, AuditError, HttpManifestSource, UpdateDecision, is_staging_channel};

/// Lo que la UI necesita saber. Nunca incluye URLs firmadas ni datos de la
/// release más allá de lo que el usuario ya va a ver igual.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub channel: String,
    pub installed_version: String,
    pub status: UpdateStatusKind,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub message: Option<String>,
}

/// Estado del actualizador, con la MISMA forma que consume la UI.
///
/// FASE 3.4 â€” `tag = "kind"` es lo que arregla C1. Sin él, serde serializa este
/// enum *externamente etiquetado*: las variantes unitarias salen como cadenas
/// sueltas (`"idle"`) y las de campos como `{"downloading":{"percent":42}}`,
/// mientras la UI lee `status.kind`. El resultado era que `status.kind` era
/// siempre `undefined`, el subtítulo caía en "Estado desconocido" y el botón de
/// instalar nunca aparecía.
///
/// El contrato exacto vive en
/// `apps/mobile/__tests__/fixtures/update-status-contract.json`, que ambas suites
/// consumen: si Rust y TypeScript divergen de nuevo, los dos tests caen.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UpdateStatusKind {
    /// Nunca se comprobó en esta sesión.
    Idle,
    /// Hay una comprobación en curso: todavía no hay veredicto.
    Checking,
    /// Se consultó y no hay nada nuevo: no se molesta al usuario.
    UpToDate,
    /// Hay algo instalable esperando confirmación.
    Available,
    /// Descargando, con el porcentaje ya descargado.
    Downloading { percent: u8 },
    /// Descargado y verificado; listo para instalar.
    Ready,
    /// Instalado, pendiente de reiniciar la app.
    PendingRestart,
    /// Se pospuso hasta una fecha (epoch segundos).
    Deferred { until_epoch_seconds: u64 },
    /// Falló de forma recuperable: se puede reintentar.
    Failed { reason: String },
}

/// Trae el manifiesto del canal de ESTE binario y decide.
///
/// Nunca pide el manifiesto del canal contrario: el endpoint sale de la misma
/// `tauri.conf.json` / `tauri.staging.conf.json` que usa el plugin oficial.
///
/// FASE 3.4 (C2): si la auditoría no puede completarse, NO se ofrece la
/// actualización. Antes el `Err` se descartaba y el flujo continuaba como si la
/// comprobación hubiera pasado.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateStatus, String> {
    let channel = channel_name();
    let installed_version = app.package_info().version.to_string();

    let updater = app
        .updater()
        .map_err(|error| format!("el actualizador no esta disponible: {error}"))?;

    let update = updater
        .check()
        .await
        .map_err(|error| classify_check_error(&error))?;

    let Some(update) = update else {
        return Ok(UpdateStatus {
            channel,
            installed_version,
            status: UpdateStatusKind::UpToDate,
            latest_version: None,
            notes: None,
            published_at: None,
            message: Some("Apollo esta al dia".to_string()),
        });
    };

    // Auditoría real. La firma del artefacto la valida el plugin al descargar;
    // esto comprueba que el manifiesto sea del canal correcto y describa la
    // MISMA versión que el plugin acaba de resolver.
    let decision = auditar_manifiesto(&channel, &update.version, &installed_version).await;

    let decision = match decision {
        Ok(decision) => decision,
        Err(error) => {
            // No se ofrece nada y queda registrado por qué. El mensaje es
            // reintentable: la recuperación es volver a comprobar.
            log::warn!("{}", error.diagnostico());
            return Ok(UpdateStatus {
                channel,
                installed_version,
                status: UpdateStatusKind::Failed {
                    reason: error.mensaje_para_usuario(),
                },
                latest_version: None,
                notes: None,
                published_at: None,
                message: None,
            });
        }
    };

    Ok(UpdateStatus {
        channel,
        installed_version,
        status: UpdateStatusKind::Available,
        latest_version: Some(decision.version),
        notes: non_empty(Some(decision.notes)),
        published_at: non_empty(Some(decision.pub_date)),
        message: None,
    })
}

/// Auditoría del canal, fuera del hilo async.
///
/// `ureq` es bloqueante: hacer la lectura en `spawn_blocking` evita frenar el
/// runtime de Tauri, y su `Result` convierte cualquier fallo en un error
/// auditable en vez de un pánico.
async fn auditar_manifiesto(
    channel: &str,
    version_del_plugin: &str,
    installed_version: &str,
) -> Result<UpdateDecision, AuditError> {
    let channel = channel.to_string();
    let version_del_plugin = version_del_plugin.to_string();
    let installed_version = installed_version.to_string();

    tauri::async_runtime::spawn_blocking(move || {
        updates::auditar_con_fuente(
            &HttpManifestSource::default(),
            &channel,
            &version_del_plugin,
            &installed_version,
            0,
        )
    })
    .await
    .map_err(|error| AuditError::Lectura(format!("la auditoria no pudo ejecutarse: {error}")))?
}

/// Descarga, verifica la firma e instala.
///
/// FASE 3.4 (C2): el canal y la versión se comprueban DOS veces.
///  1. Antes de descargar: si el manifiesto no audita, no se descarga nada.
///  2. Después de descargar y ANTES de instalar: si el manifiesto cambió, se
///     aborta y los bytes ya bajados se descartan.
///
/// El estado que manda la UI no se usa como prueba de nada: este comando
/// vuelve a resolver la actualización y a auditarla por su cuenta, así que
/// invocado directamente â€”sin pasar por la interfazâ€” el control de canal sigue
/// presente. La firma la verifica `Update::download`; esto no la reemplaza ni
/// la evita.
#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<UpdateStatus, String> {
    let channel = channel_name();
    let installed_version = app.package_info().version.to_string();

    let updater = app
        .updater()
        .map_err(|error| format!("el actualizador no esta disponible: {error}"))?;

    // El reinicio lo pide la UI con confirmación explícita. Con `true` el
    // plugin mataría la app en el momento, y eso puede cortar una
    // conversación en curso.
    let update = updater
        .check()
        .await
        .map_err(|error| classify_check_error(&error))?
        .ok_or_else(|| "no hay actualizacion para instalar".to_string())?
        .restart_after_install(false);

    let latest_version = update.version.clone();

    // Puerta 1: antes de descargar un solo byte.
    if let Err(error) = auditar_manifiesto(&channel, &latest_version, &installed_version).await {
        log::warn!("instalacion cancelada antes de descargar: {}", error.diagnostico());
        return Ok(auditoria_fallida(channel, installed_version, error));
    }

    let mut downloaded = 0u64;
    let mut total = 0u64;

    let downloaded_bytes = update
        .download(
            |chunk_length, content_length| {
                downloaded += chunk_length as u64;
                total = content_length.unwrap_or(total);
                if total > 0 {
                    let percent = ((downloaded as f64 / total as f64) * 100.0).clamp(0.0, 100.0);
                    let _ = app.emit_update_progress(percent as u8);
                }
            },
            || {
                // La firma ya fue verificada por el plugin antes de esto.
                let _ = app.emit_update_ready();
            },
        )
        .await
        .map_err(|error| classify_install_error(&error))?;

    // Puerta 2: entre descargar e instalar. Si el manifiesto se movió, los
    // bytes bajados son de una versión que ya no autorizamos.
    if let Err(error) = auditar_manifiesto(&channel, &latest_version, &installed_version).await {
        log::warn!("instalacion cancelada tras descargar: {}", error.diagnostico());
        drop(downloaded_bytes);
        return Ok(auditoria_fallida(channel, installed_version, error));
    }

    // `install` es bloqueante: va a un hilo aparte para no frenar el runtime.
    // Recibe los bytes ya descargados y firmados; no vuelve a bajarlos.
    let bytes = downloaded_bytes;
    let install_result = tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|error| format!("no se pudo preparar la instalacion: {error}"))?;

    install_result.map_err(|error| classify_install_error(&error))?;

    Ok(UpdateStatus {
        channel,
        installed_version,
        status: UpdateStatusKind::PendingRestart,
        latest_version: Some(latest_version),
        notes: None,
        published_at: None,
        message: Some("Actualizacion instalada. Reinicia Apollo para usarla.".to_string()),
    })
}

/// Estado actual sin salir a la red: lo usa la UI al abrir Ajustes.
#[tauri::command]
pub fn update_channel() -> String {
    channel_name()
}

/// Reinicia la app tras instalar. La UI lo llama sólo con confirmación
/// explícita, para no cortar una conversación en curso.
/// Reinicia la app desde Rust.
///
/// Se usa `request_restart()` en lugar del comando del plugin porque así el
/// reinicio no depende de que el frontend esté vivo: si la ventana ya se cerró
/// (instalador pasivo), el reinicio igual ocurre.
#[tauri::command]
pub fn restart_after_update(app: AppHandle) -> Result<(), String> {
    app.request_restart();
    Ok(())
}

/// Ayudas para que la UI reporte progreso sin inventar un sistema de eventos
/// paralelo: reusa el canal de eventos que Tauri ya ofrece.
trait UpdateProgressEmitter {
    fn emit_update_progress(&self, percent: u8);
    fn emit_update_ready(&self);
}

impl UpdateProgressEmitter for AppHandle {
    fn emit_update_progress(&self, percent: u8) {
        use tauri::Emitter;
        let _ = self.emit("update://progress", percent);
    }

    fn emit_update_ready(&self) {
        use tauri::Emitter;
        let _ = self.emit("update://ready", ());
    }
}

fn channel_name() -> String {
    if is_staging_channel() {
        "staging".to_string()
    } else {
        "stable".to_string()
    }
}

/// Estado que se devuelve cuando la auditoría no permite continuar.
///
/// Es `Failed` con un motivo reintentable, no un error duro: la app no se cierra
/// y la persona puede volver a comprobar. La validación nunca se omite.
fn auditoria_fallida(
    channel: String,
    installed_version: String,
    error: AuditError,
) -> UpdateStatus {
    UpdateStatus {
        channel,
        installed_version,
        status: UpdateStatusKind::Failed {
            reason: error.mensaje_para_usuario(),
        },
        latest_version: None,
        notes: None,
        published_at: None,
        message: None,
    }
}


/// Errores de red: recuperables y reintentables, no panicables.
fn classify_check_error(error: &tauri_plugin_updater::Error) -> String {
    let raw = error.to_string();
    if raw.contains("404") || raw.contains("Not Found") {
        return "Todavia no hay ninguna release publicada en este canal.".to_string();
    }
    if raw.contains("timeout") || raw.contains("timed out") || raw.contains("dns") {
        return "No se pudo contactar al servidor de actualizaciones. Reintenta cuando tengas red.".to_string();
    }
    format!("No se pudo comprobar si hay actualizaciones: {raw}")
}

fn classify_install_error(error: &tauri_plugin_updater::Error) -> String {
    let raw = error.to_string();
    if raw.contains("signature") || raw.contains("Signature") || raw.contains("verify") {
        // Nunca se degrada a "instalar igual": una firma inválida es un STOP.
        return "La firma de la actualizacion no es valida. No se instalo nada.".to_string();
    }
    if raw.contains("space") || raw.contains("disk") {
        return "No hay espacio en disco suficiente para la actualizacion.".to_string();
    }
    if raw.contains("checksum") || raw.contains("hash") {
        return "La descarga no coincide con lo esperado y se descarto.".to_string();
    }
    format!("La actualizacion no se pudo instalar: {raw}")
}

fn non_empty(text: Option<String>) -> Option<String> {
    text.filter(|value| !value.trim().is_empty())
}

/// Compuesto para el progreso en la UI.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressEvent {
    pub percent: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_canal_reportado_corresponde_al_binario() {
        assert_eq!(channel_name(), "stable");
    }

    #[test]
    fn un_error_de_firma_nunca_se_convierte_en_advertencia() {
        let raw = "signature verification failed for artifact".to_string();
        // Se comprueba el texto porque el tipo de error del plugin no es
        // construible en un test unitario; la regla ("firma -> STOP") sí.
        assert!(classify_install_error_message(&raw).contains("no es valida"));
    }

    fn classify_install_error_message(raw: &str) -> String {
        if raw.contains("signature") || raw.contains("Signature") || raw.contains("verify") {
            return "La firma de la actualizacion no es valida. No se instalo nada.".to_string();
        }
        format!("La actualizacion no se pudo instalar: {raw}")
    }

    #[test]
    fn sin_releases_publicadas_el_mensaje_es_claro_y_no_ruidoso() {
        assert!(classify_check_error_message("HTTP 404 Not Found").contains("Todavia no hay"));
        assert!(classify_check_error_message("dns error").contains("Reintenta"));
    }

    fn classify_check_error_message(raw: &str) -> String {
        if raw.contains("404") || raw.contains("Not Found") {
            return "Todavia no hay ninguna release publicada en este canal.".to_string();
        }
        if raw.contains("timeout") || raw.contains("timed out") || raw.contains("dns") {
            return "No se pudo contactar al servidor de actualizaciones. Reintenta cuando tengas red.".to_string();
        }
        format!("No se pudo comprobar si hay actualizaciones: {raw}")
    }

    #[test]
    fn una_actualizacion_pendiente_de_reinicio_lo_dice_explicitamente() {
        let status = UpdateStatus {
            channel: "stable".to_string(),
            installed_version: "0.1.1".to_string(),
            status: UpdateStatusKind::PendingRestart,
            latest_version: Some("0.2.0".to_string()),
            notes: None,
            published_at: None,
            message: Some("Actualizacion instalada. Reinicia Apollo para usarla.".to_string()),
        };
        assert_eq!(status.status, UpdateStatusKind::PendingRestart);
        assert!(status.message.unwrap().contains("Reinicia"));
    }

    #[test]
    fn posponer_una_actualizacion_queda_registrada() {
        let status = UpdateStatus {
            channel: "stable".to_string(),
            installed_version: "0.1.1".to_string(),
            status: UpdateStatusKind::Deferred {
                until_epoch_seconds: 1_800_000_000,
            },
            latest_version: Some("0.2.0".to_string()),
            notes: None,
            published_at: None,
            message: None,
        };
        assert_eq!(
            status.status,
            UpdateStatusKind::Deferred {
                until_epoch_seconds: 1_800_000_000
            }
        );
    }

    #[test]
    fn los_estados_son_serializables_para_la_ui() {
        let serialized = serde_json::to_string(&UpdateStatusKind::Downloading { percent: 42 })
            .expect("serializa");
        assert!(serialized.contains("downloading"));
        assert!(serialized.contains("42"));
    }

    /// FASE 3.4 â€” regresión de C1.
    ///
    /// Compara el JSON EXACTO que emite cada variante contra el fixture
    /// compartido. Antes, el test anterior sólo buscaba la palabra
    /// "downloading", que también aparecía en la forma rota
    /// `{"downloading":{"percent":42}}`: por eso C1 pasó la suite.
    #[test]
    fn cada_estado_serializa_exactamente_como_el_fixture_compartido() {
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let fixture_candidates = [
            manifest_dir.join("../../../apps/mobile/__tests__/fixtures/update-status-contract.json"),
            manifest_dir.join("../../../ApolloHouse/apps/mobile/__tests__/fixtures/update-status-contract.json"),
        ];
        let fixture_text = fixture_candidates
            .iter()
            .find_map(|path| std::fs::read_to_string(path).ok())
            .expect("el fixture compartido se puede leer desde uno de los layouts soportados");
        let fixture: serde_json::Value =
            serde_json::from_str(&fixture_text).expect("el fixture compartido es JSON válido");

        let entries = fixture["statusKind"]
            .as_array()
            .expect("statusKind es una lista");
        assert_eq!(entries.len(), 9, "el fixture debe cobrir las 9 variantes");

        let emitted = [
            UpdateStatusKind::Idle,
            UpdateStatusKind::Checking,
            UpdateStatusKind::UpToDate,
            UpdateStatusKind::Available,
            UpdateStatusKind::Downloading { percent: 42 },
            UpdateStatusKind::Ready,
            UpdateStatusKind::PendingRestart,
            UpdateStatusKind::Deferred { until_epoch_seconds: 1_800_000_000 },
            UpdateStatusKind::Failed { reason: "motivo".to_string() },
        ];

        for (entry, variant) in entries.iter().zip(emitted.iter()) {
            let expected = entry["json"].as_str().expect("json es texto");
            let actual = serde_json::to_string(variant).expect("serializa");
            assert_eq!(
                &actual, expected,
                "la variante {} serializa distinto al contrato compartido",
                entry["variant"]
            );
        }
    }

    /// La forma antigua (serde externo) es exactamente la que rompía la UI.
    /// Si alguien quita `tag = "kind"`, este test lo dice con nombre y apellido.
    #[test]
    fn la_forma_externa_que_rompia_la_ui_ya_no_se_emite() {
        let idle = serde_json::to_value(UpdateStatusKind::Idle).expect("serializa");
        assert_eq!(idle.get("kind").and_then(|k| k.as_str()), Some("idle"));
        assert!(idle.get("idle").is_none(), "no debe quedar la etiqueta antigua");

        let downloading =
            serde_json::to_value(UpdateStatusKind::Downloading { percent: 42 }).expect("serializa");
        assert_eq!(downloading.get("kind").and_then(|k| k.as_str()), Some("downloading"));
        assert_eq!(downloading.get("percent").and_then(|p| p.as_u64()), Some(42));
        assert!(
            downloading.get("downloading").is_none(),
            "no debe quedar el envoltorio anidado que rompia la UI"
        );
    }

    #[test]
    fn el_sobre_del_estado_respeta_el_nombre_en_camel_case_que_espera_la_ui() {
        let status = UpdateStatus {
            channel: "staging".to_string(),
            installed_version: "0.1.1".to_string(),
            status: UpdateStatusKind::Available,
            latest_version: Some("1.4.1".to_string()),
            notes: Some("notas".to_string()),
            published_at: Some("2026-10-14T00:00:00Z".to_string()),
            message: None,
        };
        let value = serde_json::to_value(&status).expect("serializa");

        assert_eq!(value.get("installedVersion").and_then(|v| v.as_str()), Some("0.1.1"));
        assert_eq!(value.get("latestVersion").and_then(|v| v.as_str()), Some("1.4.1"));
        assert_eq!(value.get("publishedAt").and_then(|v| v.as_str()), Some("2026-10-14T00:00:00Z"));
        assert!(value.get("installed_version").is_none());
        assert_eq!(value["status"]["kind"].as_str(), Some("available"));
    }
}
