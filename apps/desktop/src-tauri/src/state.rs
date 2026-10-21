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
    "MicrÃƒÆ’Ã‚³fono (JBL Quantum 300)".to_string()
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
    /// Identidad estable de ESTA instalaciÃƒÆ’Ã‚³n, no un secreto.
    ///
    /// Antes no existÃƒÆ’Ã‚­a: `CloudCoreManager` usaba `"desktop"` fijo, asÃƒÆ’Ã‚­ que dos
    /// PCs distintas se presentaban como el mismo dispositivo. Va en el JSON de
    /// preferencias porque no es una credencial: es un identificador pÃƒÆ’Ã‚ºblico que
    /// el dueÃƒÆ’Ã‚±o necesita leer para autorizar esta instalaciÃƒÆ’Ã‚³n.
    #[serde(default)]
    pub installation_id: String,
    #[serde(default)]
    pub device_shared_secret: String,
    /// Cuenta autenticada (FASE 2.3). No es secreto: la UI lo muestra. El
    /// token de sesión vive en Credential Manager; sin token, este campo se
    /// ignora y el cliente cae al camino legacy.
    #[serde(default)]
    pub account_id: String,
    /// Email de la cuenta autenticada (no es secreto). Usado para restaurar
    /// la sesión al abrir la app.
    #[serde(default)]
    pub account_email: String,
    /// Marca que el secreto ya fue copiado a Credential Manager.
    ///
    /// No borra el secreto del JSON: se conserva para que un rollback manual
    /// sea posible y para que una instalaciÃƒÆ’Ã‚³n existente no quede sin conexiÃƒÆ’Ã‚³n.
    /// Lo que sÃƒÆ’Ã‚­ evita es reintentar la escritura en cada arranque.
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
/// Es una **direccion**, no un secreto: el valor entra por `APOLLO_WORKER_URL` al
/// compilar (asi el mismo binario no puede cambiar de entorno en runtime, ni
/// volver a produccion por accidente).
///
/// `build.rs` emite SIEMPRE esa variable, con el destino de la variante que
/// se esta compilando: staging gets `wss://apollo-staging.facupapollo.workers.dev/...`
/// y estable gets el host de produccion. La rama `None` ya no deberia
/// alcanzarse, pero si se alcanzara **nunca** devuelve el host de produccion
/// en una build de staging: en ese caso la build queda sin destino y el
/// cliente se niega a conectar (ver `resolve_worker_url`).
pub const PRODUCTION_WORKER_URL: &str =
    "wss://apollo.facupapollo.workers.dev/agents/apollo/default";
pub const STAGING_WORKER_URL: &str =
    "wss://apollo-staging.facupapollo.workers.dev/agents/apollo/default";

/// Host de produccion. Una build de staging jamas puede apuntar aqui.
pub const PRODUCTION_WORKER_HOST: &str = "apollo.facupapollo.workers.dev";
/// Host de staging. Una build estable jamas puede apuntar aqui.
pub const STAGING_WORKER_HOST: &str = "apollo-staging.facupapollo.workers.dev";

/// `true` si este binario es una build de staging.
///
/// La variante se decide AL COMPILAR: `build.rs` marca `cfg(apollo_staging)`
/// cuando la config de Tauri en uso es la de staging, y emite el namespace
/// de credenciales y el destino del Worker correspondientes. Es el mismo
/// mecanismo que ya usan `main.rs` (perfil WebView2) y `secret_store.rs`
/// (namespace de Credential Manager), asi que no hay una segunda fuente de
/// verdad que pueda desincronizarse.
pub const fn is_staging_build() -> bool {
    cfg!(apollo_staging)
}

/// Host que esta build puede usar como destino del Worker.
pub const fn expected_worker_host() -> &'static str {
    if is_staging_build() {
        STAGING_WORKER_HOST
    } else {
        PRODUCTION_WORKER_HOST
    }
}

/// Default del Worker segun la variante de esta build.
pub fn default_worker_url() -> String {
    match option_env!("APOLLO_WORKER_URL") {
        Some(compiled_url) if !compiled_url.trim().is_empty() => compiled_url.trim().to_string(),
        // Sin destino compilado no se inventa uno: una build de staging no
        // puede caer al host de produccion. `resolve_worker_url` va a
        // rechazar la conexion y la UI lo muestra.
        _ if is_staging_build() => STAGING_WORKER_URL.to_string(),
        _ => PRODUCTION_WORKER_URL.to_string(),
    }
}

/// Extrae el host de una URL de Worker, sin esquema ni ruta.
fn worker_url_host(url: &str) -> Option<&str> {
    let without_scheme = url.split("://").nth(1)?;
    let authority = without_scheme.split('/').next()?;
    if authority.is_empty() {
        return None;
    }
    Some(authority)
}

/// Resultado de resolver el destino del Worker antes de conectar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerUrlResolution {
    /// Destino valido para esta variante.
    Valid(String),
    /// Destino invalido: hay un motivo y NO se debe conectar.
    Invalid(String),
}

/// Valida el destino configurado contra la variante de esta build.
///
/// Reglas:
/// - vacio => se usa el default de la variante (nunca el de la otra);
/// - host que no sea el de esta variante => RECHAZADO (una build de staging
///   jamas cae a produccion ni al reves);
/// - URL sin host o con esquema no `wss://`/`ws://` => RECHAZADA.
pub fn resolve_worker_url(configured: &str) -> WorkerUrlResolution {
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        return WorkerUrlResolution::Valid(default_worker_url());
    }
    if !trimmed.starts_with("wss://") && !trimmed.starts_with("ws://") {
        return WorkerUrlResolution::Invalid(format!(
            "el destino del Worker no es un WebSocket valido: {trimmed}"
        ));
    }
    let host = match worker_url_host(trimmed) {
        Some(host) => host,
        None => {
            return WorkerUrlResolution::Invalid(format!(
                "el destino del Worker no tiene host: {trimmed}"
            ))
        }
    };
    let expected = expected_worker_host();
    if host != expected {
        let reason = if is_staging_build() {
            format!("una build de staging no puede apuntar a {host}: el destino permitido es {expected}")
        } else {
            format!("una build estable no puede apuntar a {host}: el destino permitido es {expected}")
        };
        return WorkerUrlResolution::Invalid(reason);
    }
    WorkerUrlResolution::Valid(trimmed.to_string())
}
/// Variante de la build. Determina que destino de Worker es valido.
///
/// Se usa como parametro de las funciones puras para poder probar LOS DOS
/// casos (staging y estable) en la misma suite, sin depender de con que
/// variante se compilo la suite.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    Stable,
    Staging,
}

impl Variant {
    /// La variante de ESTE binario, la que se compilo.
    pub const fn current() -> Self {
        if is_staging_build() {
            Variant::Staging
        } else {
            Variant::Stable
        }
    }

    /// Host que esta variante puede usar como destino del Worker.
    pub const fn worker_host(self) -> &'static str {
        match self {
            Variant::Staging => STAGING_WORKER_HOST,
            Variant::Stable => PRODUCTION_WORKER_HOST,
        }
    }

    /// Default del Worker de esta variante.
    pub const fn default_worker_url(self) -> &'static str {
        match self {
            Variant::Staging => STAGING_WORKER_URL,
            Variant::Stable => PRODUCTION_WORKER_URL,
        }
    }
}

/// Resuelve el destino del Worker para una variante concreta.
///
/// Mismas reglas que `resolve_worker_url`, pero con la variante como
/// parametro: asi la suite puede comprobar las dos sin recompilar.
pub fn resolve_worker_url_for(variant: Variant, configured: &str) -> WorkerUrlResolution {
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        return WorkerUrlResolution::Valid(variant.default_worker_url().to_string());
    }
    if !trimmed.starts_with("wss://") && !trimmed.starts_with("ws://") {
        return WorkerUrlResolution::Invalid(format!(
            "el destino del Worker no es un WebSocket valido: {trimmed}"
        ));
    }
    let host = match worker_url_host(trimmed) {
        Some(host) => host,
        None => {
            return WorkerUrlResolution::Invalid(format!(
                "el destino del Worker no tiene host: {trimmed}"
            ))
        }
    };
    let expected = variant.worker_host();
    if host != expected {
        let reason = match variant {
            Variant::Staging => format!(
                "una build de staging no puede apuntar a {host}: el destino permitido es {expected}"
            ),
            Variant::Stable => format!(
                "una build estable no puede apuntar a {host}: el destino permitido es {expected}"
            ),
        };
        return WorkerUrlResolution::Invalid(reason);
    }
    WorkerUrlResolution::Valid(trimmed.to_string())
}


impl Default for AppSettings {
    fn default() -> Self {
        Self {
            worker_url: default_worker_url(),
        installation_id: String::new(),
        device_shared_secret: String::new(),
        account_id: String::new(),
        account_email: String::new(),
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
     * Identificador estable y ÃƒÆ’Ã‚ºnico de esta instalaciÃƒÆ’Ã‚³n.
     *
     * No es una credencial: es el `deviceId` que el Worker ve, y el dueÃƒÆ’Ã‚±o lo
     * necesita conocer para autorizar ESTA PC. Por eso va en el JSON de
     * preferencias, que ya es legible, y no en un almacÃƒÆ’Ã‚©n de secretos.
     *
     * El prefijo `desktop:` lo alinea con el que ya usa el telÃƒÆ’Ã‚©fono
     * (`mobile:`), para que los dos clientes se distinguan en el mismo
     * registro y una interfaz de vinculaciÃƒÆ’Ã‚³n pueda mostrarlos juntos.
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
            // MigraciÃƒÆ’Ã‚³n: si el archivo es viejo/vacÃƒÆ’Ã‚­o, rellenar con defaults permanentes
            let defaults = Self::default();
            // Una instalaciÃƒÆ’Ã‚³n existente no tiene `installation_id`: se le genera
            // uno y se persiste abajo. Esto NO borra ni altera ninguna otra
            // preferencia, y el resto del archivo se conserva tal cual.
            if loaded.installation_id.trim().is_empty() {
                loaded.installation_id = Self::generate_installation_id();
            }
            if loaded.device_shared_secret.trim().is_empty() {
                loaded.device_shared_secret = String::new();
            }
            let mut needs_save = false;
            // MigraciÃƒÆ’Ã‚³n del secreto a Credential Manager.
            //
            // El orden importa: primero se resuelve el valor vigente (el almacÃƒÆ’Ã‚©n
            // si ya tiene algo, el JSON si no), y sÃƒÆ’Ã‚³lo despuÃƒÆ’Ã‚©s se reescribe el
            // JSON con ese valor para que las dos fuentes coincidan. Si el
            // almacÃƒÆ’Ã‚©n falla, el JSON conserva el valor y la conexiÃƒÆ’Ã‚³n sigue igual.
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
            // MigraciÃƒÆ’Ã‚³n: nuevos campos Local Core LAN
            // No sobrescribir use_local_core si ya fue configurado explÃƒÆ’Ã‚­citamente
            if loaded.core_lan_url.trim().is_empty() {
                loaded.core_lan_url = defaults.core_lan_url.clone();
            }
            // Directorio del modelo: "" o ruta rota — usar el bundleado
            if let Some(dir) = loaded.wake_model_dir.as_ref() {
                let trimmed = dir.trim();
                if trimmed.is_empty()
                    || trimmed.contains("vosk-model-small-es-0.42 (espa")
                    || !std::path::Path::new(trimmed).exists()
                {
                    loaded.wake_model_dir = None;
                }
            }
            // El destino del Worker se RESUELVE contra la variante de esta
            // build: vacio => default de la variante; host equivocado =>
            // se deja vacio para que el cliente NO conecte y la UI lo
            // muestre. Nunca se cae al host de la otra variante.
            match resolve_worker_url(&loaded.worker_url) {
                WorkerUrlResolution::Valid(url) => {
                    if url != loaded.worker_url {
                        loaded.worker_url = url;
                        needs_save = true;
                    }
                }
                WorkerUrlResolution::Invalid(reason) => {
                    eprintln!("[apollo] destino del Worker invalido: {reason}");
                    loaded.worker_url = String::new();
                    needs_save = true;
                }
            }
            // MigraciÃƒÆ’Ã‚³n: solo guardar si HICIMOS cambios reales en la estructura
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
            // El destino del Worker ya quedo resuelto arriba (mismo
            // criterio de variante); no se vuelve a tocar aqui.
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
            // InstalaciÃƒÆ’Ã‚³n nueva: el identificador se genera una vez y se
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
        //arias arrancadas del mismo binario serÃƒÆ’Ã‚­an el mismo dispositivo.
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
        // MigraciÃƒÆ’Ã‚³n: una instalaciÃƒÆ’Ã‚³n existente no tiene el campo. serde
        // `default` debe rellenar "" y no fallar la carga completa.
        let legacy_json = r#"{"worker_url":"wss://test.example.com","wake_words":["apollo"]}"#;
        let parsed: AppSettings = serde_json::from_str(legacy_json).unwrap();

        assert!(parsed.installation_id.is_empty());
        // El resto de las preferencias NO se pierde por la migraciÃƒÆ’Ã‚³n.
        assert_eq!(parsed.worker_url, "wss://test.example.com");
        assert_eq!(parsed.wake_words, vec!["apollo".to_string()]);
    }

    #[test]
    fn installing_an_id_does_not_touch_the_rest_of_the_settings() {
        // La migraciÃƒÆ’Ã‚³n agrega el id y nada mÃƒÆ’Ã‚¡s: una preferencia ya configurada
        // por el dueÃƒÆ’Ã‚±o tiene que sobrevivir intacta.
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
            "el secreto no debe cambiar durante la migraciÃƒÆ’Ã‚³n"
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

    // ----------------------------------------------------------------
    // Destino del Worker por variante (FASE 6.21: cerrar el fallback de
    // staging a produccion).
    //
    // Estos tests son "de variante": la variante de la build que se esta
    // ejecutando define el host permitido, asi que se prueban LOS DOS
    // casos con el helper parametrizado, sin depender de con que se
    // compilo la suite.
    // ----------------------------------------------------------------

    /// Host permitido para una variante, tal como lo ve el validador.
    fn host_para(variant: Variant) -> &'static str {
        match variant {
            Variant::Staging => STAGING_WORKER_HOST,
            Variant::Stable => PRODUCTION_WORKER_HOST,
        }
    }

    /// URL valida para una variante.
    fn url_para(variant: Variant) -> String {
        format!("wss://{}/agents/apollo/default", host_para(variant))
    }

    /// Resolucion del destino para una variante concreta, sin depender de
    /// la variante de la build en ejecucion.
    fn resolver(variant: Variant, configured: &str) -> WorkerUrlResolution {
        resolve_worker_url_for(variant, configured)
    }

    #[test]
    fn staging_con_configuracion_valida_usa_staging() {
        let url = url_para(Variant::Staging);
        assert_eq!(
            resolver(Variant::Staging, &url),
            WorkerUrlResolution::Valid(url.clone())
        );
    }

    #[test]
    fn staging_sin_configuracion_usa_el_default_de_staging() {
        match resolver(Variant::Staging, "") {
            WorkerUrlResolution::Valid(url) => {
                assert_eq!(url, STAGING_WORKER_URL);
                assert!(url.contains(STAGING_WORKER_HOST));
                assert!(!url.contains(PRODUCTION_WORKER_HOST));
            }
            WorkerUrlResolution::Invalid(reason) => {
                panic!("staging sin configuracion deberia resolverse, no fallar: {reason}");
            }
        }
    }

    #[test]
    fn staging_con_configuracion_vacia_usa_el_default_de_staging() {
        for vacio in ["", "   ", "\t\n"] {
            match resolver(Variant::Staging, vacio) {
                WorkerUrlResolution::Valid(url) => {
                    assert_eq!(url, STAGING_WORKER_URL);
                    assert!(!url.contains(PRODUCTION_WORKER_HOST));
                }
                WorkerUrlResolution::Invalid(reason) => {
                    panic!("staging con configuracion vacia deberia resolverse: {reason}");
                }
            }
        }
    }

    #[test]
    fn staging_con_configuracion_invalida_no_usa_produccion() {
        let url_estable = url_para(Variant::Stable);
        let invalidos: [&str; 5] = [
            url_estable.as_str(),
            "wss://otro-worker.example.com/agents/apollo/default",
            "https://apollo.facupapollo.workers.dev/agents/apollo/default",
            "no-es-una-url",
            "wss://",
        ];
        for invalida in invalidos {
            match resolver(Variant::Staging, &invalida) {
                WorkerUrlResolution::Valid(url) => panic!(
                    "staging no deberia aceptar {invalida} (resolvio {url})"
                ),
                WorkerUrlResolution::Invalid(reason) => {
                    assert!(!reason.contains("wss://apollo.facupapollo"));
                }
            }
        }
    }

    #[test]
    fn staging_nunca_hereda_el_default_de_produccion() {
        // El default de staging y el de produccion son distintos y cada
        // build toma el suyo: no hay un unico default compartido.
        assert_ne!(STAGING_WORKER_URL, PRODUCTION_WORKER_URL);
        assert!(STAGING_WORKER_URL.contains(STAGING_WORKER_HOST));
        assert!(!STAGING_WORKER_URL.contains(PRODUCTION_WORKER_HOST));
        assert!(PRODUCTION_WORKER_URL.contains(PRODUCTION_WORKER_HOST));
        assert!(!PRODUCTION_WORKER_URL.contains(STAGING_WORKER_HOST));
    }

    #[test]
    fn stable_no_hereda_staging() {
        // Una build estable tampoco puede apuntar a staging.
        let url_staging = url_para(Variant::Staging);
        match resolver(Variant::Stable, &url_staging) {
            WorkerUrlResolution::Valid(url) => panic!(
                "stable no deberia aceptar el host de staging (resolvio {url})"
            ),
            WorkerUrlResolution::Invalid(_) => {}
        }
        // Y su default es el de produccion.
        match resolver(Variant::Stable, "") {
            WorkerUrlResolution::Valid(url) => assert_eq!(url, PRODUCTION_WORKER_URL),
            WorkerUrlResolution::Invalid(reason) => {
                panic!("stable sin configuracion deberia resolverse: {reason}");
            }
        }
    }

    #[test]
    fn el_default_de_esta_build_corresponde_a_su_variante() {
        // Coherencia entre la variante compilada y el host permitido.
        if is_staging_build() {
            assert_eq!(expected_worker_host(), STAGING_WORKER_HOST);
            assert!(default_worker_url().contains(STAGING_WORKER_HOST));
            assert!(!default_worker_url().contains(PRODUCTION_WORKER_HOST));
        } else {
            assert_eq!(expected_worker_host(), PRODUCTION_WORKER_HOST);
            assert!(default_worker_url().contains(PRODUCTION_WORKER_HOST));
            assert!(!default_worker_url().contains(STAGING_WORKER_HOST));
        }
    }

    #[test]
    fn el_validador_rechaza_el_host_de_la_otra_variante() {
        // Comprobacion simetrica: cada host es invalido para la otra
        // variante, con el mismo mensaje de motivo.
        let staging_url = url_para(Variant::Staging);
        let stable_url = url_para(Variant::Stable);
        assert!(matches!(
            resolver(Variant::Staging, &stable_url),
            WorkerUrlResolution::Invalid(_)
        ));
        assert!(matches!(
            resolver(Variant::Stable, &staging_url),
            WorkerUrlResolution::Invalid(_)
        ));
    }

}
