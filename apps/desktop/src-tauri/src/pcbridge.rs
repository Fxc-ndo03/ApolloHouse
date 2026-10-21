//! Companion del PcBridge DO: abre un WebSocket directo desde el backend Rust
//! y ejecuta los comandos que el LLM pide por voz con los natives
//! `execute_pc_*` ya existentes (mismo proceso, sin piezas nuevas corriendo).
//!
//! Protocolo (apps/agent/src/protocol/schema.ts + agents/pc-bridge.ts):
//! companion -> Worker: hello {hostname}, command_result {id, ok, ...}, pong
//! Worker -> companion: apps_open/focus/close/list, lock_screen,
//! spotify_play/pause/next/previous/get_state, ping

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use futures_util::{SinkExt, StreamExt};
use tauri::AppHandle;
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// Versión del contrato device->Worker que anuncia este cliente. El Worker la
/// usa sólo para compatibilidad; no habilita capabilities por sí sola.
const PCBRIDGE_PROTOCOL_VERSION: i64 = 1;

#[derive(Clone)]
pub struct PcBridgeManager {
    task: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    lifecycle: Arc<tokio::sync::Mutex<()>>,
    running: Arc<AtomicBool>,
    connected: Arc<AtomicBool>,
}

impl PcBridgeManager {
    pub fn new() -> Self {
        Self {
            task: Arc::new(Mutex::new(None)),
            lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            running: Arc::new(AtomicBool::new(false)),
            connected: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn start(
        &self,
        _app: AppHandle,
        worker_url: String,
        device_secret: String,
        session_token: Option<String>,
        device_id: Option<String>,
    ) {
        // El arranque nativo y la UI pueden coincidir durante la transición de
        // sesión. Serializar el ciclo de vida evita abrir dos WebSockets.
        let _lifecycle = self.lifecycle.lock().await;
        if self.is_running() {
            return;
        }
        self.stop_current();
        self.running.store(true, Ordering::SeqCst);
        let running = self.running.clone();
        let connected = self.connected.clone();
        let task_handle = tauri::async_runtime::spawn(async move {
            run_reconnect_loop(worker_url, device_secret, session_token, device_id, running, connected)
                .await;
        });
        *self.task.lock().unwrap() = Some(task_handle);
    }

    pub async fn stop(&self) {
        let _lifecycle = self.lifecycle.lock().await;
        self.stop_current();
    }

    fn stop_current(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.connected.store(false, Ordering::SeqCst);
        if let Some(task_handle) = self.task.lock().unwrap().take() {
            task_handle.abort();
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }
}

impl Default for PcBridgeManager {
    fn default() -> Self {
        Self::new()
    }
}

/// wss://host/agents/apollo/default -> wss://host/agents/pc-bridge/pc-bridge
/// (el SDK rutéa por kebab-case del binding: PcBridge -> pc-bridge;
/// la instancia 'pc-bridge' es la misma que usa tools/pc.ts)
/// wss://host/agents/apollo/default -> wss://host/agents/pc-bridge/<deviceId>
/// (el SDK rutea por kebab-case del binding: PcBridge -> pc-bridge).
/// FASE 2.5: con identidad persistente, la instancia del bridge ES el
/// dispositivo — cada PC de la misma cuenta habla con SU instancia. Sin
/// identidad (legacy), la instancia compartida 'pc-bridge' sigue igual.
fn pcbridge_url(worker_url: &str, device_id: Option<&str>) -> String {
    let base = worker_url
        .split("/agents/")
        .next()
        .unwrap_or(worker_url)
        .trim_end_matches('/');
    match device_id {
        Some(device_id) if !device_id.trim().is_empty() => {
            let encoded: String = device_id.trim().to_string();
            format!("{base}/agents/pc-bridge/{encoded}")
        }
        _ => format!("{base}/agents/pc-bridge/pc-bridge"),
    }
}

fn local_hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "pc".to_string())
}

/// Un 401/403 o un cierre WS 1008 NO es transitorio: la autorización o el
/// binding fueron rechazados. Repetirlo con la misma credencial no lo corrige.
///
/// `true` = el loop debe detenerse hasta que cambie la sesion/configuracion.
pub fn is_authorization_failure(message: &str) -> bool {
    let lowered = message.to_lowercase();
    lowered.contains("401")
        || lowered.contains("403")
        || lowered.contains("1008")
        || lowered.contains("unauthorized")
        || lowered.contains("forbidden")
        || lowered.contains("session_invalid")
        || lowered.contains("credential_invalid")
        || lowered.contains("device_revoked")
        || lowered.contains("device_of_other_account")
        || lowered.contains("device_id_invalid")
}

/// El servidor no envía un `hello_ack` para el cliente desktop: el primer
/// marco de protocolo llega solamente después de aceptar el hello. No marcar
/// connected al escribir el hello evita falsos positivos en cierres 1008.
fn mark_connected_after_server_frame(frame: &serde_json::Value, connected: &AtomicBool) -> bool {
    let Some(frame_type) = frame.get("type").and_then(serde_json::Value::as_str) else {
        return false;
    };
    if frame_type.is_empty() {
        return false;
    }
    !connected.swap(true, Ordering::SeqCst)
}

async fn run_reconnect_loop(
    worker_url: String,
    device_secret: String,
    session_token: Option<String>,
    device_id: Option<String>,
    running: Arc<AtomicBool>,
    connected: Arc<AtomicBool>,
) {
    let mut backoff_seconds = 1u64;
    while running.load(Ordering::SeqCst) {
        match serve_once(&worker_url, &device_secret, &session_token, &device_id, &running, &connected).await {
            Ok(()) => {
                log::info!("pcbridge: conexion cerrada, reintentando");
                backoff_seconds = 1;
            }
            Err(error) => {
                if is_authorization_failure(&error) {
                    // El Worker staging actual admite sesión de cuenta en esta
                    // ruta y valida el binding del dispositivo dentro del DO.
                    // Un rechazo puede indicar sesión inválida, PC no enrolada
                    // o una versión remota incompatible. No registrar secretos.
                    connected.store(false, Ordering::SeqCst);
                    running.store(false, Ordering::SeqCst);
                    eprintln!(
                        "[apollo] pcbridge: NO DISPONIBLE (rechazo de autorización). \
                         Iniciá sesión nuevamente y confirmá que esta PC esté enrolada \
                         en staging. No se reintentará hasta corregir la autorización."
                    );
                    log::warn!("pcbridge: detenido por rechazo de autorizacion: {error}");
                    return;
                }
                log::warn!("pcbridge: {error} (reintento en {backoff_seconds}s)");
                eprintln!("[apollo] pcbridge: {error} (reintento en {backoff_seconds}s)");
                backoff_seconds = (backoff_seconds * 2).min(60);
            }
        }
        connected.store(false, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_secs(backoff_seconds)).await;
    }
}

async fn serve_once(
    worker_url: &str,
    device_secret: &str,
    session_token: &Option<String>,
    device_id: &Option<String>,
    running: &Arc<AtomicBool>,
    connected: &Arc<AtomicBool>,
) -> Result<(), String> {
    // FASE 2.4: con sesión de cuenta, la credencial viaja en
    // `Authorization: Bearer` (el mismo camino que la conversación); el
    // deviceId persistente de la instalación va en el `hello` para que el
    // Worker lo verifique contra el binding cuenta↔dispositivo. Sin sesión,
    // el camino legacy (secreto en header `X-Apollo-Device-Secret`) sigue
    // funcionando igual que siempre.
    let bridge_target = pcbridge_url(worker_url, device_id.as_deref());
    let request = match session_token {
        Some(token) if !token.is_empty() => crate::cloudcore::build_account_request(&bridge_target, token),
        _ => crate::cloudcore::build_secret_request(&bridge_target, device_secret),
    }
    .map_err(|e| format!("request build fallo: {e}"))?;
    let (socket, _) = connect_async(request)
        .await
        .map_err(|e| format!("connect fallo: {e}"))?;
    let (mut writer, mut reader) = socket.split();

    let mut hello = serde_json::json!({
        "type": "hello",
        "hostname": local_hostname(),
        // BLOCK 5: el Worker usa esto para decidir si el contrato de
        // capabilities del cliente es compatible. Si el cliente no lo manda,
        // el worker aplica la politica legacy.
        "protocolVersion": PCBRIDGE_PROTOCOL_VERSION,
        "ts": chrono::Utc::now().timestamp_millis(),
    });
    if let Some(persistent_device_id) = device_id {
        if !persistent_device_id.trim().is_empty() {
            hello["deviceId"] = serde_json::Value::String(persistent_device_id.clone());
        }
    }
    writer
        .send(Message::Text(hello.to_string().into()))
        .await
        .map_err(|e| format!("hello fallo: {e}"))?;

    while running.load(Ordering::SeqCst) {
        let incoming = reader
            .next()
            .await
            .ok_or_else(|| "stream cerrado".to_string())?
            .map_err(|e| format!("read fallo: {e}"))?;
        let frame_text = match incoming {
            Message::Close(Some(frame)) => {
                return Err(format!("websocket close {}: {}", frame.code, frame.reason));
            }
            Message::Close(None) => return Err("websocket close sin código".to_string()),
            Message::Text(frame_text) => frame_text,
            _ => continue,
        };
        let frame: serde_json::Value = serde_json::from_str(&frame_text)
            .map_err(|e| format!("frame invalido: {e}"))?;
        if mark_connected_after_server_frame(&frame, connected) {
            log::info!("pcbridge: conectado");
            eprintln!("[apollo] pcbridge: conectado");
        }
        handle_frame(&mut writer, &frame).await?;
    }
    Ok(())
}

async fn handle_frame<S>(
    writer: &mut S,
    frame: &serde_json::Value,
) -> Result<(), String>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let frame_type = frame.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if frame_type == "ping" {
        let pong = serde_json::json!({
            "type": "pong",
            "ts": chrono::Utc::now().timestamp_millis(),
        });
        writer
            .send(Message::Text(pong.to_string().into()))
            .await
            .map_err(|e| format!("pong fallo: {e}"))?;
        return Ok(());
    }
    let Some(command_id) = frame.get("id").and_then(|id| id.as_str()) else {
        return Ok(());
    };
    let (ok, result, error) = dispatch_command(frame).await;
    eprintln!(
        "[pcbridge] comando {} app={} ok={} err={}",
        frame.get("type").and_then(|t| t.as_str()).unwrap_or("?"),
        frame.get("appName").and_then(|n| n.as_str()).unwrap_or("-"),
        ok,
        error.as_deref().unwrap_or("-")
    );
    let mut reply = serde_json::Map::new();
    reply.insert("type".to_string(), serde_json::Value::String("command_result".to_string()));
    reply.insert("id".to_string(), serde_json::Value::String(command_id.to_string()));
    reply.insert("ok".to_string(), serde_json::Value::Bool(ok));
    if let Some(result_value) = result {
        reply.insert("result".to_string(), result_value);
    }
    if let Some(error_text) = error {
        reply.insert("error".to_string(), serde_json::Value::String(error_text));
    }
    reply.insert(
        "ts".to_string(),
        serde_json::Value::Number(chrono::Utc::now().timestamp_millis().into()),
    );
    writer
        .send(Message::Text(
            serde_json::Value::Object(reply).to_string().into(),
        ))
        .await
        .map_err(|e| format!("command_result fallo: {e}"))?;
    Ok(())
}

/// Ejecuta el comando y normaliza a (ok, result, error).
async fn dispatch_command(
    frame: &serde_json::Value,
) -> (bool, Option<serde_json::Value>, Option<String>) {
    let frame_type = frame.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let raw_app_name = frame
        .get("appName")
        .and_then(|name| name.as_str())
        .unwrap_or("");
    let app_name = crate::commands::normalize_app_name(raw_app_name);
    match frame_type {
        "apps_open" => {
            let args = frame
                .get("args")
                .and_then(|a| a.as_str())
                .map(|a| a.to_string());
            normalize(crate::commands::execute_pc_open_app(app_name, args).await)
        }
        "apps_focus" => normalize(crate::commands::execute_pc_focus_app(app_name).await),
        "apps_close" => normalize(crate::commands::execute_pc_close_app(app_name).await),
        "lock_screen" => normalize(crate::commands::execute_pc_lock_screen().await),
        "apps_list" => normalize(native_apps_list().await),
        "volume_up" | "volume_down" => {
            let Some(virtual_key) = volume_virtual_key(frame_type) else {
                return (false, None, Some(format!("comando no soportado: {frame_type}")));
            };
            normalize(native_media_key(virtual_key).await)
        }
        "spotify_play" => normalize(native_media_key(0xB3).await),
        "spotify_pause" => normalize(native_media_key(0xB3).await),
        "spotify_next" => normalize(native_media_key(0xB0).await),
        "spotify_previous" => normalize(native_media_key(0xB1).await),
        "spotify_get_state" => (
            false,
            None,
            Some("estado de Spotify requiere Spotify Web API".to_string()),
        ),
        _ => (
            false,
            None,
            Some(format!("comando no soportado: {frame_type}")),
        ),
    }
}

fn volume_virtual_key(command_type: &str) -> Option<u8> {
    match command_type {
        "volume_up" => Some(0xAF),
        "volume_down" => Some(0xAE),
        _ => None,
    }
}

/// Los natives devuelven Ok({ok, ...}) incluso al fallar: se lee el ok interno.
fn normalize(
    outcome: Result<serde_json::Value, String>,
) -> (bool, Option<serde_json::Value>, Option<String>) {
    match outcome {
        Ok(value) => {
            let ok = value.get("ok").and_then(|o| o.as_bool()).unwrap_or(true);
            if ok {
                (true, Some(value), None)
            } else {
                let error = value
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("fallo nativo")
                    .to_string();
                (false, None, Some(error))
            }
        }
        Err(error) => (false, None, Some(error)),
    }
}

async fn native_apps_list() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Name,MainWindowTitle | ForEach-Object { \"$($_.Name)|$($_.MainWindowTitle)\" }",
            ])
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let app_list: Vec<serde_json::Value> = stdout
            .lines()
            .filter_map(|line| {
                let (name, title) = line.split_once('|')?;
                if name.trim().is_empty() {
                    return None;
                }
                Some(serde_json::json!({ "name": name.trim(), "title": title.trim() }))
            })
            .collect();
        Ok(serde_json::json!({ "ok": true, "apps": app_list }))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(serde_json::json!({ "ok": false, "error": "Solo soportado en Windows" }))
    }
}

/// Tecla multimedia global (play/pausa, siguiente, anterior) via keybd_event.
async fn native_media_key(virtual_key: u8) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let script = format!(
            r#"
            Add-Type @"
            using System;
            using System.Runtime.InteropServices;
            public class MediaKeys {{
                [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
            }}
"@
            [MediaKeys]::keybd_event({virtual_key}, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 50
            [MediaKeys]::keybd_event({virtual_key}, 0, 2, [UIntPtr]::Zero)
            "#
        );
        let output = Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(serde_json::json!({ "ok": true }))
        } else {
            Ok(serde_json::json!({
                "ok": false,
                "error": String::from_utf8_lossy(&output.stderr).to_string()
            }))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = virtual_key;
        Ok(serde_json::json!({ "ok": false, "error": "Solo soportado en Windows" }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_401_es_autorizacion_y_no_una_caida_de_red() {
        assert!(is_authorization_failure("connect fallo: HTTP error: 401 Unauthorized"));
        assert!(is_authorization_failure("connect fallo: HTTP error: 403 Forbidden"));
        assert!(is_authorization_failure("websocket close 1008: session_invalid"));
    }

    #[test]
    fn un_500_o_un_timeout_sigue_siendo_reintentable() {
        assert!(!is_authorization_failure("connect fallo: HTTP error: 500 Internal Server Error"));
        assert!(!is_authorization_failure("connect fallo: timeout"));
        assert!(!is_authorization_failure("handshake fallo de red"));
    }

    #[test]
    fn el_hello_no_marca_conectado_hasta_recibir_un_marco_del_servidor() {
        let connected = AtomicBool::new(false);
        assert!(!mark_connected_after_server_frame(
            &serde_json::json!({}),
            &connected
        ));
        assert!(!connected.load(Ordering::SeqCst));

        assert!(mark_connected_after_server_frame(
            &serde_json::json!({ "type": "ping", "ts": 1 }),
            &connected
        ));
        assert!(connected.load(Ordering::SeqCst));
        assert!(!mark_connected_after_server_frame(
            &serde_json::json!({ "type": "ping", "ts": 2 }),
            &connected
        ));
    }

    #[test]
    fn la_instancia_autenticada_del_bridge_coincide_con_el_device_id() {
        assert_eq!(
            pcbridge_url(
                "wss://apollo-staging.facupapollo.workers.dev/agents/apollo/default",
                Some("desktop:installation-123"),
            ),
            "wss://apollo-staging.facupapollo.workers.dev/agents/pc-bridge/desktop:installation-123"
        );
    }

    #[test]
    fn el_cliente_legacy_conserva_la_instancia_compartida() {
        assert_eq!(
            pcbridge_url("wss://worker.example/agents/apollo/default", None),
            "wss://worker.example/agents/pc-bridge/pc-bridge"
        );
    }

    #[test]
    fn asigna_teclas_multimedia_para_subir_y_bajar_volumen() {
        assert_eq!(volume_virtual_key("volume_up"), Some(0xAF));
        assert_eq!(volume_virtual_key("volume_down"), Some(0xAE));
        assert_eq!(volume_virtual_key("unknown"), None);
    }

}
