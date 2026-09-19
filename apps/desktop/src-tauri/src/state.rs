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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub worker_url: String,
    pub device_shared_secret: String,
    pub wake_words: Vec<String>,
    pub use_vosk_wake: bool,
    pub wake_model_dir: Option<String>,
    pub response_output_target: String, // "pc" or "server"
    pub autostart_enabled: bool,
    pub mic_muted: bool,
    pub tts_muted: bool,
    // Local Core LAN settings
    pub use_local_core: bool,
    pub core_lan_url: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            worker_url: "wss://apollo.facupapollo.workers.dev/agents/apollo/default".to_string(),
            device_shared_secret: String::new(),
            wake_words: vec!["okey trae".to_string()],
            use_vosk_wake: true,
            wake_model_dir: None,
            response_output_target: "pc".to_string(),
            autostart_enabled: true,
            mic_muted: false,
            tts_muted: false,
            // Local Core LAN defaults
            use_local_core: true,
            core_lan_url: "ws://192.168.100.8:9876".to_string(),
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
            if loaded.use_local_core == false {
                loaded.use_local_core = defaults.use_local_core;
            }
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
            // Auto-reparar archivo corrupto/migrado: solo guarda si HICIMOS cambios
            let mut needs_save = false;
            if loaded.device_shared_secret.trim().is_empty() {
                // Secret vacío tras carga: no lo rellenamos (usuario debe configurarlo),
                // pero marcamos para limpiar wake_words/model_dir si hace falta
                needs_save = loaded.wake_words.is_empty() || loaded.wake_model_dir.is_some();
            } else {
                // Secret presente: solo guardar si wake_words o model_dir necesitan reparación
                needs_save = loaded.wake_words.is_empty() || loaded.wake_model_dir.is_some();
            }
            // No bloquear el inicio si falla el save
            if needs_save {
                let to_save = loaded.clone();
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = to_save.save(&app_handle).await;
                });
            }
            Ok(loaded)
        } else {
            let defaults = Self::default();
            let to_save = defaults.clone();
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = to_save.save(&app_handle).await;
            });
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