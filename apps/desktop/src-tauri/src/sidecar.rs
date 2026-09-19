//! Sidecar manager for Python juana-client

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command as TokioCommand};
use tokio::sync::Mutex;

use crate::state::{AppState, ConnectionStatus};

#[derive(Clone)]
pub struct SidecarManager {
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PythonSource {
    DevVenv,
    BundledRuntime,
}

impl PythonSource {
    fn label(self) -> &'static str {
        match self {
            PythonSource::DevVenv => "dev-venv",
            PythonSource::BundledRuntime => "bundled-runtime",
        }
    }
}

/// Convierte una línea de texto plano del cliente, p.ej. `State: authenticated`,
/// en el valor de estado reconocido por la UI (`connection`/`authenticated`/...).
fn parse_state_line(line: &str) -> Option<&str> {
    let stripped = line.strip_prefix("State:")?.trim();
    match stripped {
        "disconnected" | "connecting" | "connected" | "authenticated" | "error" => Some(stripped),
        _ => None,
    }
}

/// Refleja el estado del sidecar en el AppState del backend para que
/// `get_sidecar_status()` devuelva la verdad y se sincronice la luz en el
/// mount de la UI (cubre el caso de que el frontend pierda el evento inicial).
async fn sync_connection_state(app: &AppHandle, msg: &serde_json::Value) {
    let Some(state_str) = msg.get("state").and_then(|v| v.as_str()).map(|v| v.to_string()) else {
        return;
    };
    let status = match state_str.as_str() {
        "disconnected" => ConnectionStatus::Disconnected,
        "connecting" => ConnectionStatus::Connecting,
        "connected" => ConnectionStatus::Connected,
        "authenticated" => ConnectionStatus::Authenticated,
        "error" => {
            let error_msg = msg
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            ConnectionStatus::Error(error_msg)
        }
        _ => return,
    };
    if let Some(state) = app.try_state::<AppState>() {
        state.set_connection_status(status).await;
    }
}

impl SidecarManager {
    pub fn new(_app_handle: AppHandle) -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            stdin: Arc::new(Mutex::new(None)),
        }
    }

    /// Elimina sidecars python huérfanos: procesos `-m juana_client.client`
    /// cuyo apollo-desktop.exe padre ya no esté corriendo. Quedan huérfanos
    /// cuando una instancia anterior terminó sin cerrarlos (kill, crash, cierre
    /// por bandeja) y compiten por el micro y la sesión del Core.
    fn kill_orphan_sidecars() {
        #[cfg(target_os = "windows")]
        {
            use std::process::Command;
            let script = r#"
$apollo = @{}
Get-CimInstance Win32_Process -Filter "Name='apollo-desktop.exe'" | ForEach-Object {
    $apollo[$_.ProcessId] = $true
}
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | ForEach-Object {
    if ($_.CommandLine -like '*juana_client.client*') {
        if (-not $apollo.ContainsKey([int]$_.ParentProcessId)) {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Output ("[apollo] sidecar huerfano eliminado: " + $_.ProcessId)
        }
    }
}
"#;
            if let Ok(output) = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .output()
            {
                eprintln!(
                    "[apollo] limpieza de sidecars huerfanos: {}",
                    String::from_utf8_lossy(&output.stdout).trim()
                );
            }
        }
    }

    pub async fn start(
        &self,
        worker_url: String,
        device_secret: String,
        wake_words: Vec<String>,
        use_vosk: bool,
        model_dir: Option<String>,
        app_handle: AppHandle,
        use_local_core: bool,
        core_lan_url: String,
    ) -> Result<()> {
        // Check if already running
        let mut child_lock = self.child.lock().await;
        if child_lock.is_some() {
            return Ok(());
        }

        // Limpiar restos de instancias previas antes de lanzar la nuestra.
        Self::kill_orphan_sidecars();

        // Find juana-client root first (python runtime resolution needs it)
        let client_root = self.find_client_root()?;
        let (python_exe, python_source) = self.find_python(&client_root)?;

        // Build command
        let wake_words_str = wake_words.join(",");
        let model_dir = model_dir.unwrap_or_else(|| {
            let bundled = client_root.join("juana_client").join("models");
            if bundled.is_dir() {
                return bundled.to_string_lossy().to_string();
            }
            let base = dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("apollo")
                .join("models");
            base.to_string_lossy().to_string()
        });

        let mut cmd = TokioCommand::new(&python_exe);
        cmd.current_dir(&client_root)
            .arg("-m")
            .arg("juana_client.client")
            .env("APOLLO_WORKER_URL", &worker_url)
            .env("DEVICE_SHARED_SECRET", &device_secret)
            .env("USE_LOCAL_CORE", if use_local_core { "true" } else { "false" })
            .env("CORE_LAN_URL", &core_lan_url)
            .env("WAKE_WORDS", &wake_words_str)
            .env("USE_VOSK_WAKE", if use_vosk { "true" } else { "false" })
            .env("WAKE_MODEL_DIR", &model_dir)
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            .env("PYTHONLEGACYWINDOWSSTDIO", "1")
            // Never inherit user site-packages: a stray package there (or a
            // random PATH interpreter, see find_python) must not shadow ours.
            // Note: the bundled embeddable interpreter ignores PYTHONPATH
            // (isolated ._pth mode); its app path is baked into
            // python311._pth at staging time. This env still covers dev-venv.
            .env("PYTHONNOUSERSITE", "1")
            .env("PYTHONPATH", &client_root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::piped());

        // Diagnostic log: secret is set (never print the value)
        eprintln!("[diag-connect] DEVICE_SHARED_SECRET=(set)");
        // The embeddable runtime is relocatable but must not resolve its
        // stdlib against a foreign installation: pin its home explicitly.
        // (Never set for the dev venv: it would break venv resolution.)
        if python_source == PythonSource::BundledRuntime {
            if let Some(runtime_dir) = python_exe.parent() {
                cmd.env("PYTHONHOME", runtime_dir);
            }
        }
        #[cfg(target_os = "windows")]
        {
            #[allow(unused_imports)]
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        log::info!(
            "Starting sidecar ({}): {} -m juana_client.client (cwd {})",
            python_source.label(),
            python_exe.display(),
            client_root.display()
        );
        eprintln!(
            "[apollo] sidecar ({}): {} -m juana_client.client (cwd {})",
            python_source.label(),
            python_exe.display(),
            client_root.display()
        );
        log::info!(
            "Env: APOLLO_WORKER_URL={}, WAKE_WORDS={}, USE_VOSK_WAKE={}",
            worker_url,
            wake_words_str,
            use_vosk
        );

        let mut child = cmd.spawn().context("Failed to spawn Python sidecar")?;

        // Capture stdout for protocol messages
        let stdout = child.stdout.take().context("No stdout")?;
        let stderr = child.stderr.take().context("No stderr")?;
        let child_stdin = child.stdin.take().context("No stdin")?;
        *self.stdin.lock().await = Some(child_stdin);
        let app_handle_stdout = app_handle.clone();

        // Spawn stdout reader
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.starts_with("{") {
                            // Try to parse as JSON protocol message
                            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                                if msg.get("type").and_then(|v| v.as_str()).is_some() {
                                    sync_connection_state(&app_handle_stdout, &msg).await;
                                    app_handle_stdout.emit("protocol-message", msg).ok();
                                    continue;
                                }
                            }
                        } else if let Some(state) = parse_state_line(&line) {
                            // Legacy plain-text state from the client: forward it
                            // as a protocol message so the UI always stays in sync.
                            let msg = serde_json::json!({
                                "type": "connection_state",
                                "state": state
                            });
                            sync_connection_state(&app_handle_stdout, &msg).await;
                            app_handle_stdout.emit("protocol-message", msg).ok();
                            continue;
                        }
                        // Non-protocol stdout is sidecar chatter: surface it.
                        eprintln!("[sidecar] {line}");
                    }
                    Ok(None) => {
                        eprintln!("[apollo] sidecar stdout cerrado (EOF)");
                        break;
                    }
                    Err(error) => {
                        eprintln!("[apollo] sidecar stdout error: {error}");
                        break;
                    }
                }
            }
        });

        // Spawn stderr reader
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::warn!("[sidecar stderr] {}", line);
                eprintln!("[sidecar stderr] {line}");
            }
        });

        *child_lock = Some(child);
        drop(child_lock);

        // Marcar el sidecar como corriendo en el AppState (autostart en setup
        // también lo arranca sin pasar por start_sidecar).
        if let Some(state) = app_handle.try_state::<AppState>() {
            state.set_sidecar_running(true).await;
            state.set_connection_status(ConnectionStatus::Connecting).await;
        }
        eprintln!("[apollo] sidecar marcado como corriendo en AppState");

        // Monitor child exit without taking ownership (stop() may take it first)
        let child_arc = self.child.clone();
        let app_handle_exit = app_handle.clone();
        tokio::spawn(async move {
            loop {
                let exited = {
                    let mut guard = child_arc.lock().await;
                    match guard.as_mut() {
                        Some(running) => match running.try_wait() {
                            Ok(Some(status)) => {
                                *guard = None;
                                Some(status)
                            }
                            Ok(None) => None,
                            Err(error) => {
                                log::warn!("Sidecar wait error: {error}");
                                *guard = None;
                                None
                            }
                        },
                        None => break,
                    }
                };
                if let Some(status) = exited {
                    log::info!("Sidecar exited: {status:?}");
                    eprintln!("[apollo] sidecar termino: {status:?}");
                    if let Some(state) = app_handle_exit.try_state::<AppState>() {
                        state.set_sidecar_running(false).await;
                        state.set_connection_status(ConnectionStatus::Disconnected).await;
                    }
                    app_handle_exit.emit("sidecar-exited", status.code()).ok();
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<()> {
        *self.stdin.lock().await = None;
        let mut child_lock = self.child.lock().await;
        if let Some(mut child) = child_lock.take() {
            child.kill().await.context("Failed to kill sidecar")?;
        }
        Ok(())
    }

    /// Manda una accion por stdin al proceso Python (start/stop_listening).
    pub async fn send_action(&self, action: &str) -> Result<()> {
        self.send_json(&serde_json::json!({ "action": action })).await
    }

    /// Manda un objeto JSON por stdin al proceso Python.
    pub async fn send_json(&self, payload: &serde_json::Value) -> Result<()> {
        let mut stdin_lock = self.stdin.lock().await;
        let stdin = stdin_lock
            .as_mut()
            .ok_or_else(|| anyhow!("sidecar no esta corriendo"))?;
        let line = format!("{payload}\n");
        stdin
            .write_all(line.as_bytes())
            .await
            .context("Failed to write sidecar stdin")?;
        stdin.flush().await.context("Failed to flush sidecar stdin")?;
        Ok(())
    }

    pub async fn is_running(&self) -> bool {
        let child_lock = self.child.lock().await;
        child_lock.is_some()
    }

    /// Strict interpreter resolution. Order:
    /// 1. dev venv inside client_root (local development only),
    /// 2. self-contained runtime staged at resources/python-runtime (installed builds).
    /// There is intentionally NO fallback to PATH: resolving a generic
    /// `python` once picked up an unrelated project's venv (hermes-agent)
    /// from the user's PATH and ran the sidecar with the wrong interpreter
    /// and the wrong packages. A missing runtime is a hard, loud error.
    fn find_python(&self, client_root: &Path) -> Result<(PathBuf, PythonSource)> {
        #[cfg(target_os = "windows")]
        let exe_name = "python.exe";
        #[cfg(not(target_os = "windows"))]
        let exe_name = "python3";

        // 1. Development venv (has websockets/pyaudio/numpy/vosk installed).
        #[cfg(target_os = "windows")]
        let dev_venv_python = client_root.join(".venv").join("Scripts").join(exe_name);
        #[cfg(not(target_os = "windows"))]
        let dev_venv_python = client_root.join(".venv").join("bin").join(exe_name);
        if dev_venv_python.exists() {
            return Ok((dev_venv_python, PythonSource::DevVenv));
        }

        // 2. Bundled runtime: resources/python-runtime, i.e. the sibling of
        // the staged resources/juana-client dir (client_root = .../juana-client).
        let mut checked: Vec<PathBuf> = vec![dev_venv_python];
        if let Some(resources_dir) = client_root.parent() {
            let bundled = resources_dir.join("python-runtime").join(exe_name);
            checked.push(bundled.clone());
            if bundled.exists() {
                return Ok((bundled, PythonSource::BundledRuntime));
            }
        }
        // Same location resolved from the executable (covers layouts where
        // client_root was found via the app-data fallback).
        if let Ok(current_exe) = std::env::current_exe() {
            if let Some(exe_dir) = current_exe.parent() {
                let bundled = exe_dir.join("resources").join("python-runtime").join(exe_name);
                if !checked.contains(&bundled) {
                    checked.push(bundled.clone());
                    if bundled.exists() {
                        return Ok((bundled, PythonSource::BundledRuntime));
                    }
                }
            }
        }

        // 3. Hard error — never silently run an arbitrary system Python.
        let message = format!(
            "Sidecar Python runtime not found. Checked: {}. \
             Reinstall Apollo Desktop (the installer stages resources/python-runtime) \
             or run the dev venv setup for local development.",
            checked
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
        log::error!("{message}");
        eprintln!("[apollo] {message}");
        Err(anyhow!(message))
    }

    fn find_client_root(&self) -> Result<PathBuf> {
        // Look for the juana-client root (dir containing the juana_client package)
        let candidates = [
            // Development: relative to app
            PathBuf::from("../../../juana-client"),
            // Bundled: next to executable
            std::env::current_exe()?
                .parent()
                .unwrap()
                .join("resources")
                .join("juana-client"),
            // Installed: in app data
            dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("apollo")
                .join("juana-client"),
        ];

        for candidate in &candidates {
            if candidate.join("juana_client").join("client.py").exists() {
                return Ok(candidate.canonicalize()?);
            }
        }

        Err(anyhow!(
            "juana-client not found. Expected at one of: {:?}",
            candidates
        ))
    }
}
