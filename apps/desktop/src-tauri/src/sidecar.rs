//! Sidecar manager for Python juana-client
//!
//! Python handles: wake word, STT, TTS playback.
//! Python does NOT connect to the Worker directly.
//! Text goes through stdout → Rust → CloudCoreManager.
//! Worker responses come through CloudCoreManager → Rust → Python stdin.

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command as TokioCommand};
use tokio::sync::Mutex;

use crate::state::{AppState, ConnectionStatus};

/// Parametros del ultimo arranque (para restart automatico tras crash).
#[derive(Clone, Debug)]
struct SidecarStartParams {
    wake_words: Vec<String>,
    use_vosk: bool,
    model_dir: Option<String>,
    input_device: Option<String>,
    output_device: Option<String>,
}

/// Backoff del restart automatico tras crash (2s, 5s, 10s; max 3 intentos).
/// Acotado para no revivir en loop infinito si el entorno esta roto.
const SIDECAR_RESTART_BACKOFFS: [u64; 3] = [2, 5, 10];

#[derive(Clone)]
pub struct SidecarManager {
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    /// true cuando la salida fue ordenada (stop()); si no, fue crash.
    expect_exit: Arc<AtomicBool>,
    /// Guarda contra dos loops de restart concurrentes.
    restarting: Arc<AtomicBool>,
    last_params: Arc<Mutex<Option<SidecarStartParams>>>,
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
            expect_exit: Arc::new(AtomicBool::new(false)),
            restarting: Arc::new(AtomicBool::new(false)),
            last_params: Arc::new(Mutex::new(None)),
        }
    }

    /// Elimina sidecars python huérfanos: procesos `-m juana_client.client`
    /// cuyo proceso padre (Apollo Desktop.exe o apollo-desktop.exe) ya no esté
    /// corriendo. Quedan huérfanos cuando una instancia anterior terminó sin
    /// cerrarlos (kill, crash, cierre por bandeja) y compiten por el micro y
    /// la sesión del Core. Solo coincide el command line del sidecar de Apollo,
    /// nunca un Python ajeno.
    fn kill_orphan_sidecars() {
        #[cfg(target_os = "windows")]
        {
            use std::process::Command;
            let script = r#"
$apollo = @{}
Get-CimInstance Win32_Process -Filter "Name='Apollo Desktop.exe'" | ForEach-Object {
    $apollo[$_.ProcessId] = $true
}
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
        wake_words: Vec<String>,
        use_vosk: bool,
        model_dir: Option<String>,
        app_handle: AppHandle,
        input_device: Option<String>,
        output_device: Option<String>,
    ) -> Result<()> {
        // Check if already running
        let mut child_lock = self.child.lock().await;
        if child_lock.is_some() {
            return Ok(());
        }
        self.expect_exit.store(false, Ordering::SeqCst);
        *self.last_params.lock().await = Some(SidecarStartParams {
            wake_words: wake_words.clone(),
            use_vosk,
            model_dir: model_dir.clone(),
            input_device: input_device.clone(),
            output_device: output_device.clone(),
        });

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

        let (input_device_name, output_device_name) = if let Some(input) = input_device {
            (input, output_device.unwrap_or_else(|| crate::state::default_output_device_name()))
        } else if let Some(settings_state) = app_handle.try_state::<std::sync::Mutex<crate::state::AppSettings>>() {
            let s = settings_state.lock().unwrap();
            (s.input_device_name.clone(), s.output_device_name.clone())
        } else {
            (crate::state::default_input_device_name(), crate::state::default_output_device_name())
        };

        // Directorio de config (settings.json): el sidecar guarda ahi
        // device_preferences.json para que sobreviva a reinstalaciones
        // (resources/ se reemplaza en cada update del instalador).
        let apollo_config_dir = app_handle
            .path()
            .app_config_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let mut cmd = TokioCommand::new(&python_exe);
        cmd.kill_on_drop(true);
        cmd.current_dir(&client_root)
            .arg("-m")
            .arg("juana_client.client")
            .env("WAKE_WORDS", &wake_words_str)
            .env("USE_VOSK_WAKE", if use_vosk { "true" } else { "false" })
            .env("WAKE_MODEL_DIR", &model_dir)
            .env("INPUT_DEVICE_NAME", &input_device_name)
            .env("OUTPUT_DEVICE_NAME", &output_device_name)
            .env("APOLLO_CONFIG_DIR", &apollo_config_dir)
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
            "Env: WAKE_WORDS={}, USE_VOSK_WAKE={}",
            wake_words_str,
            use_vosk
        );
        eprintln!(
            "[voice-debug] configured-wake-words={}",
            serde_json::to_string(&wake_words).unwrap_or_default()
        );

        let mut child = cmd.spawn().context("Failed to spawn Python sidecar")?;

        // Capture stdout for protocol messages
        let stdout = child.stdout.take().context("No stdout")?;
        let stderr = child.stderr.take().context("No stderr")?;
        let child_stdin = child.stdin.take().context("No stdin")?;
        *self.stdin.lock().await = Some(child_stdin);
        let app_handle_stdout = app_handle.clone();

        // Spawn stdout reader
        // Handles:
        //   - voice_transcript: forward to CloudCoreManager.send_text()
        //   - connection_state: sync with AppState
        //   - other JSON: emit as protocol-message
        //   - plain text: surface as sidecar chatter
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.starts_with("{") {
                            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                                let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

                                // Barge-in del sidecar: el usuario hablo durante TTS.
                                // Se aborta la generacion en el Worker; NO se reemite
                                // a la UI (sin cambio visual; solo metricas).
                                if msg_type == "barge_in" {
                                    let tts_elapsed = msg.get("tts_elapsed_ms").and_then(|v| v.as_i64()).unwrap_or(-1);
                                    let rms = msg.get("rms").and_then(|v| v.as_f64()).unwrap_or(0.0);
                                    eprintln!("[voice-debug] barge_in_received tts_elapsed_ms={} rms={:.4}", tts_elapsed, rms);
                                    if let Some(cloudcore) = app_handle_stdout.try_state::<crate::cloudcore::CloudCoreManager>() {
                                        let cc = cloudcore.inner().clone();
                                        tokio::spawn(async move {
                                            match cc.send_abort().await {
                                                Ok(()) => eprintln!("[voice-debug] barge-abort-sent"),
                                                Err(e) => eprintln!("[sidecar] barge abort failed: {e}"),
                                            }
                                        });
                                    }
                                    continue;
                                }
                                // Voice transcript from Python STT → forward to CloudCoreManager + emit to frontend
                                if msg_type == "voice_transcript" {
                                    if let Some(text) = msg.get("text").and_then(|v| v.as_str()) {
                                        eprintln!("[sidecar] voice_transcript received chars={}", text.chars().count());
                                        // FASE 26: reemitir la identidad del turno (turn_id/generation/ts)
                                        // para correlacion end-to-end. La UI ignora campos extra.
                                        let turn_id_json = msg.get("turn_id").cloned().unwrap_or(serde_json::Value::Null);
                                        let generation_json = msg.get("generation").cloned().unwrap_or(serde_json::Value::Null);
                                        let ts_json = msg.get("ts").cloned().unwrap_or(serde_json::Value::Null);
                                        // Emit to frontend so chat can display the transcript
                                        app_handle_stdout.emit("protocol-message", serde_json::json!({
                                            "type": "voice_transcript",
                                            "text": text,
                                            "turn_id": turn_id_json,
                                            "generation": generation_json,
                                            "ts": ts_json,
                                        })).ok();
                                        // FASE 4: anclas STT para el voice-latency-summary.
                                        if let Some(cloudcore_state) = app_handle_stdout.try_state::<crate::cloudcore::CloudCoreManager>() {
                                            let turn_owned = msg.get("turn_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                                            let generation_owned = msg.get("generation").and_then(|v| v.as_i64());
                                            let speech_start_owned = msg.get("speech_start_ms").and_then(|v| v.as_i64());
                                            let speech_end_owned = msg.get("speech_end_ms").and_then(|v| v.as_i64());
                                            cloudcore_state.inner().clone().note_stt_dispatch(
                                                turn_owned,
                                                generation_owned,
                                                speech_start_owned,
                                                speech_end_owned,
                                            );
                                        }
                                        if let Some(cloudcore) = app_handle_stdout.try_state::<crate::cloudcore::CloudCoreManager>() {
                                            let cc = cloudcore.inner().clone();
                                            let text_owned = text.to_string();
                                            let turn_owned = msg.get("turn_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                                            let generation_for_text = msg.get("generation").and_then(|v| v.as_i64());
                                            tokio::spawn(async move {
                                                match cc.send_text(&text_owned, None, turn_owned, generation_for_text).await {
                                                    Ok(request_id) => {
                                                        eprintln!("[tts-debug] dispatch=text_input request_id={}", request_id);
                                                        eprintln!("[tts-debug] transport=cloudcore request_id={}", request_id);
                                                    }
                                                    Err(e) => {
                                                        eprintln!("[sidecar] cloudcore send_text failed: {e}");
                                                    }
                                                }
                                            });
                                        }
                                    }
                                    continue;
                                }

                                // Connection state sync
                                if msg_type == "connection_state" {
                                    sync_connection_state(&app_handle_stdout, &msg).await;
                                    app_handle_stdout.emit("protocol-message", msg).ok();
                                    continue;
                                }

                                // UI state from Python → forward to frontend for orb changes
                                if msg_type == "ui_state" {
                                    app_handle_stdout.emit("protocol-message", msg).ok();
                                    continue;
                                }

                                // TTS audio from Python (base64) — forward to CloudCoreManager not needed here
                                // TTS audio flows: Worker → CloudCoreManager → Rust → Python stdin

                                // Other protocol messages
                                if msg_type.is_empty() {
                                    // No type field, treat as sidecar chatter
                                    eprintln!("[sidecar] {}", line);
                                } else {
                                    sync_connection_state(&app_handle_stdout, &msg).await;
                                    app_handle_stdout.emit("protocol-message", msg).ok();
                                }
                                continue;
                            }
                        } else if let Some(state) = parse_state_line(&line) {
                            let msg = serde_json::json!({
                                "type": "connection_state",
                                "state": state
                            });
                            sync_connection_state(&app_handle_stdout, &msg).await;
                            app_handle_stdout.emit("protocol-message", msg).ok();
                            continue;
                        }
                        // Non-protocol stdout is sidecar chatter: surface it.
                        if line.contains("[voice-debug]") || line.contains("[WAKE]") || line.contains("[sidecar]") {
                            eprintln!("{}", line);
                        } else {
                            eprintln!("[sidecar] {line}");
                        }
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
        let manager_clone = self.clone();
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
                    // Salida ordenada (stop()) vs crash: solo el crash dispara
                    // el loop de restart (max 3 intentos, backoff). Sin esto,
                    // un sidecar muerto dejaba a Apollo sin voz hasta
                    // reinicio manual.
                    let ordered = manager_clone.expect_exit.swap(false, Ordering::SeqCst);
                        if !ordered {
                            let code = status.code();
                            app_handle_exit
                                .emit("sidecar-crash", serde_json::json!({ "code": code }))
                                .ok();
                        eprintln!("[apollo] sidecar-crash code={:?} (restart automatico)", code);
                        if manager_clone
                            .restarting
                            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                        {
                            let manager_restart = manager_clone.clone();
                            let app_handle_restart = app_handle_exit.clone();
                            // NOTE: start() no es Send (future con estado !Send
                            // heredado), asi que el restart corre en un thread
                            // bloqueante con block_on en vez de tokio::spawn.
                            // Es camino raro (solo tras crash), un thread
                            // transitorio es aceptable.
                            tokio::task::spawn_blocking(move || {
                                let runtime_handle = tauri::async_runtime::handle();
                                let mut ok = false;
                                let mut aborted = false;
                                for (i, wait_secs) in SIDECAR_RESTART_BACKOFFS.iter().enumerate() {
                                    let attempt = i + 1;
                                    // Stop manual mientras tanto: no revivir.
                                    if manager_restart.expect_exit.load(Ordering::SeqCst) {
                                        eprintln!("[apollo] sidecar-restart-aborted reason=stop-requested");
                                        aborted = true;
                                        break;
                                    }
                                    app_handle_restart
                                        .emit(
                                            "sidecar-restart-start",
                                            serde_json::json!({ "attempt": attempt }),
                                        )
                                        .ok();
                                    eprintln!("[apollo] sidecar-restart-start attempt={}", attempt);
                                    std::thread::sleep(std::time::Duration::from_secs(*wait_secs));
                                    let params = runtime_handle.block_on(manager_restart.last_params.lock(),);
                                    let params = params.clone();
                                    let result = match params {
                                        Some(p) => runtime_handle.block_on(
                                            manager_restart.start(
                                                p.wake_words,
                                                p.use_vosk,
                                                p.model_dir,
                                                app_handle_restart.clone(),
                                                p.input_device,
                                                p.output_device,
                                            ),
                                        ),
                                        None => Err(anyhow!("sin parametros de arranque")),
                                    };
                                    match result {
                                        Ok(()) => {
                                            ok = true;
                                            break;
                                        }
                                        Err(e) => {
                                            eprintln!(
                                                "[apollo] sidecar-restart attempt={} failed: {e:#}",
                                                attempt
                                            );
                                        }
                                    }
                                }
                                manager_restart.restarting.store(false, Ordering::SeqCst);
                                if ok {
                                    app_handle_restart.emit("sidecar-restart-ok", ()).ok();
                                    eprintln!("[apollo] sidecar-restart-ok");
                                } else if !aborted {
                                    app_handle_restart.emit("sidecar-restart-failed", ()).ok();
                                    eprintln!("[apollo] sidecar-restart-failed (3 intentos)");
                                }
                            });
                        }
                    }
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<()> {
        self.expect_exit.store(true, Ordering::SeqCst);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_backoff_is_bounded() {
        // Politica de restart tras crash: 3 intentos con backoff creciente,
        // nunca loop infinito.
        assert_eq!(SIDECAR_RESTART_BACKOFFS.len(), 3);
        assert_eq!(SIDECAR_RESTART_BACKOFFS, [2, 5, 10]);
        let total: u64 = SIDECAR_RESTART_BACKOFFS.iter().sum();
        assert!(total <= 30, "restart total espera acotada");
    }
}
