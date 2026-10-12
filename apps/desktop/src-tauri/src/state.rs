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
    "Micrófono (JBL Quantum 300)".to_string()
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
    #[serde(default)]
    pub device_shared_secret: String,
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

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            worker_url: "wss://apollo.facupapollo.workers.dev/agents/apollo/default".to_string(),
            device_shared_secret: String::new(),
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
    pub async fn load(app: &AppHandle) -> Result<Self, String> {
        let path = Self::settings_path(app)?;
        if path.exists() {
            let content = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
            let mut loaded: Self =
                serde_json::from_str(&content).map_err(|e| e.to_string())?;
            // Migración: si el archivo es viejo/vacío, rellenar con defaults permanentes
            let defaults = Self::default();
            if loaded.device_shared_secret.trim().is_empty() {
                loaded.device_shared_secret = String::new();
            }
            if loaded.wake_words.is_empty() {
                loaded.wake_words = defaults.wake_words.clone();
            }
            // Migración: nuevos campos Local Core LAN
            // No sobrescribir use_local_core si ya fue configurado explícitamente
            if loaded.core_lan_url.trim().is_empty() {
                loaded.core_lan_url = defaults.core_lan_url.clone();
            }
            // Directorio del modelo: "" o ruta rota → usar el bundleado
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
            // Migración: solo guardar si HICIMOS cambios reales en la estructura
            let mut needs_save = false;
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
            let path_str = path.to_string_lossy();
            let secret_diag = if loaded.device_shared_secret.is_empty() { "(vacio)" } else { "(ok)" };
            eprintln!("[apollo] settings: path={} secret={secret_diag} needs_save={}", path_str, needs_save);
            if needs_save {
                let _ = loaded.save(app).await;
            }
            Ok(loaded)
        } else {
            eprintln!("[apollo] settings: path={} file-exists=false secret=(vacio)", path.to_string_lossy());
            let defaults = Self::default();
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
        assert_eq!(s.worker_url, "wss://apollo.facupapollo.workers.dev/agents/apollo/default");
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