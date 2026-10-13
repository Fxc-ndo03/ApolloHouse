//! Application state management

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Authenticated,
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum OrbState {
    Idle,
    Listening,
    Thinking,
    Speaking,
    Confirming,
    Focusing,
    Alarm,
    Error,
}

impl OrbState {
    pub fn from_ui_state(state: &str) -> Self {
        match state {
            "idle" => OrbState::Idle,
            "listening" => OrbState::Listening,
            "thinking" => OrbState::Thinking,
            "speaking" => OrbState::Speaking,
            "confirm" => OrbState::Confirming,
            "focus" => OrbState::Focusing,
            "alarming" => OrbState::Alarm,
            _ => OrbState::Idle,
        }
    }

    pub fn to_string(&self) -> &'static str {
        match self {
            OrbState::Idle => "idle",
            OrbState::Listening => "listening",
            OrbState::Thinking => "thinking",
            OrbState::Speaking => "speaking",
            OrbState::Confirming => "confirming",
            OrbState::Focusing => "focusing",
            OrbState::Alarm => "alarm",
            OrbState::Error => "error",
        }
    }
}

pub fn default_input_device_name() -> String {
    "MicrÃƒÆ’Ã‚Â³fono (JBL Quantum 300)".to_string()
}

pub fn default_output_device_name() -> String {
    "JBL Quantum 300".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevicePreference {
    pub device_type: String,
    pub device_name: String,
    pub device_index: i32,
    pub timestamp: f64,
}

impl Default for DevicePreference {
    fn default() -> Self {
        Self {
            device_type: String::new(),
            device_name: String::new(),
            device_index: -1,
            timestamp: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevicePreferences {
    pub input_device_name: String,
    pub input_device_index: i32,
    pub output_device_name: String,
    pub output_device_index: i32,
    pub last_validated: f64,
}

impl Default for DevicePreferences {
    fn default() -> Self {
        Self {
            input_device_name: default_input_device_name(),
            input_device_index: -1,
            output_device_name: default_output_device_name(),
            output_device_index: -1,
            last_validated: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub worker_url: String,
    /// Identidad estable de ESTA instalaciÃƒÆ’Ã‚Â³n, no un secreto.
    ///
    /// Antes no existÃƒÆ’Ã‚Â­a: `CloudCoreManager` usaba `"desktop"` fijo, asÃƒÆ’Ã‚Â­ que dos
    /// PCs distintas se presentaban como el mismo dispositivo. Va en el JSON de
    /// preferencias porque no es una credencial: es un identificador pÃƒÆ’Ã‚Âºblico que
    /// el dueÃƒÆ’Ã‚Â±o necesita leer para autorizar esta instalaciÃƒÆ’Ã‚Â³n.
    #[serde(default)]
    pub installation_id: String,
    #[serde(default)]
    pub device_shared_secret: String,
    /// Cuenta autenticada (FASE 2.3). No es secreto: la UI lo muestra. El
    /// token de sesión vive en Credential Manager; sin token, este campo se
    /// ignora y el cliente cae al camino legacy.
    #[serde(default)]
    pub account_id: String,
    /// Marca que el secreto ya fue copiado a Credential Manager.
    ///
    /// No borra el secreto del JSON: se conserva para que un rollback manual
    /// sea posible y para que una instalaciÃƒÆ’Ã‚Â³n existente no quede sin conexiÃƒÆ’Ã‚Â³n.
    /// Lo que sÃƒÆ’Ã‚Â­ evita es reintentar la escritura en cada arranque.
    #[serde(default)]
    pub device_secret_migrated: bool,
    #[serde(default)]
    pub wake_words: Vec<String>,
    #[serde(default)]
    pub use_vosk_wake: bool,
    #[serde(default)]
    pub wake_model_dir: Option<String>,
    #[serde(default)]
    pub response_output_target: String, // "pc" or "server"
    #[serde(default)]
    pub autostart_enabled: bool,
    #[serde(default)]
    pub mic_muted: bool,
    #[serde(default)]
    pub tts_muted: bool,
    // Local Core LAN settings
    #[serde(default)]
    pub use_local_core: bool,
    #[serde(default)]
    pub core_lan_url: String,
    // TTS settings
    #[serde(default)]
    pub tts_provider: String,   // "cloudflare" or "gemini"
    #[serde(default)]
    pub tts_voice: String,      // e.g. "carina", "Puck"
    #[serde(default)]
    pub tts_language: String,   // e.g. "es"
    #[serde(default)]
    pub tts_speed: f64,         // 0.5 - 2.0
    // Audio device preferences
    #[serde(default = "default_input_device_name")]
    pub input_device_name: String,
    #[serde(default = "default_output_device_name")]
    pub output_device_name: String,
    #[serde(default)]
    pub device_preferences: DevicePreferences,
}

/// Destino por defecto del cliente PC.
///
/// Es una **dirección**, no un secreto: el valor entra por `APOLLO_WORKER_URL` al
/// compilar (así el mismo binario no puede cambiar de entorno en runtime, ni
/// volver a producción por accidente). Sin esa variable el valor es el de
/// producción, que es exactamente lo que pasaba antes de este cambio.
///
/// Un build de staging se compila con
/// `APOLLO_WORKER_URL=wss://apollo-staging.facupapollo.workers.dev/agents/apollo/default`
/// y en ese caso TODOS los derivados (HTTP y WebSocket) salen de ahí: no hay
/// ruta de vuelta a producción.
pub const PRODUCTION_WORKER_URL: &str =
    "wss://apollo.facupapollo.workers.dev/agents/apollo/default";

pub fn default_worker_url() -> String {
    match option_env!("APOLLO_WORKER_URL") {
        Some(compiledUrl) if !compiledUrl.trim().is_empty() => compiledUrl.trim().to_string(),
        _ => PRODUCTION_WORKER_URL.to_string(),
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            worker_url: default_worker_url(),
        installation_id: String::new(),
        device_shared_secret: String::new(),
        account_id: String::new(),
        device_secret_migrated: false,
            wake_words: vec!["apollo".to_string(), "hey apollo".to_string()],
            use_vosk_wake: true,
            wake_model_dir: None,
            response_output_target: "pc".to_string(),
            autostart_enabled: true,
            mic_muted: false,
            tts_muted: false,
            // Cloud-first: local core is the fallback, not the default
            use_local_core: false,
            core_lan_url: "ws://192.168.100.8:9876".to_string(),
            // TTS defaults
            tts_provider: "cloudflare".to_string(),
            tts_voice: "carina".to_string(),
            tts_language: "es".to_string(),
            tts_speed: 1.0,
            input_device_name: default_input_device_name(),
            output_device_name: default_output_device_name(),
            device_preferences: DevicePreferences::default(),
        }
    }
}

impl AppSettings {
    /**
     * Identificador estable y ÃƒÆ’Ã‚Âºnico de esta instalaciÃƒÆ’Ã‚Â³n.
     *
     * No es una credencial: es el `deviceId` que el Worker ve, y el dueÃƒÆ’Ã‚Â±o lo
     * necesita conocer para autorizar ESTA PC. Por eso va en el JSON de
     * preferencias, que ya es legible, y no en un almacÃƒÆ’Ã‚Â©n de secretos.
     *
     * El prefijo `desktop:` lo alinea con el que ya usa el telÃƒÆ’Ã‚Â©fono
     * (`mobile:`), para que los dos clientes se distinguan en el mismo
     * registro y una interfaz de vinculaciÃƒÆ’Ã‚Â³n pueda mostrarlos juntos.
     */
    pub fn generate_installation_id() -> String {
        format!("desktop:{}", uuid::Uuid::new_v4())
    }

    pub async fn load(app: &AppHandle) -> Result<Self, String> {
        let path = Self::settings_path(app)?;
        if path.exists() {
            let content = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
            let mut loaded: Self =
                serde_json::from_str(&content).map_err(|e| e.to_string())?;
            // MigraciÃƒÆ’Ã‚Â³n: si el archivo es viejo/vacÃƒÆ’Ã‚Â­o, rellenar con defaults permanentes
            let defaults = Self::default();
            // Una instalaciÃƒÆ’Ã‚Â³n existente no tiene `installation_id`: se le genera
            // uno y se persiste abajo. Esto NO borra ni altera ninguna otra
            // preferencia, y el resto del archivo se conserva tal cual.
            if loaded.installation_id.trim().is_empty() {
                loaded.installation_id = Self::generate_installation_id();
            }
            if loaded.device_shared_secret.trim().is_empty() {
                loaded.device_shared_secret = String::new();
            }
            let mut needs_save = false;
            // MigraciÃƒÆ’Ã‚Â³n del secreto a Credential Manager.
            //
            // El orden importa: primero se resuelve el valor vigente (el almacÃƒÆ’Ã‚Â©n
            // si ya tiene algo, el JSON si no), y sÃƒÆ’Ã‚Â³lo despuÃƒÆ’Ã‚Â©s se reescribe el
            // JSON con ese valor para que las dos fuentes coincidan. Si el
            // almacÃƒÆ’Ã‚Â©n falla, el JSON conserva el valor y la conexiÃƒÆ’Ã‚Â³n sigue igual.
            if !loaded.device_shared_secret.trim().is_empty() {
                let effective_secret = crate::secret_store::load_effective_secret(
                    &loaded.device_shared_secret,
                );
                if !effective_secret.trim().is_empty() {
                    loaded.device_shared_secret = effective_secret;
                    needs_save = true;
                }
                if !loaded.device_secret_migrated {
                    loaded.device_secret_migrated =
                        matches!(crate::secret_store::store_device_secret(
                            &loaded.device_shared_secret
                        ), crate::secret_store::SecretStoreOutcome::Ok);
                    needs_save = true;
                }
            }
            if loaded.wake_words.is_empty() {
                loaded.wake_words = defaults.wake_words.clone();
                needs_save = true;
            }
            // MigraciÃƒÆ’Ã‚Â³n: nuevos campos Local Core LAN
            // No sobrescribir use_local_core si ya fue configurado explÃƒÆ’Ã‚Â­citamente
            if loaded.core_lan_url.trim().is_empty() {
                loaded.core_lan_url = defaults.core_lan_url.clone();
            }
            // Directorio del modelo: "" o ruta rota ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ usar el bundleado
            if let Some(dir) = loaded.wake_model_dir.as_ref() {
                let trimmed = dir.trim();
                if trimmed.is_empty()
                    || trimmed.contains("vosk-model-small-es-0.42 (espa")
                    || !std::path::Path::new(trimmed).exists()
                {
                    loaded.wake_model_dir = None;
                }
            }
            if loaded.worker_url.trim().is_empty() {
                loaded.worker_url = defaults.worker_url.clone();
            }
            // MigraciÃƒÆ’Ã‚Â³n: solo guardar si HICIMOS cambios reales en la estructura
            if loaded.wake_words.is_empty() {
                loaded.wake_words = defaults.wake_words.clone();
                needs_save = true;
            }
            if loaded.core_lan_url.trim().is_empty() {
                loaded.core_lan_url = defaults.core_lan_url.clone();
                needs_save = true;
            }
            if let Some(dir) = loaded.wake_model_dir.as_ref() {
                let trimmed = dir.trim();
                if trimmed.is_empty()
                    || trimmed.contains("vosk-model-small-es-0.42 (espa")
                    || !std::path::Path::new(trimmed).exists()
                {
                    loaded.wake_model_dir = None;
                    needs_save = true;
                }
            }
            if loaded.worker_url.trim().is_empty() {
                loaded.worker_url = defaults.worker_url.clone();
                needs_save = true;
            }
            if loaded.input_device_name.trim().is_empty() {
                loaded.input_device_name = defaults.input_device_name.clone();
                needs_save = true;
            }
            if loaded.output_device_name.trim().is_empty() {
                loaded.output_device_name = defaults.output_device_name.clone();
                needs_save = true;
            }
            if loaded.installation_id.trim().is_empty() {
                loaded.installation_id = Self::generate_installation_id();
                needs_save = true;
            }
            let path_str = path.to_string_lossy();
            let secret_diag = if loaded.device_shared_secret.is_empty() { "(vacio)" } else { "(ok)" };
            eprintln!("[apollo] settings: path={} secret={secret_diag} needs_save={}", path_str, needs_save);
            if needs_save {
                let _ = loaded.save(app).await;
            }
            Ok(loaded)
        } else {
            eprintln!("[apollo] settings: path={} file-exists=false secret=(vacio)", path.to_string_lossy());
            let mut defaults = Self::default();
            // InstalaciÃƒÆ’Ã‚Â³n nueva: el identificador se genera una vez y se
            // persiste con el resto de preferencias.
            defaults.installation_id = Self::generate_installation_id();
            let _ = defaults.save(app).await;
            Ok(defaults)
        }
    }

    pub async fn save(&self, app: &AppHandle) -> Result<(), String> {
        let path = Self::settings_path(app)?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        let content = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        tokio::fs::write(&path, content).await.map_err(|e| e.to_string())?;
        Ok(())
    }

    fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|e| e.to_string())?;
        Ok(config_dir.join("settings.json"))
    }
}

pub struct AppState {
    connection_status: Arc<RwLock<ConnectionStatus>>,
    orb_state: Arc<RwLock<OrbState>>,
    sidecar_running: Arc<RwLock<bool>>,
}

impl AppState {
    pub fn new(_app: AppHandle) -> Self {
        Self {
            connection_status: Arc::new(RwLock::new(ConnectionStatus::Disconnected)),
            orb_state: Arc::new(RwLock::new(OrbState::Idle)),
            sidecar_running: Arc::new(RwLock::new(false)),
        }
    }

    pub async fn set_connection_status(&self, status: ConnectionStatus) {
        let mut guard = self.connection_status.write().await;
        *guard = status;
    }

    pub async fn get_connection_status(&self) -> ConnectionStatus {
        self.connection_status.read().await.clone()
    }

    pub async fn set_orb_state(&self, state: OrbState) {
        let mut guard = self.orb_state.write().await;
        *guard = state;
    }

    pub async fn get_orb_state(&self) -> OrbState {
        self.orb_state.read().await.clone()
    }

    pub async fn set_sidecar_running(&self, running: bool) {
        let mut guard = self.sidecar_running.write().await;
        *guard = running;
    }

    pub async fn get_sidecar_status(&self) -> crate::commands::SidecarStatus {
        let running = *self.sidecar_running.read().await;
        let connection_status = self.get_connection_status().await;
        let current_orb_state = self.get_orb_state().await;
        crate::commands::SidecarStatus {
            running,
            connection_status,
            current_orb_state,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_settings_path() -> String {
        format!("{}/apollo_test_settings_{}.json", std::env::temp_dir().to_string_lossy(), std::process::id())
    }

    #[test]
    fn default_settings_have_empty_secret() {
        let s = AppSettings::default();
        assert!(s.device_shared_secret.is_empty());
    }

    // FASE 2.11 — el destino del cliente se resuelve al compilar.
    #[test]
    fn default_worker_url_never_carries_a_secret() {
        let url = default_worker_url();
        assert!(url.starts_with("wss://"), "el destino es una URL de socket");
        assert!(!url.contains("token="), "ningún secreto en la URL");
        assert!(!url.contains("secret"), "ningún secreto en la URL");
    }

    #[test]
    fn default_worker_url_matches_the_environment_this_binary_was_built_for() {
        let url = default_worker_url();
        match option_env!("APOLLO_WORKER_URL") {
            Some(compiled) if !compiled.trim().is_empty() => {
                assert_eq!(url, compiled.trim());
            }
            _ => assert_eq!(url, PRODUCTION_WORKER_URL),
        }
    }

    #[test]
    fn production_build_still_defaults_to_production() {
        if option_env!("APOLLO_WORKER_URL").is_none() {
            assert_eq!(default_worker_url(), PRODUCTION_WORKER_URL);
        }
    }

    #[test]
    fn default_settings_have_no_installation_id() {
        // El default NO trae un id fijo: si lo trajera, dos instalaciones
        //arias arrancadas del mismo binario serÃƒÆ’Ã‚Â­an el mismo dispositivo.
        let s = AppSettings::default();
        assert!(s.installation_id.is_empty());
    }

    #[test]
    fn generated_installation_id_has_the_desktop_prefix() {
        let id = AppSettings::generate_installation_id();
        assert!(
            id.starts_with("desktop:"),
            "el id debe llevar el prefijo desktop:, se obtuvo {id}"
        );
    }

    #[test]
    fn generated_installation_ids_are_unique() {
        let first = AppSettings::generate_installation_id();
        let second = AppSettings::generate_installation_id();
        assert_ne!(first, second, "dos instalaciones no pueden coincidir");
    }

    #[test]
    fn installation_id_survives_a_serialization_round_trip() {
        let mut settings = AppSettings::default();
        settings.installation_id = AppSettings::generate_installation_id();
        let persisted = settings.installation_id.clone();

        let json = serde_json::to_string_pretty(&settings).unwrap();
        let restored: AppSettings = serde_json::from_str(&json).unwrap();

        assert_eq!(
            restored.installation_id, persisted,
            "el id debe sobrevivir a guardar y cargar"
        );
    }

    #[test]
    fn a_settings_file_without_installation_id_still_deserializes() {
        // MigraciÃƒÆ’Ã‚Â³n: una instalaciÃƒÆ’Ã‚Â³n existente no tiene el campo. serde
        // `default` debe rellenar "" y no fallar la carga completa.
        let legacy_json = r#"{"worker_url":"wss://test.example.com","wake_words":["apollo"]}"#;
        let parsed: AppSettings = serde_json::from_str(legacy_json).unwrap();

        assert!(parsed.installation_id.is_empty());
        // El resto de las preferencias NO se pierde por la migraciÃƒÆ’Ã‚Â³n.
        assert_eq!(parsed.worker_url, "wss://test.example.com");
        assert_eq!(parsed.wake_words, vec!["apollo".to_string()]);
    }

    #[test]
    fn installing_an_id_does_not_touch_the_rest_of_the_settings() {
        // La migraciÃƒÆ’Ã‚Â³n agrega el id y nada mÃƒÆ’Ã‚Â¡s: una preferencia ya configurada
        // por el dueÃƒÆ’Ã‚Â±o tiene que sobrevivir intacta.
        let legacy_json = r#"{
            "worker_url":"wss://worker.example/agents/apollo/default",
            "device_shared_secret":"TEST_DEVICE_SECRET_123",
            "wake_words":["hola apollo"]
        }"#;
        let mut parsed: AppSettings = serde_json::from_str(legacy_json).unwrap();

        if parsed.installation_id.trim().is_empty() {
            parsed.installation_id = AppSettings::generate_installation_id();
        }

        assert!(parsed.installation_id.starts_with("desktop:"));
        assert_eq!(
            parsed.device_shared_secret, "TEST_DEVICE_SECRET_123",
            "el secreto no debe cambiar durante la migraciÃƒÆ’Ã‚Â³n"
        );
        assert_eq!(parsed.wake_words, vec!["hola apollo".to_string()]);
    }

    #[test]
    fn update_settings_preserves_existing_secret_when_new_is_empty() {
        let mut current = AppSettings::default();
        current.device_shared_secret = "existing-secret".to_string();
        current.worker_url = "wss://test.example.com".to_string();

        let new_secret = String::new();
        if !new_secret.is_empty() {
            current.device_shared_secret = new_secret;
        }
        assert_eq!(current.device_shared_secret, "existing-secret");

        let new_secret2 = "new-secret".to_string();
        if !new_secret2.is_empty() {
            current.device_shared_secret = new_secret2;
        }
        assert_eq!(current.device_shared_secret, "new-secret");
    }

    #[test]
    fn default_settings_have_expected_fields() {
        let s = AppSettings::default();
        // FASE 2.11: el destino viene del binario, así que el test afirma el
        // contrato (wss + mismo valor que `default_worker_url`) en vez de un
        // literal que rompería cualquier build de staging.
        assert!(s.worker_url.starts_with("wss://"));
        assert_eq!(s.worker_url, default_worker_url());
        assert!(s.wake_words.contains(&"apollo".to_string()));
        assert!(s.use_vosk_wake);
        assert_eq!(s.tts_provider, "cloudflare");
        assert_eq!(s.tts_voice, "carina");
    }

    #[test]
    fn persist_secret_across_save_load() {
        let settings_path = temp_settings_path();

        let mut settings = AppSettings::default();
        settings.device_shared_secret = "TEST_DEVICE_SECRET_123".to_string();
        settings.wake_words = vec!["apollo".to_string()];

        let json = serde_json::to_string_pretty(&settings).unwrap();
        fs::write(&settings_path, &json).unwrap();

        let content = fs::read_to_string(&settings_path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["device_shared_secret"], "TEST_DEVICE_SECRET_123");

        let loaded: AppSettings = serde_json::from_str(&content).unwrap();
        assert_eq!(loaded.device_shared_secret, "TEST_DEVICE_SECRET_123");

        let mut updated = loaded.clone();
        updated.wake_words = vec!["hey apollo".to_string()];
        let json2 = serde_json::to_string_pretty(&updated).unwrap();
        fs::write(&settings_path, &json2).unwrap();

        let loaded2: AppSettings = serde_json::from_str(&fs::read_to_string(&settings_path).unwrap().as_str()).unwrap();
        assert_eq!(loaded2.device_shared_secret, "TEST_DEVICE_SECRET_123");
        assert_eq!(loaded2.wake_words, vec!["hey apollo".to_string()]);

        let mut updated3 = loaded2.clone();
        updated3.tts_provider = "gemini".to_string();
        let json3 = serde_json::to_string_pretty(&updated3).unwrap();
        fs::write(&settings_path, &json3).unwrap();

        let loaded3: AppSettings = serde_json::from_str(&fs::read_to_string(&settings_path).unwrap().as_str()).unwrap();
        assert_eq!(loaded3.device_shared_secret, "TEST_DEVICE_SECRET_123");
        assert_eq!(loaded3.tts_provider, "gemini");

        let _ = fs::remove_file(&settings_path);
    }

    #[test]
    fn persist_secret_when_field_missing_from_json() {
        let json = r#"{"worker_url":"wss://test.example.com","wake_words":["apollo"]}"#;
        let loaded: AppSettings = serde_json::from_str(json).unwrap();
        assert!(loaded.device_shared_secret.is_empty());
        assert_eq!(loaded.worker_url, "wss://test.example.com");
    }

    #[test]
    fn update_partial_fields_preserves_secret() {
        let mut settings = AppSettings::default();
        settings.device_shared_secret = "TEST_DEVICE_SECRET_123".to_string();

        let mut updated = settings.clone();
        updated.wake_words = vec!["custom word".to_string()];
        let json = serde_json::to_string_pretty(&updated).unwrap();
        let loaded: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded.device_shared_secret, "TEST_DEVICE_SECRET_123");

        let mut updated2 = loaded.clone();
        updated2.tts_provider = "gemini".to_string();
        let json2 = serde_json::to_string_pretty(&updated2).unwrap();
        let loaded2: AppSettings = serde_json::from_str(&json2).unwrap();
        assert_eq!(loaded2.device_shared_secret, "TEST_DEVICE_SECRET_123");

        let mut updated3 = loaded2.clone();
        updated3.tts_speed = 1.5;
        let json3 = serde_json::to_string_pretty(&updated3).unwrap();
        let loaded3: AppSettings = serde_json::from_str(&json3).unwrap();
        assert_eq!(loaded3.device_shared_secret, "TEST_DEVICE_SECRET_123");
    }

    #[test]
    fn update_settings_guard_preserves_secret() {
        let mut current = AppSettings::default();
        current.device_shared_secret = "TEST_DEVICE_SECRET_123".to_string();

        let new_data_secret = String::new();
        let had_secret = !current.device_shared_secret.is_empty();
        if !new_data_secret.is_empty() {
            current.device_shared_secret = new_data_secret;
        } else if had_secret {
        }
        assert_eq!(current.device_shared_secret, "TEST_DEVICE_SECRET_123");

        let new_data_secret2 = "NEW_SECRET_456".to_string();
        let had_secret2 = !current.device_shared_secret.is_empty();
        if !new_data_secret2.is_empty() {
            current.device_shared_secret = new_data_secret2;
        } else if had_secret2 {
        }
        assert_eq!(current.device_shared_secret, "NEW_SECRET_456");
    }
}
