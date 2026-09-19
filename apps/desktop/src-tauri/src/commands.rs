//! Tauri commands for Apollo Desktop

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::sidecar::SidecarManager;
use crate::state::{AppSettings, AppState, ConnectionStatus, OrbState};

/// Orb window commands
#[tauri::command]
pub async fn show_orb_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_orb_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn show_chat_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("chat") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_chat_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("chat") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn show_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Sidecar management commands
#[tauri::command]
pub async fn start_sidecar(
    app: AppHandle,
    state: State<'_, AppState>,
    sidecar: State<'_, SidecarManager>,
    settings: State<'_, Mutex<AppSettings>>,
) -> Result<(), String> {
    let config = settings.lock().unwrap().clone();
    let worker_url = config.worker_url.clone();
    let device_secret = config.device_shared_secret.clone();
    let wake_words = config.wake_words.clone();
    let use_vosk = config.use_vosk_wake;
    let model_dir = config.wake_model_dir.clone();
    let use_local_core = config.use_local_core;
    let core_lan_url = config.core_lan_url.clone();
    let response_output_target = config.response_output_target.clone();

    if worker_url.is_empty() || device_secret.is_empty() {
        return Err("Worker URL y Device Shared Secret son requeridos".into());
    }

    sidecar
        .start(
            worker_url,
            device_secret,
            wake_words,
            use_vosk,
            model_dir,
            app.clone(),
            use_local_core,
            core_lan_url,
            response_output_target,
        )
        .await
        .map_err(|e| e.to_string())?;

    state.set_connection_status(ConnectionStatus::Connecting).await;
    eprintln!("[apollo] comando start_sidecar ejecutado, sidecar conectando");
    Ok(())
}

#[tauri::command]
pub async fn stop_sidecar(
    state: State<'_, AppState>,
    sidecar: State<'_, SidecarManager>,
) -> Result<(), String> {
    sidecar.stop().await.map_err(|e| e.to_string())?;
    state.set_connection_status(ConnectionStatus::Disconnected).await;
    Ok(())
}

#[tauri::command]
pub async fn get_sidecar_status(state: State<'_, AppState>) -> Result<SidecarStatus, String> {
    let status = state.get_sidecar_status().await;
    eprintln!(
        "[apollo] comando get_sidecar_status ejecutado: running={} conn={:?}",
        status.running, status.connection_status
    );
    Ok(status)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SidecarStatus {
    pub running: bool,
    pub connection_status: ConnectionStatus,
    pub current_orb_state: OrbState,
}

/// PC Commands (sent via PcBridge) - these are invoked from frontend to send to sidecar
#[tauri::command]
pub async fn pc_open_app(app: AppHandle, app_name: String, args: Option<String>) -> Result<(), String> {
    send_pc_command(&app, "apps_open", serde_json::json!({ "appName": app_name, "args": args })).await.map(|_| ())
}

// Native Windows command execution (called from sidecar or frontend)
#[tauri::command]
pub async fn execute_pc_open_app(app_name: String, args: Option<String>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let target = resolve_app_target(&app_name);
        eprintln!("[pc] abrir '{app_name}' -> {target:?}");

        let (launch_path, launch_args) = match &target {
            AppTarget::StoreAppId(_) => (
                "explorer.exe".to_string(),
                Some(target.launch_argument()),
            ),
            _ => (
                target.launch_path().to_string(),
                args.clone().filter(|a| !a.trim().is_empty()),
            ),
        };
        let mut cmd = Command::new("powershell");
        cmd.creation_flags(0x08000000);
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]);

        let ps_script = match launch_args {
            Some(given_args) => format!(
                "Start-Process -FilePath '{}' -ArgumentList '{}' -ErrorAction Stop",
                launch_path.replace("'", "''"),
                given_args.replace("'", "''")
            ),
            None => format!(
                "Start-Process -FilePath '{}' -ErrorAction Stop",
                launch_path.replace("'", "''")
            ),
        };
        cmd.arg(&ps_script);

        match cmd.output() {
            Ok(output) => {
                if output.status.success() {
                    Ok(serde_json::json!({ "ok": true, "app": app_name }))
                } else {
                    let err = String::from_utf8_lossy(&output.stderr);
                    Ok(serde_json::json!({ "ok": false, "error": err.to_string() }))
                }
            }
            Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(serde_json::json!({ "ok": false, "error": "Solo soportado en Windows" }))
    }
}

/// Adónde apunta un nombre de app, resuelto dinámicamente para no mantener
/// una tabla por aplicación: App Paths del registro, accesos del menú inicio
/// y apps de la tienda (UWP). En ese orden.
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, PartialEq, Eq)]
enum AppTarget {
    DirectPath(String),
    StartMenuShortcut(String),
    StoreAppId(String),
}

#[cfg(target_os = "windows")]
impl AppTarget {
    fn launch_path(&self) -> &str {
        match self {
            AppTarget::DirectPath(path) => path,
            AppTarget::StartMenuShortcut(path) => path,
            AppTarget::StoreAppId(_) => "explorer.exe",
        }
    }

    fn launch_argument(&self) -> String {
        match self {
            AppTarget::StoreAppId(app_id) => format!("shell:AppsFolder\\{app_id}"),
            _ => String::new(),
        }
    }
}

/// Normaliza lo que el modelo manda ("el Bloc de Notas", "Discord.exe") a un
/// nombre canónico en minúsculas para buscarlo en el sistema.
pub(crate) fn normalize_app_name(raw_name: &str) -> String {
    let cleaned = raw_name
        .trim()
        .to_lowercase()
        .trim_end_matches(".exe")
        .trim()
        .to_string();
    let without_article = cleaned
        .strip_prefix("el ")
        .or_else(|| cleaned.strip_prefix("la "))
        .or_else(|| cleaned.strip_prefix("los "))
        .or_else(|| cleaned.strip_prefix("las "))
        .or_else(|| cleaned.strip_prefix("un "))
        .or_else(|| cleaned.strip_prefix("una "))
        .unwrap_or(&cleaned)
        .to_string();
    match without_article.as_str() {
        "bloc de notas" | "bloc" | "notas" | "notepad" => "notepad".to_string(),
        "navegador" | "browser" | "navegar" | "brave" => "brave".to_string(),
        "edge" | "msedge" | "microsoft edge" => "msedge".to_string(),
        "chrome" | "google chrome" => "chrome".to_string(),
        "firefox" => "firefox".to_string(),
        "explorador" | "explorador de archivos" | "archivos" | "carpeta" | "carpetas"
        | "explorer" => "explorer".to_string(),
        "calculadora" | "calc" => "calc".to_string(),
        "spotify" | "musica" | "música" => "spotify".to_string(),
        "codigo" | "código" | "vscode" | "visual studio code" | "code" => "code".to_string(),
        "terminal" | "consola" | "powershell" => "powershell".to_string(),
        "configuracion" | "configuración" | "ajustes" => "ms-settings:".to_string(),
        _ => without_article,
    }
}

#[cfg(target_os = "windows")]
fn expand_env_vars(raw_path: &str) -> String {
    let mut expanded = String::with_capacity(raw_path.len());
    let mut rest = raw_path;
    while let Some(start) = rest.find('%') {
        expanded.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let var_name = &after[..end];
                expanded.push_str(
                    &std::env::var(var_name).unwrap_or_else(|_| format!("%{var_name}%")),
                );
                rest = &after[end + 1..];
            }
            None => {
                expanded.push('%');
                rest = after;
            }
        }
    }
    expanded.push_str(rest);
    expanded
}

#[cfg(target_os = "windows")]
fn lookup_app_paths(exe_name: &str) -> Option<String> {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE};
    let candidates = if exe_name.to_lowercase().ends_with(".exe") {
        vec![exe_name.to_string()]
    } else {
        vec![format!("{exe_name}.exe"), exe_name.to_string()]
    };
    for hive in [LOCAL_MACHINE, CURRENT_USER] {
        for candidate in &candidates {
            let key_path = format!(
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{candidate}"
            );
            if let Ok(key) = hive.open(&key_path) {
                if let Ok(target) = key.get_string("") {
                    let expanded = expand_env_vars(target.trim());
                    if !expanded.is_empty() {
                        return Some(expanded);
                    }
                }
            }
        }
    }
    None
}

/// 3 = igual, 2 = prefijo (en cualquier dirección), 1 = contiene, 0 = nada.
fn score_start_menu_match(query: &str, shortcut_stem: &str) -> u8 {
    let query = query.trim().to_lowercase();
    let stem = shortcut_stem.trim().to_lowercase();
    if query.is_empty() || stem.is_empty() {
        return 0;
    }
    if query == stem {
        return 3;
    }
    if stem.starts_with(&query) || query.starts_with(&stem) {
        return 2;
    }
    if stem.contains(&query) || query.contains(&stem) {
        return 1;
    }
    0
}

#[cfg(target_os = "windows")]
fn find_start_menu_shortcut(query: &str) -> Option<String> {
    use std::path::PathBuf;
    fn collect_shortcuts(directory: PathBuf, found: &mut Vec<(String, String)>, depth: u8) {
        if depth == 0 {
            return;
        }
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_shortcuts(path, found, depth - 1);
            } else if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("lnk")) {
                let stem = path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or("")
                    .to_string();
                found.push((stem, path.to_string_lossy().to_string()));
            }
        }
    }

    let mut menu_roots = Vec::new();
    if let Some(roaming) = dirs::data_dir() {
        menu_roots.push(roaming.join("Microsoft").join("Windows").join("Start Menu").join("Programs"));
    }
    if let Ok(program_data) = std::env::var("PROGRAMDATA") {
        menu_roots.push(
            PathBuf::from(program_data)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    let mut candidates: Vec<(String, String)> = Vec::new();
    for root in menu_roots {
        collect_shortcuts(root, &mut candidates, 5);
    }
    candidates.sort_by(|left, right| {
        score_start_menu_match(query, &right.0)
            .cmp(&score_start_menu_match(query, &left.0))
            .then_with(|| left.0.len().cmp(&right.0.len()))
    });
    let best = candidates.first()?;
    if score_start_menu_match(query, &best.0) == 0 {
        return None;
    }
    Some(best.1.clone())
}

#[cfg(target_os = "windows")]
fn find_store_app_id(query: &str) -> Option<String> {
    use std::process::Command;
    let safe_query = query.replace("'", "").replace('"', "").replace(';', "");
    let script = format!(
        "Get-StartApps | Where-Object {{ $_.Name -like '*{safe_query}*' }} | Select-Object -First 3 Name, AppID | ConvertTo-Json -Compress"
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let payload: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let entries: Vec<serde_json::Value> = match payload {
        serde_json::Value::Array(items) => items,
        single => vec![single],
    };
    entries.into_iter().find_map(|entry| {
        entry
            .get("AppID")
            .and_then(|id| id.as_str())
            .map(|id| id.to_string())
    })
}

#[cfg(target_os = "windows")]
fn resolve_app_target(app_name: &str) -> AppTarget {
    let trimmed = app_name.trim();
    if trimmed.contains(['\\', '/'])
        || trimmed.to_lowercase().ends_with(".exe")
        || trimmed.to_lowercase().ends_with(".lnk")
        || trimmed.to_lowercase().ends_with(".msc")
    {
        return AppTarget::DirectPath(trimmed.to_string());
    }
    if let Some(registered_path) = lookup_app_paths(trimmed) {
        return AppTarget::DirectPath(registered_path);
    }
    if let Some(shortcut_path) = find_start_menu_shortcut(trimmed) {
        return AppTarget::StartMenuShortcut(shortcut_path);
    }
    if let Some(store_id) = find_store_app_id(trimmed) {
        return AppTarget::StoreAppId(store_id);
    }
    AppTarget::DirectPath(trimmed.to_string())
}

#[tauri::command]
pub async fn execute_pc_focus_app(app_name: String) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let ps_script = format!(
            r#"
            Add-Type @"
            using System;
            using System.Runtime.InteropServices;
            public class WinAPI {{
                [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
                [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
                [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
            }}
"@
            $processes = Get-Process -Name '{}' -ErrorAction SilentlyContinue
            foreach ($p in $processes) {{
                if ($p.MainWindowHandle -ne 0) {{
                    if ([WinAPI]::IsIconic($p.MainWindowHandle)) {{
                        [WinAPI]::ShowWindowAsync($p.MainWindowHandle, 9) # SW_RESTORE
                    }}
                    [WinAPI]::SetForegroundWindow($p.MainWindowHandle)
                    break
                }}
            }}
            "#,
            app_name.replace("'", "''")
        );

        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps_script]);

        match cmd.output() {
            Ok(output) => {
                if output.status.success() {
                    Ok(serde_json::json!({ "ok": true, "app": app_name }))
                } else {
                    let err = String::from_utf8_lossy(&output.stderr);
                    Ok(serde_json::json!({ "ok": false, "error": err.to_string() }))
                }
            }
            Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(serde_json::json!({ "ok": false, "error": "Solo soportado en Windows" }))
    }
}

#[tauri::command]
pub async fn execute_pc_close_app(app_name: String) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let ps_script = format!(
            "Stop-Process -Name '{}' -Force -ErrorAction SilentlyContinue",
            app_name.replace("'", "''")
        );

        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps_script]);

        match cmd.output() {
            Ok(output) => {
                if output.status.success() {
                    Ok(serde_json::json!({ "ok": true, "app": app_name }))
                } else {
                    let err = String::from_utf8_lossy(&output.stderr);
                    Ok(serde_json::json!({ "ok": false, "error": err.to_string() }))
                }
            }
            Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(serde_json::json!({ "ok": false, "error": "Solo soportado en Windows" }))
    }
}

#[tauri::command]
pub async fn execute_pc_lock_screen() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let mut cmd = Command::new("rundll32.exe");
        cmd.args(["user32.dll", "LockWorkStation"]);

        match cmd.output() {
            Ok(output) => {
                if output.status.success() {
                    Ok(serde_json::json!({ "ok": true }))
                } else {
                    let err = String::from_utf8_lossy(&output.stderr);
                    Ok(serde_json::json!({ "ok": false, "error": err.to_string() }))
                }
            }
            Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(serde_json::json!({ "ok": false, "error": "Solo soportado en Windows" }))
    }
}

#[tauri::command]
pub async fn pc_focus_app(app: AppHandle, app_name: String) -> Result<(), String> {
    send_pc_command(&app, "apps_focus", serde_json::json!({ "appName": app_name })).await.map(|_| ())
}

#[tauri::command]
pub async fn pc_close_app(app: AppHandle, app_name: String) -> Result<(), String> {
    send_pc_command(&app, "apps_close", serde_json::json!({ "appName": app_name })).await.map(|_| ())
}

#[tauri::command]
pub async fn pc_lock_screen(app: AppHandle) -> Result<(), String> {
    send_pc_command(&app, "lock_screen", serde_json::json!({})).await.map(|_| ())
}

#[tauri::command]
pub async fn pc_list_apps(app: AppHandle) -> Result<serde_json::Value, String> {
    send_pc_command(&app, "apps_list", serde_json::json!({})).await
}

#[tauri::command]
pub async fn pc_spotify_play(app: AppHandle) -> Result<(), String> {
    send_pc_command(&app, "spotify_play", serde_json::json!({})).await.map(|_| ())
}

#[tauri::command]
pub async fn pc_spotify_pause(app: AppHandle) -> Result<(), String> {
    send_pc_command(&app, "spotify_pause", serde_json::json!({})).await.map(|_| ())
}

#[tauri::command]
pub async fn pc_spotify_next(app: AppHandle) -> Result<(), String> {
    send_pc_command(&app, "spotify_next", serde_json::json!({})).await.map(|_| ())
}

#[tauri::command]
pub async fn pc_spotify_previous(app: AppHandle) -> Result<(), String> {
    send_pc_command(&app, "spotify_previous", serde_json::json!({})).await.map(|_| ())
}

#[tauri::command]
pub async fn pc_spotify_get_state(app: AppHandle) -> Result<serde_json::Value, String> {
    send_pc_command(&app, "spotify_get_state", serde_json::json!({})).await
}

async fn send_pc_command(
    app: &AppHandle,
    command_type: &str,
    extra: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // Emit to sidecar which forwards to PcBridge
    let id = Uuid::new_v4().to_string();
    let mut fields = serde_json::Map::new();
    fields.insert(
        "type".to_string(),
        serde_json::Value::String(command_type.to_string()),
    );
    fields.insert("id".to_string(), serde_json::Value::String(id.clone()));
    if let serde_json::Value::Object(extra_fields) = extra {
        fields.extend(extra_fields);
    }
    fields.insert(
        "ts".to_string(),
        serde_json::Value::Number(chrono::Utc::now().timestamp_millis().into()),
    );
    let message = serde_json::Value::Object(fields);

    app.emit("pc-command", message).map_err(|e| e.to_string())?;

    // For now return success; the sidecar will handle the actual WebSocket send
    Ok(serde_json::json!({ "id": id, "sent": true }))
}

/// Settings
#[tauri::command]
pub async fn get_settings(settings: State<'_, Mutex<AppSettings>>) -> Result<AppSettingsData, String> {
    let s = settings.lock().unwrap();
    eprintln!(
        "[apollo] comando get_settings ejecutado: url={} secret={}",
        if s.worker_url.is_empty() { "(vacia)" } else { "(ok)" },
        if s.device_shared_secret.is_empty() { "(vacio)" } else { "(ok)" }
    );
    Ok(AppSettingsData {
        worker_url: s.worker_url.clone(),
        device_shared_secret: s.device_shared_secret.clone(),
        wake_words: s.wake_words.clone(),
        use_vosk_wake: s.use_vosk_wake,
        wake_model_dir: s.wake_model_dir.clone(),
        response_output_target: s.response_output_target.clone(),
        autostart_enabled: s.autostart_enabled,
    })
}

#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    settings: State<'_, Mutex<AppSettings>>,
    sidecar: State<'_, SidecarManager>,
    data: AppSettingsData,
) -> Result<(), String> {
    let mut updated = settings.lock().unwrap().clone();
    updated.worker_url = data.worker_url;
    updated.device_shared_secret = data.device_shared_secret;
    updated.wake_words = data.wake_words;
    updated.use_vosk_wake = data.use_vosk_wake;
    updated.wake_model_dir = data.wake_model_dir;
    updated.response_output_target = data.response_output_target;
    updated.autostart_enabled = data.autostart_enabled;
    updated.save(&app).await.map_err(|e| e.to_string())?;
    *settings.lock().unwrap() = updated.clone();
    // Propagar el target de audio al sidecar en vivo (aplica sin reiniciar).
    sidecar
        .send_json(&serde_json::json!({
            "action": "set_response_output_target",
            "target": updated.response_output_target,
        }))
        .await
        .or_else(|_| {
            // Sidecar puede no estar corriendo; se aplica al conectar vía env.
            Ok::<(), String>(())
        })?;
    Ok(())
}

/// Aplica el target de salida de audio al instante (radios de Settings).
#[tauri::command]
pub async fn set_response_output_target(
    app: AppHandle,
    settings: State<'_, Mutex<AppSettings>>,
    sidecar: State<'_, SidecarManager>,
    target: String,
) -> Result<(), String> {
    if target != "pc" && target != "server" {
        return Err(format!("target '{target}' inválido (pc o server)"));
    }
    {
        let mut stored = settings.lock().unwrap().clone();
        stored.response_output_target = target.clone();
        stored.save(&app).await.map_err(|e| e.to_string())?;
        *settings.lock().unwrap() = stored;
    }
    sidecar
        .send_json(&serde_json::json!({
            "action": "set_response_output_target",
            "target": target,
        }))
        .await
        .or_else(|_| {
            // Sidecar puede no estar corriendo; se aplica al conectar vía env.
            Ok::<(), String>(())
        })?;
    Ok(())
}

/// Autostart con Windows (tauri-plugin-autostart + persistencia en settings)
#[tauri::command]
pub fn get_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_autostart_enabled(
    app: AppHandle,
    settings: State<'_, Mutex<AppSettings>>,
    enabled: bool,
) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable()
    } else {
        manager.disable()
    }
    .map_err(|e| e.to_string())?;
    let mut stored = settings.lock().unwrap().clone();
    stored.autostart_enabled = enabled;
    stored.save(&app).await.map_err(|e| e.to_string())?;
    *settings.lock().unwrap() = stored;
    Ok(())
}

#[tauri::command]
pub async fn set_mic_muted(
    app: AppHandle,
    settings: State<'_, Mutex<AppSettings>>,
    sidecar: State<'_, SidecarManager>,
    muted: bool,
) -> Result<(), String> {
    {
        let mut stored = settings.lock().unwrap().clone();
        stored.mic_muted = muted;
        stored.save(&app).await.map_err(|e| e.to_string())?;
        *settings.lock().unwrap() = stored;
    }
    sidecar
        .send_json(&serde_json::json!({ "action": "set_mic_muted", "muted": muted }))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_tts_muted(
    app: AppHandle,
    settings: State<'_, Mutex<AppSettings>>,
    sidecar: State<'_, SidecarManager>,
    muted: bool,
) -> Result<(), String> {
    {
        let mut stored = settings.lock().unwrap().clone();
        stored.tts_muted = muted;
        stored.save(&app).await.map_err(|e| e.to_string())?;
        *settings.lock().unwrap() = stored;
    }
    sidecar
        .send_json(&serde_json::json!({ "action": "set_tts_muted", "muted": muted }))
        .await
        .or_else(|_| {
            // sidecar puede no estar aún; el estado persiste igual y se aplica al conectar
            Ok::<(), String>(())
        })?;
    Ok(())
}

/// Companion del PcBridge DO (comandos por voz hacia esta PC)
#[tauri::command]
pub async fn start_pcbridge(
    app: AppHandle,
    bridge: State<'_, crate::pcbridge::PcBridgeManager>,
    settings: State<'_, Mutex<AppSettings>>,
) -> Result<(), String> {
    let config = settings.lock().unwrap().clone();
    if config.worker_url.is_empty() || config.device_shared_secret.is_empty() {
        return Err("Worker URL y Device Shared Secret son requeridos".into());
    }
    bridge
        .start(
            app.clone(),
            config.worker_url,
            config.device_shared_secret,
        )
        .await;
    Ok(())
}

#[tauri::command]
pub async fn stop_pcbridge(
    bridge: State<'_, crate::pcbridge::PcBridgeManager>,
) -> Result<(), String> {
    bridge.stop().await;
    Ok(())
}

#[tauri::command]
pub async fn pcbridge_status(
    bridge: State<'_, crate::pcbridge::PcBridgeManager>,
) -> Result<PcBridgeStatus, String> {
    Ok(PcBridgeStatus {
        running: bridge.is_running(),
        connected: bridge.is_connected(),
    })
}

/// Manual push-to-talk hacia el sidecar (empujon manual, no reemplaza al wake word)
#[tauri::command]
pub async fn manual_listen_start(
    sidecar: State<'_, SidecarManager>,
) -> Result<(), String> {
    sidecar
        .send_action("start_listening")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn manual_listen_stop(
    sidecar: State<'_, SidecarManager>,
) -> Result<(), String> {
    sidecar
        .send_action("stop_listening")
        .await
        .map_err(|e| e.to_string())
}

/// Texto y confirmaciones UI -> Worker via stdin del sidecar.
/// (El evento Tauri 'pc-command' no cruza procesos: esto si llega.)
#[tauri::command]
pub async fn send_text_to_sidecar(
    sidecar: State<'_, SidecarManager>,
    text: String,
) -> Result<(), String> {
    sidecar
        .send_json(&serde_json::json!({ "action": "send_text", "text": text }))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_confirm_to_sidecar(
    sidecar: State<'_, SidecarManager>,
    ok: bool,
) -> Result<(), String> {
    sidecar
        .send_json(&serde_json::json!({ "action": "send_confirm", "ok": ok }))
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PcBridgeStatus {
    pub running: bool,
    pub connected: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettingsData {
    pub worker_url: String,
    pub device_shared_secret: String,
    pub wake_words: Vec<String>,
    pub use_vosk_wake: bool,
    pub wake_model_dir: Option<String>,
    pub response_output_target: String,
    pub autostart_enabled: bool,
}

/// Protocol message handler (called from sidecar)
#[tauri::command]
pub async fn on_protocol_message(
    app: AppHandle,
    state: State<'_, AppState>,
    message: ProtocolMessage,
) -> Result<(), String> {
    match message {
        ProtocolMessage::UiState(msg) => {
            state.set_orb_state(OrbState::from_ui_state(&msg.state)).await;
            app.emit("orb-state-change", &msg.state).map_err(|e| e.to_string())?;
        }
        ProtocolMessage::TtsStart(msg) => {
            state.set_orb_state(OrbState::Speaking).await;
            app.emit("tts-start", msg).map_err(|e| e.to_string())?;
        }
        ProtocolMessage::TtsEnd => {
            state.set_orb_state(OrbState::Idle).await;
            app.emit("tts-end", ()).map_err(|e| e.to_string())?;
        }
        ProtocolMessage::TtsAborted => {
            state.set_orb_state(OrbState::Idle).await;
            app.emit("tts-aborted", ()).map_err(|e| e.to_string())?;
        }
        ProtocolMessage::TurnEnd(msg) => {
            app.emit("turn-end", msg).map_err(|e| e.to_string())?;
        }
        ProtocolMessage::ConfirmRequest(msg) => {
            app.emit("confirm-request", msg).map_err(|e| e.to_string())?;
        }
        ProtocolMessage::Error(msg) => {
            state.set_orb_state(OrbState::Error).await;
            app.emit("error", msg).map_err(|e| e.to_string())?;
        }
        ProtocolMessage::PlayEffect(msg) => {
            app.emit("play-effect", msg).map_err(|e| e.to_string())?;
        }
        ProtocolMessage::AlarmRing(msg) => {
            state.set_orb_state(OrbState::Alarm).await;
            app.emit("alarm-ring", msg).map_err(|e| e.to_string())?;
        }
        ProtocolMessage::SetResponseOutputTarget(msg) => {
            app.emit("response-output-target", msg).map_err(|e| e.to_string())?;
        }
        ProtocolMessage::ConnectionState(msg) => {
            let status = match msg.state.as_str() {
                "disconnected" => ConnectionStatus::Disconnected,
                "connecting" => ConnectionStatus::Connecting,
                "connected" => ConnectionStatus::Connected,
                "authenticated" => ConnectionStatus::Authenticated,
                "error" => ConnectionStatus::Error(msg.error.unwrap_or_else(|| "unknown".to_string())),
                _ => ConnectionStatus::Disconnected,
            };
            state.set_connection_status(status).await;
        }
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum ProtocolMessage {
    UiState(UiStateMessage),
    TtsStart(TtsStartMessage),
    TtsEnd,
    TtsAborted,
    TurnEnd(TurnEndMessage),
    ConfirmRequest(ConfirmRequestMessage),
    Error(ErrorMessage),
    PlayEffect(PlayEffectMessage),
    AlarmRing(AlarmRingMessage),
    SetResponseOutputTarget(SetResponseOutputTargetMessage),
    ConnectionState(ConnectionStateMessage),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UiStateMessage {
    pub state: String,
    pub speech_mode: String,
    pub caption: Option<String>,
    pub focus_remaining_sec: Option<u32>,
    pub emotion: Option<String>,
    pub accent_color: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TtsStartMessage {
    pub format: String,
    pub bytes: Option<u64>,
    pub sequence: Option<u64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TurnEndMessage {
    pub expects_reply: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConfirmRequestMessage {
    pub id: String,
    pub summary: String,
    pub expires_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ErrorMessage {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlayEffectMessage {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AlarmRingMessage {
    pub id: String,
    pub label: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SetResponseOutputTargetMessage {
    pub target: String,
    pub ts: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectionStateMessage {
    pub state: String,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_spanish_names_to_executables() {
        assert_eq!(normalize_app_name("bloc de notas"), "notepad");
        assert_eq!(normalize_app_name("El Bloc de Notas"), "notepad");
        assert_eq!(normalize_app_name("Discord.exe"), "discord");
        assert_eq!(normalize_app_name("  Spotify  "), "spotify");
        assert_eq!(normalize_app_name("la calculadora"), "calc");
        assert_eq!(normalize_app_name("Brave"), "brave");
    }

    #[test]
    fn scores_start_menu_matches_by_closeness() {
        assert_eq!(score_start_menu_match("discord", "Discord"), 3);
        assert_eq!(score_start_menu_match("dis", "Discord"), 2);
        assert_eq!(score_start_menu_match("cord", "Discord"), 1);
        assert_eq!(score_start_menu_match("brave", "Spotify"), 0);
        assert_eq!(score_start_menu_match("", "Spotify"), 0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn expands_percent_env_vars() {
        std::env::set_var("APOLLO_TEST_VAR", "C:\\Test");
        assert_eq!(
            expand_env_vars("%APOLLO_TEST_VAR%\\app.exe"),
            "C:\\Test\\app.exe"
        );
        assert_eq!(expand_env_vars("sin variables"), "sin variables");
        std::env::remove_var("APOLLO_TEST_VAR");
    }
}