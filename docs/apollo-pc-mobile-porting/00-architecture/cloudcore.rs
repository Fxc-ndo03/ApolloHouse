//! Cloud Core: WebSocket client that connects directly to the Worker (Apollo DO)
//! Single route for all text and voice communication.
//!
//! Protocol (apps/agent/src/protocol/schema.ts):
//! client -> Worker: hello {deviceId, ts}, text_input {text, ts}, abort {ts}
//! Worker -> client: ui_state, text_response_chunk, text_response_end,
//!   tts_start, tts_end, tts_aborted, turn_end, confirm_request,
//!   confirm_close, error, play_effect, alarm_ring, dashboard
//!
//! Binary frames: TTS audio (PCM) forwarded to Python sidecar via stdin.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::state::{AppState, ConnectionStatus, OrbState};

const CHANNEL_BUFFER_SIZE: usize = 64;

/// Verbosidad de bajo nivel solo con APOLLO_RUST_DEBUG=1 (igual que el
/// APOLLO_SIDECAR_DEBUG del sidecar Python). En modo normal solo salen
/// lifecycle, metricas y errores: ni una linea por frame de audio.
fn verbose_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("APOLLO_RUST_DEBUG")
            .map(|v| v == "1")
            .unwrap_or(false)
    })
}

macro_rules! vlog {
    ($($arg:tt)*) => {
        if crate::cloudcore::verbose_enabled() {
            eprintln!($($arg)*);
        }
    };
}

/// Backoff de reconexion: 2s tras el primer fallo, duplicando hasta 60s.
/// `failures` es 0-based (0 = primer fallo -> 2s).
fn connect_backoff_secs(failures: u32) -> u64 {
    (2u64 << failures.min(5)).min(60)
}

/// Metricas de un turno, sin I/O: registra timestamps y produce las lineas
/// de log. Testeable sin Tauri ni red.
#[derive(Debug, Default)]
struct TurnMetrics {
    turn_id: Option<String>,
    request_id: Option<String>,
    client_turn_id: Option<String>,
    generation: Option<i64>,
    device_id: Option<String>,
    send_at: Option<std::time::Instant>,
    first_event_at: Option<std::time::Instant>,
    first_text_at: Option<std::time::Instant>,
    first_audio_at: Option<std::time::Instant>,
    tts_start_at: Option<std::time::Instant>,
    turn_end_at: Option<std::time::Instant>,
    audio_frames: u64,
    audio_bytes: u64,
    // Anclas lado sidecar (vienen en el voice_transcript JSON).
    stt_dispatch_at: Option<std::time::Instant>,
    speech_start_ms: Option<i64>,
    speech_end_ms: Option<i64>,
}

impl TurnMetrics {
    fn on_send(&mut self, turn_id: Option<String>, request_id: String) {
        // El voice_transcript (note_stt_dispatch) llega ANTES que el send
        // del mismo turno: se preservan sus anclas solo si coincide el id.
        // Un turno solo-texto (sin transcript previo) arranca limpio.
        let same_turn = match (&self.turn_id, &turn_id) {
            (Some(previous), Some(next)) => previous == next,
            _ => false,
        };
        self.client_turn_id = turn_id.clone();
        self.turn_id = turn_id;
        self.request_id = Some(request_id);
        self.send_at = Some(std::time::Instant::now());
        self.first_event_at = None;
        self.first_text_at = None;
        self.first_audio_at = None;
        self.tts_start_at = None;
        self.turn_end_at = None;
        self.audio_frames = 0;
        self.audio_bytes = 0;
        if !same_turn {
            self.generation = None;
            self.stt_dispatch_at = None;
            self.speech_start_ms = None;
            self.speech_end_ms = None;
        }
    }

    fn note_device(&mut self, device_id: String) {
        self.device_id = Some(device_id);
    }

    /// Anclas del sidecar al despachar el transcript (FASE 4).
    fn note_stt_dispatch(
        &mut self,
        turn_id: Option<String>,
        generation: Option<i64>,
        speech_start_ms: Option<i64>,
        speech_end_ms: Option<i64>,
    ) {
        self.turn_id = turn_id;
        self.generation = generation;
        self.speech_start_ms = speech_start_ms;
        self.speech_end_ms = speech_end_ms;
        self.stt_dispatch_at = Some(std::time::Instant::now());
    }

    fn ms_since_send(&self) -> Option<u128> {
        self.send_at.map(|t| t.elapsed().as_millis())
    }

    /// Primer evento util del servidor tras el envio (cualquier frame).
    fn on_first_event(&mut self, frame_type: &str) -> Option<String> {
        if self.send_at.is_none() || self.first_event_at.is_some() {
            return None;
        }
        self.first_event_at = Some(std::time::Instant::now());
        Some(format!(
            "server-first-event type={} ms_since_send={}",
            frame_type,
            self.ms_since_send().unwrap_or(0),
        ))
    }

    fn on_text(&mut self, text_len: usize) -> Option<String> {
        if self.send_at.is_none() || self.first_text_at.is_some() {
            return None;
        }
        self.first_text_at = Some(std::time::Instant::now());
        Some(format!(
            "server-first-text len={} ms_since_send={}",
            text_len,
            self.ms_since_send().unwrap_or(0),
        ))
    }

    fn on_audio_bytes(&mut self, bytes: usize) -> Option<String> {
        self.audio_frames += 1;
        self.audio_bytes += bytes as u64;
        if self.send_at.is_none() || self.first_audio_at.is_some() {
            return None;
        }
        self.first_audio_at = Some(std::time::Instant::now());
        let mut line = format!(
            "tts-first-frame ms_since_send={} bytes={}",
            self.ms_since_send().unwrap_or(0),
            bytes,
        );
        if let (Some(first_text_at), Some(first_audio_at)) =
            (self.first_text_at, self.first_audio_at)
        {
            line.push_str(&format!(
                " first_text_to_first_audio_ms={}",
                first_audio_at.duration_since(first_text_at).as_millis(),
            ));
        }
        Some(line)
    }

    fn tts_summary(&self) -> String {
        let duration_ms = self
            .first_audio_at
            .and_then(|first| {
                std::time::Instant::now()
                    .checked_duration_since(first)
                    .map(|d| d.as_millis())
            })
            .unwrap_or(0);
        format!(
            "tts-summary frames={} bytes={} duration_ms={}",
            self.audio_frames, self.audio_bytes, duration_ms,
        )
    }

    /// Resumen de latencia por turno con correlacion completa (FASE 4).
    /// Solo metricas observadas; sin secretos. Los anclas de audio del lado
    /// sidecar viven en voice-turn-timing/playback-summary (mismos ids).
    /// Emite UNA vez por send (segundos turn_end del mismo envio se ignoran).
    fn latency_summary(&mut self) -> Option<String> {
        let send_at = self.send_at?;
        if self.turn_end_at.is_some() {
            return None;
        }
        self.turn_end_at = Some(std::time::Instant::now());
        let ms = |t: Option<std::time::Instant>| -> String {
            t.and_then(|v| v.checked_duration_since(send_at))
                .map(|d| d.as_millis().to_string())
                .unwrap_or_else(|| "-1".to_string())
        };
        let delta = |a: Option<std::time::Instant>, b: Option<std::time::Instant>| -> String {
            match (a, b) {
                (Some(x), Some(y)) => y
                    .checked_duration_since(x)
                    .map(|d| d.as_millis().to_string())
                    .unwrap_or_else(|| "-1".to_string()),
                _ => "-1".to_string(),
            }
        };
        Some(format!(
            "voice-latency-summary clientTurnId={} requestId={} turnId={} generation={} deviceId={} \
             stt_dispatch_ms={} server_request_ms=0 server_first_text_ms={} tts_start_ms={} \
             tts_first_frame_ms={} turn_end_ms={} \
             dispatch_to_first_text_ms={} dispatch_to_first_audio_ms={} \
             first_text_to_first_audio_ms={} turn_total_ms={} \
             speech_start_ms={} speech_end_ms={}",
            self.client_turn_id.as_deref().unwrap_or("none"),
            self.request_id.as_deref().unwrap_or("unknown"),
            self.turn_id.as_deref().unwrap_or("none"),
            self.generation.map(|g| g.to_string()).unwrap_or_else(|| "-1".to_string()),
            self.device_id.as_deref().unwrap_or("desktop"),
            ms(self.stt_dispatch_at),
            ms(self.first_text_at),
            ms(self.tts_start_at),
            ms(self.first_audio_at),
            ms(self.turn_end_at),
            delta(self.stt_dispatch_at, self.first_text_at),
            delta(self.stt_dispatch_at, self.first_audio_at),
            delta(self.first_text_at, self.first_audio_at),
            delta(self.send_at, self.turn_end_at),
            self.speech_start_ms.map(|v| v.to_string()).unwrap_or_else(|| "-1".to_string()),
            self.speech_end_ms.map(|v| v.to_string()).unwrap_or_else(|| "-1".to_string()),
        ))
    }
}

#[derive(Clone)]
pub struct CloudCoreManager {
    task: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    running: Arc<AtomicBool>,
    connected: Arc<AtomicBool>,
    sender: Arc<Mutex<Option<mpsc::Sender<String>>>>,
    metrics: Arc<Mutex<TurnMetrics>>,
    connect_attempts: Arc<std::sync::atomic::AtomicU32>,
}

impl CloudCoreManager {
    pub fn new() -> Self {
        Self {
            task: Arc::new(Mutex::new(None)),
            running: Arc::new(AtomicBool::new(false)),
            connected: Arc::new(AtomicBool::new(false)),
            sender: Arc::new(Mutex::new(None)),
            metrics: Arc::new(Mutex::new(TurnMetrics::default())),
            connect_attempts: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        }
    }

    pub async fn start(
        &self,
        app: AppHandle,
        worker_url: String,
        device_secret: String,
        device_id: String,
    ) {
        if self.is_running() {
            return;
        }
        self.stop().await;
        self.running.store(true, Ordering::SeqCst);

        let (tx, rx) = mpsc::channel(CHANNEL_BUFFER_SIZE);
        *self.sender.lock().unwrap() = Some(tx);

        let running = self.running.clone();
        let connected = self.connected.clone();
        let app_handle = app.clone();
        let attempts = self.connect_attempts.clone();
        let metrics = self.metrics.clone();
        let task_handle = tauri::async_runtime::spawn(async move {
            run_reconnect_loop(
                worker_url,
                device_secret,
                device_id,
                running,
                connected,
                app_handle,
                rx,
                attempts,
                metrics,
            )
            .await;
        });
        *self.task.lock().unwrap() = Some(task_handle);
    }

    pub async fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.connected.store(false, Ordering::SeqCst);
        *self.sender.lock().unwrap() = None;
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

    /// Envía texto al Worker a través del WebSocket persistente.
    /// El mensaje se serializa como { type: "text_input", text, ts, request_id, client_turn_id?, generation?, tts? }.
    /// client_turn es el turn_id del sidecar Python: viaja como client_turn_id
    /// (correlacion end-to-end, FASE 26) y tambien queda en los logs turn-link.
    /// generation es el generation del mismo turno (BLOCK 4): el router_decision
    /// del Worker lo correlaciona sin inferir IDs.
    pub async fn send_text(
        &self,
        text: &str,
        tts_config: Option<TtsConfig>,
        client_turn: Option<String>,
        generation: Option<i64>,
    ) -> Result<String, String> {
        let request_id = format!("turn-{}", chrono::Utc::now().timestamp_millis());
        let send_start = chrono::Utc::now().timestamp_millis();
        eprintln!("[text-debug] cloudcore-send text=\"{}\"", text);
        if let Some(turn) = client_turn.clone() {
            eprintln!("[text-debug] turn-link client_turn={} request_id={}", turn, request_id);
        }
        eprintln!("[text-debug] send-text-start request_id={} text=\"{}\"", request_id, text);
        eprintln!("[text-debug] server-request-start request_id={}", request_id);
        if let Ok(mut metrics) = self.metrics.lock() {
            metrics.on_send(client_turn.clone(), request_id.clone());
        }

        let sender = self.sender.lock().unwrap().clone();
        let tx = sender.ok_or_else(|| "cloudcore: WebSocket no conectado".to_string())?;
        let mut message = serde_json::json!({
            "type": "text_input",
            "text": text,
            "request_id": request_id,
            "ts": chrono::Utc::now().timestamp_millis(),
        });
        if let Some(turn) = client_turn {
            message["client_turn_id"] = serde_json::Value::String(turn);
        }
        if let Some(generation) = generation {
            message["generation"] = serde_json::Value::from(generation);
        }
        if let Some(tts) = tts_config {
            message["tts"] = serde_json::json!({
                "provider": tts.provider,
                "voice": tts.voice,
                "language": tts.language,
                "speed": tts.speed,
            });
        }

        eprintln!("[text-debug] websocket-send-start request_id={}", request_id);
        tx.send(message.to_string())
            .await
            .map_err(|e| format!("cloudcore: error enviando texto: {e}"))?;
        eprintln!("[text-debug] websocket-send-ok request_id={}", request_id);

        let send_end = chrono::Utc::now().timestamp_millis();
        eprintln!("[text-debug] send-text-end request_id={} total={}ms", request_id, send_end - send_start);

        Ok(request_id)
    }

    /// Anclas del sidecar (voice_transcript) para el latency-summary.
    pub fn note_stt_dispatch(
        &self,
        turn_id: Option<String>,
        generation: Option<i64>,
        speech_start_ms: Option<i64>,
        speech_end_ms: Option<i64>,
    ) {
        if let Ok(mut metrics) = self.metrics.lock() {
            metrics.note_stt_dispatch(turn_id, generation, speech_start_ms, speech_end_ms);
        }
    }

    pub fn note_device_id(&self, device_id: String) {
        if let Ok(mut metrics) = self.metrics.lock() {
            metrics.note_device(device_id);
        }
    }

    /// Abort de generacion (barge-in del usuario): {type:"abort",ts}.
    /// Usa el mismo canal que send_text; el Worker corta el loop TTS.
    pub async fn send_abort(&self) -> Result<(), String> {
        let sender = self.sender.lock().unwrap().clone();
        let tx = sender.ok_or_else(|| "cloudcore: WebSocket no conectado".to_string())?;
        let message = serde_json::json!({
            "type": "abort",
            "ts": chrono::Utc::now().timestamp_millis(),
        });
        tx.send(message.to_string())
            .await
            .map_err(|e| format!("cloudcore: error enviando abort: {e}"))?;
        eprintln!("[text-debug] barge-abort-sent");
        Ok(())
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TtsConfig {
    pub provider: String,
    pub voice: String,
    pub language: String,
    pub speed: f64,
}

impl Default for CloudCoreManager {
    fn default() -> Self {
        Self::new()
    }
}

async fn run_reconnect_loop(
    worker_url: String,
    device_secret: String,
    device_id: String,
    running: Arc<AtomicBool>,
    connected: Arc<AtomicBool>,
    app_handle: AppHandle,
    mut rx: mpsc::Receiver<String>,
    attempts: Arc<std::sync::atomic::AtomicU32>,
    metrics: Arc<Mutex<TurnMetrics>>,
) {
    let mut failures: u32 = 0;
    while running.load(Ordering::SeqCst) {
        let attempt = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        match serve_once(
            &worker_url,
            &device_secret,
            &device_id,
            &running,
            &connected,
            &app_handle,
            &mut rx,
            attempt,
            &metrics,
        )
        .await
        {
            Ok(()) => {
                log::info!("cloudcore: conexion cerrada, reintentando");
                failures = 0;
            }
            Err(error) => {
                failures = failures.saturating_add(1);
                let backoff_seconds = connect_backoff_secs(failures.saturating_sub(1));
                log::warn!("cloudcore: {error} (reintento en {backoff_seconds}s)");
                eprintln!("[apollo] cloudcore: {error} (reintento en {backoff_seconds}s)");
                tokio::time::sleep(std::time::Duration::from_secs(backoff_seconds)).await;
                continue;
            }
        }
        connected.store(false, Ordering::SeqCst);
        update_connection_status(&app_handle, ConnectionStatus::Disconnected).await;
        // Notify frontend about disconnection
        app_handle
            .emit("protocol-message", serde_json::json!({
                "type": "connection_state",
                "state": "disconnected",
            }))
            .ok();
        // Cierre limpio: reintento rapido (1s); los fallos usan backoff arriba.
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

async fn serve_once(
    worker_url: &str,
    device_secret: &str,
    device_id: &str,
    running: &Arc<AtomicBool>,
    connected: &Arc<AtomicBool>,
    app_handle: &AppHandle,
    rx: &mut mpsc::Receiver<String>,
    attempt: u32,
    metrics: &Arc<Mutex<TurnMetrics>>,
) -> Result<(), String> {
    // Host sin secreto: nunca se registra el token en logs.
    let host = worker_url
        .split("://")
        .nth(1)
        .unwrap_or(worker_url)
        .split('/')
        .next()
        .unwrap_or("?");
    let token_present = !device_secret.is_empty();
    eprintln!(
        "[text-debug] cloudcore-connect-start attempt={} host={} token_present={}",
        attempt, host, token_present,
    );
    let connect_start = std::time::Instant::now();
    let url = format!("{}?token={device_secret}", worker_url);
    // Sin timeout, un handshake colgado bloquea el loop de reconexion para
    // siempre (probado: 0.3s a 28s+ segun frialdad del isolate). Con timeout
    // se convierte en reintento con backoff en vez de muerte permanente.
    let connect_result = tokio::time::timeout(std::time::Duration::from_secs(25), connect_async(&url)).await;
    let handshake_ms = connect_start.elapsed().as_millis();
    let (socket, _) = match connect_result {
        Err(_) => {
            eprintln!(
                "[text-debug] cloudcore-connect-error attempt={} elapsed_ms={} cause=timeout-25s",
                attempt, handshake_ms,
            );
            return Err("connect timeout (25s)".to_string());
        }
        Ok(Err(e)) => {
            eprintln!(
                "[text-debug] cloudcore-connect-error attempt={} elapsed_ms={} cause={}",
                attempt, handshake_ms, e,
            );
            return Err(format!("connect fallo: {e}"));
        }
        Ok(Ok((socket, _))) => {
            eprintln!(
                "[text-debug] cloudcore-connect-ok attempt={} handshake_ms={}",
                attempt, handshake_ms,
            );
            (socket, ())
        }
    };
    let (mut writer, mut reader) = socket.split();

    let hello = serde_json::json!({
        "type": "hello",
        "deviceId": device_id,
        "ts": chrono::Utc::now().timestamp_millis(),
    });
    if let Ok(mut turn_metrics) = metrics.lock() {
        turn_metrics.note_device(device_id.to_string());
    }
    writer
        .send(Message::Text(hello.to_string().into()))
        .await
        .map_err(|e| format!("hello fallo: {e}"))?;
    connected.store(true, Ordering::SeqCst);
    update_connection_status(app_handle, ConnectionStatus::Connected).await;
    // Notify frontend about connection status
    app_handle
        .emit("protocol-message", serde_json::json!({
            "type": "connection_state",
            "state": "authenticated",
        }))
        .ok();
    log::info!("cloudcore: conectado");
    eprintln!("[apollo] cloudcore: conectado");

    // Bidirectional loop: read from WebSocket AND from the mpsc channel.
    // This allows send_text() to push messages through the same connection.
    // Binary frames (TTS audio) are forwarded to the Python sidecar via stdin.
    loop {
        tokio::select! {
            incoming = reader.next() => {
                match incoming {
                    Some(Ok(Message::Text(frame_text))) => {
                        let frame: Value = match serde_json::from_str(&frame_text) {
                            Ok(v) => v,
                            Err(e) => {
                                log::warn!("cloudcore: frame invalido: {e}");
                                continue;
                            }
                        };
                        if let Ok(mut turn_metrics) = metrics.lock() {
                            let incoming_type = frame
                                .get("type")
                                .and_then(|t| t.as_str())
                                .unwrap_or("?");
                            if let Some(line) = turn_metrics.on_first_event(incoming_type) {
                                eprintln!("[text-debug] {}", line);
                            }
                        }
                        handle_frame(app_handle, &frame, metrics).await;
                    }
                    Some(Ok(Message::Binary(binary_data))) => {
                        // TTS audio from Worker → forward to Python sidecar via stdin
                        use base64::Engine;
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&binary_data);
                        vlog!("[tts-debug] rust-tts-frame bytes={}", binary_data.len());
                        if let Ok(mut turn_metrics) = metrics.lock() {
                            if let Some(line) = turn_metrics.on_first_event("tts_binary") {
                                eprintln!("[text-debug] {}", line);
                            }
                            if let Some(line) = turn_metrics.on_audio_bytes(binary_data.len()) {
                                eprintln!("[tts-debug] {}", line);
                            }
                        }
                        if let Some(sidecar) = app_handle.try_state::<crate::sidecar::SidecarManager>() {
                            let payload = serde_json::json!({
                                "type": "tts_audio",
                                "data": b64,
                            });
                            if let Err(e) = sidecar.send_json(&payload).await {
                                log::warn!("cloudcore: failed to forward TTS audio to sidecar: {e}");
                            } else {
                                vlog!("[tts-debug] rust-forward-python bytes={}", b64.len());
                            }
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        return Err(format!("read fallo: {e}"));
                    }
                    None => {
                        return Ok(());
                    }
                }
            }
            outgoing = rx.recv() => {
                match outgoing {
                    Some(text) => {
                        if let Err(e) = writer.send(Message::Text(text.into())).await {
                            return Err(format!("write fallo: {e}"));
                        }
                        eprintln!("[text-debug] websocket-send=ok");
                    }
                    None => {
                        // Channel closed, caller dropped the sender
                        log::info!("cloudcore: canal de envio cerrado");
                        return Ok(());
                    }
                }
            }
        }

        if !running.load(Ordering::SeqCst) {
            break;
        }
    }
    Ok(())
}

async fn handle_frame(
    app_handle: &AppHandle,
    frame: &Value,
    metrics: &Arc<Mutex<TurnMetrics>>,
) {
    let frame_type = frame.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match frame_type {
        "ui_state" => {
            let state_str = frame
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("idle");
            let orb_state = OrbState::from_ui_state(state_str);
            if let Some(app_state) = app_handle.try_state::<AppState>() {
                app_state.set_orb_state(orb_state).await;
            }
            app_handle
                .emit("orb-state-change", state_str)
                .ok();
            app_handle
                .emit("protocol-message", frame.clone())
                .ok();
        }
        "text_response_chunk" => {
            let text = frame
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            eprintln!("[text-debug] response-chunk=\"{}\"", text);
            if let Ok(mut turn_metrics) = metrics.lock() {
                if let Some(line) = turn_metrics.on_text(text.len()) {
                    eprintln!("[text-debug] {}", line);
                }
            }
            app_handle
                .emit("text-response-chunk", text.to_string())
                .ok();
            // Forward to Python sidecar for display
            forward_to_sidecar(app_handle, frame).await;
        }
        "text_response_end" => {
            eprintln!("[text-debug] response-end");
            app_handle
                .emit("text-response-end", ())
                .ok();
            // Forward to Python sidecar
            forward_to_sidecar(app_handle, frame).await;
        }
        "tts_start" => {
            if let Some(app_state) = app_handle.try_state::<AppState>() {
                app_state.set_orb_state(OrbState::Speaking).await;
            }
            if let Ok(mut turn_metrics) = metrics.lock() {
                if turn_metrics.tts_start_at.is_none() {
                    turn_metrics.tts_start_at = Some(std::time::Instant::now());
                }
            }
            app_handle.emit("tts-start", frame.clone()).ok();
            app_handle
                .emit("protocol-message", frame.clone())
                .ok();
            // Forward to Python sidecar (mutes mic during TTS)
            forward_to_sidecar(app_handle, frame).await;
        }
        "tts_end" => {
            if let Some(app_state) = app_handle.try_state::<AppState>() {
                app_state.set_orb_state(OrbState::Idle).await;
            }
            if let Ok(turn_metrics) = metrics.lock() {
                eprintln!("[tts-debug] {}", turn_metrics.tts_summary());
            }
            app_handle.emit("tts-end", ()).ok();
            app_handle
                .emit("protocol-message", frame.clone())
                .ok();
            // Forward to Python sidecar (unmutes mic)
            forward_to_sidecar(app_handle, frame).await;
        }
        "tts_aborted" => {
            if let Some(app_state) = app_handle.try_state::<AppState>() {
                app_state.set_orb_state(OrbState::Idle).await;
            }
            app_handle.emit("tts-aborted", ()).ok();
            app_handle
                .emit("protocol-message", frame.clone())
                .ok();
            forward_to_sidecar(app_handle, frame).await;
        }
        "turn_end" => {
            if let Ok(mut turn_metrics) = metrics.lock() {
                if let Some(line) = turn_metrics.latency_summary() {
                    eprintln!("[text-debug] {}", line);
                }
            }
            app_handle.emit("turn-end", frame.clone()).ok();
            app_handle
                .emit("protocol-message", frame.clone())
                .ok();
        }
        "confirm_request" => {
            app_handle
                .emit("confirm-request", frame.clone())
                .ok();
            app_handle
                .emit("protocol-message", frame.clone())
                .ok();
        }
        "confirm_close" => {
            app_handle
                .emit("protocol-message", frame.clone())
                .ok();
        }
        "error" => {
            if let Some(app_state) = app_handle.try_state::<AppState>() {
                app_state.set_orb_state(OrbState::Error).await;
            }
            app_handle.emit("error", frame.clone()).ok();
            app_handle
                .emit("protocol-message", frame.clone())
                .ok();
        }
        "play_effect" => {
            app_handle.emit("play-effect", frame.clone()).ok();
            app_handle
                .emit("protocol-message", frame.clone())
                .ok();
        }
        "alarm_ring" => {
            if let Some(app_state) = app_handle.try_state::<AppState>() {
                app_state.set_orb_state(OrbState::Alarm).await;
            }
            app_handle.emit("alarm-ring", frame.clone()).ok();
            app_handle
                .emit("protocol-message", frame.clone())
                .ok();
        }
        "dashboard" => {
            app_handle
                .emit("protocol-message", frame.clone())
                .ok();
        }
        "background_result" => {
            app_handle
                .emit("protocol-message", frame.clone())
                .ok();
        }
        "reminder" => {
            app_handle
                .emit("protocol-message", frame.clone())
                .ok();
        }
        "mcp" => {
            app_handle
                .emit("protocol-message", frame.clone())
                .ok();
        }
        _ => {
            log::debug!("cloudcore: frame tipo desconocido: {frame_type}");
        }
    }
}

/// Forward a protocol message to the Python sidecar via stdin.
async fn forward_to_sidecar(app_handle: &AppHandle, frame: &Value) {
    if let Some(sidecar) = app_handle.try_state::<crate::sidecar::SidecarManager>() {
        if let Err(e) = sidecar.send_json(frame).await {
            log::debug!("cloudcore: no se pudo enviar al sidecar: {e}");
        }
    }
}

async fn update_connection_status(app_handle: &AppHandle, status: ConnectionStatus) {
    if let Some(app_state) = app_handle.try_state::<AppState>() {
        app_state.set_connection_status(status).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_then_caps() {
        assert_eq!(connect_backoff_secs(0), 2);
        assert_eq!(connect_backoff_secs(1), 4);
        assert_eq!(connect_backoff_secs(2), 8);
        assert_eq!(connect_backoff_secs(4), 32);
        assert_eq!(connect_backoff_secs(5), 60);
        assert_eq!(connect_backoff_secs(100), 60);
    }

    #[test]
    fn turn_metrics_first_event_text_audio_order() {
        let mut metrics = TurnMetrics::default();
        // Sin send previo no registra nada.
        assert!(metrics.on_first_event("ui_state").is_none());
        assert!(metrics.on_text(10).is_none());
        assert!(metrics.on_audio_bytes(100).is_none());
        assert_eq!(metrics.audio_frames, 1);
        assert_eq!(metrics.audio_bytes, 100);

        let mut metrics = TurnMetrics::default();
        metrics.on_send(Some("turn-abc".to_string()), "turn-1".to_string());
        let first = metrics.on_first_event("ui_state").expect("primer evento");
        assert!(first.contains("ms_since_send="));
        // El segundo evento ya no loguea first-event.
        assert!(metrics.on_first_event("tts_start").is_none());
        let text_line = metrics.on_text(12).expect("primer texto");
        assert!(text_line.contains("len=12"));
        assert!(metrics.on_text(5).is_none());
        let audio_line = metrics.on_audio_bytes(8192).expect("primer audio");
        assert!(audio_line.contains("bytes=8192"));
        assert!(audio_line.contains("first_text_to_first_audio_ms="));
        assert!(metrics.on_audio_bytes(100).is_none());
        assert_eq!(metrics.audio_frames, 2);
        assert_eq!(metrics.audio_bytes, 8292);
        let summary = metrics.tts_summary();
        assert!(summary.contains("frames=2"));
        assert!(summary.contains("bytes=8292"));
    }

    #[test]
    fn turn_metrics_resets_per_send() {
        let mut metrics = TurnMetrics::default();
        metrics.on_send(None, "turn-1".to_string());
        assert!(metrics.on_first_event("ui_state").is_some());
        metrics.on_send(None, "turn-2".to_string());
        // Nuevo send rearma first-event.
        assert!(metrics.on_first_event("ui_state").is_some());
        assert_eq!(metrics.audio_frames, 0);
    }

    #[test]
    fn latency_summary_correlates_turn_once() {
        let mut metrics = TurnMetrics::default();
        // Sin send no hay resumen.
        assert!(metrics.latency_summary().is_none());
        metrics.note_device("juana-test".to_string());
        metrics.note_stt_dispatch(
            Some("abc123".to_string()),
            Some(4),
            Some(300),
            Some(2100),
        );
        metrics.on_send(Some("abc123".to_string()), "turn-99".to_string());
        assert!(metrics.on_first_event("ui_state").is_some());
        assert!(metrics.on_text(9).is_some());
        assert!(metrics.on_audio_bytes(8192).is_some());
        let summary = metrics.latency_summary().expect("resumen");
        assert!(summary.contains("voice-latency-summary"));
        assert!(summary.contains("clientTurnId=abc123"));
        assert!(summary.contains("requestId=turn-99"));
        assert!(summary.contains("generation=4"));
        assert!(summary.contains("deviceId=juana-test"));
        assert!(summary.contains("speech_start_ms=300"));
        assert!(summary.contains("speech_end_ms=2100"));
        assert!(summary.contains("dispatch_to_first_text_ms="));
        assert!(summary.contains("turn_total_ms="));
        // Segundo turn_end del mismo envio: sin duplicados.
        assert!(metrics.latency_summary().is_none());
    }

    #[test]
    fn latency_summary_without_stt_anchors() {
        // Turno solo-texto (sin voice_transcript previo): igual resume con
        // marcadores -1, sin panic.
        let mut metrics = TurnMetrics::default();
        metrics.on_send(None, "turn-7".to_string());
        assert!(metrics.on_text(5).is_some());
        let summary = metrics.latency_summary().expect("resumen");
        assert!(summary.contains("requestId=turn-7"));
        assert!(summary.contains("clientTurnId=none"));
    }
}
