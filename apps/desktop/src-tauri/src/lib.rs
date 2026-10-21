//! Apollo Desktop - Library root (hosts the Tauri application builder)

    pub mod cloudcore;
    pub mod account;
    pub mod commands;
    pub mod pcbridge;
    pub mod secret_store;
    pub mod sidecar;
    pub mod state;
    pub mod update_commands;
    pub mod updates;
    pub mod wallpaper;

use rustls::crypto::ring::default_provider;
use std::sync::Mutex;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

use commands::*;
use cloudcore::{CloudCoreManager, ConversationAuth};
use pcbridge::PcBridgeManager;
use sidecar::SidecarManager;
use state::{AppSettings, AppState};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        // FASE 3.1 — actualizador oficial de Tauri. El endpoint, el canal y la
        // clave publica salen de tauri.conf.json / tauri.staging.conf.json; aqui
        // solo se registra el plugin y el reinicio controlado tras instalar.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.emit("single-instance", ());
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            default_provider().install_default().expect("Failed to install rustls crypto provider");
            let app_handle = app.handle().clone();

            // Load persisted settings (fall back to defaults)
            let mut settings =
                tauri::async_runtime::block_on(AppSettings::load(&app_handle)).unwrap_or_default();
            // El destino del Worker se valida ANTES de tocar la red: si no
            // es valido para esta variante, Apollo no conecta a ningun
            // Worker y la UI muestra el motivo. Un destino invalido nunca
            // se degrada al host de la otra variante.
            let worker_url_error = match state::resolve_worker_url(&settings.worker_url) {
                state::WorkerUrlResolution::Valid(url) => {
                    settings.worker_url = url;
                    None
                }
                state::WorkerUrlResolution::Invalid(reason) => {
                    eprintln!("[apollo] no se conectara a ningun Worker: {reason}");
                    settings.worker_url = String::new();
                    Some(reason)
                }
            };
            if settings.autostart_enabled {
                if let Err(error) = app_handle.autolaunch().enable() {
                    log::warn!("autostart: no se pudo habilitar al arrancar: {error}");
                }
            }
            app.manage(Mutex::new(settings.clone()));

            // Initialize app state
            let state = AppState::new(app_handle.clone());
            app.manage(state);

            // Attach menu and handlers to the auto-created tray icon.
            // Windows come from app.windows in tauri.conf.json.
            create_tray(app)?;

            // Start sidecar (Python juana-client) — wake word, STT, TTS playback only.
            // Text goes through CloudCoreManager (single route to Worker).
            let sidecar_manager = SidecarManager::new(app_handle.clone());

            // Auto-start sidecar using already-loaded settings (no re-read from file)
            eprintln!(
                "[apollo] settings: autostart={} secret={}",
                settings.autostart_enabled,
                if settings.device_shared_secret.is_empty() { "(vacio)" } else { "(ok)" }
            );
            if settings.autostart_enabled {
                let sidecar_manager_for_start = sidecar_manager.clone();
                let app_handle_for_sidecar = app_handle.clone();
                let wake_words = settings.wake_words.clone();
                let use_vosk = settings.use_vosk_wake;
                let model_dir = settings.wake_model_dir.clone();
                tauri::async_runtime::spawn(async move {
                    match sidecar_manager_for_start
                        .start(
                            wake_words,
                            use_vosk,
                            model_dir,
                            app_handle_for_sidecar,
                            Some(settings.input_device_name.clone()),
                            Some(settings.output_device_name.clone()),
                        )
                        .await
                    {
                        Ok(()) => eprintln!("[apollo] sidecar arrancado"),
                        Err(error) => eprintln!("[apollo] sidecar auto-start fallo: {error}"),
                    }
                });
            }
            app.manage(sidecar_manager);

            // El PC Bridge se inicia desde la UI cuando AuthGate confirma la
            // sesión. Esto evita una conexión anónima/legacy en paralelo al
            // arranque y usa siempre las credenciales de la sesión validada.
            let pcbridge_manager = PcBridgeManager::new();
            app.manage(pcbridge_manager);

            // Cloud Core: direct WebSocket to Worker (replaces Python sidecar for cloud path)
            let cloudcore_manager = CloudCoreManager::new();
            // FASE 2.3: si hay sesión de cuenta, la conversación va al Apollo de
            // la cuenta (`acct:<accountId>`) con Bearer. El secreto legacy sólo
            // se usa si no hay sesión — y el Worker lo restringe a `default`.
            let account_session_token = crate::secret_store::read_session_token()
                .ok()
                .filter(|token| !token.is_empty());
            let account_id = settings.account_id.trim().to_string();
            let cloud_auth: Option<(String, ConversationAuth)> = match (
                account_session_token,
                account_id.is_empty(),
            ) {
                (Some(token), false) => crate::account::account_conversation_url(
                    &settings.worker_url,
                    &account_id,
                )
                .map(|account_url| {
                    (account_url, ConversationAuth::AccountSession { session_token: token })
                }),
                _ => None,
            };
            if let Some((account_url, auth)) = cloud_auth {
                let cloudcore_for_start = cloudcore_manager.clone();
                let app_handle_for_cloudcore = app_handle.clone();
                let device_id_cc = if settings.installation_id.trim().is_empty() {
                    local_device_id()
                } else {
                    settings.installation_id.clone()
                };
            // Mismo criterio que el PC Bridge: sin destino valido no se
            // abre ningun socket contra el Worker.
            if let Some(reason) = worker_url_error.clone() {
                eprintln!("[apollo] cloudcore: no se arranca ({reason})");
            } else {
                tauri::async_runtime::spawn(async move {
                    cloudcore_for_start
                        .start(app_handle_for_cloudcore, account_url, auth, device_id_cc)
                        .await;
                });
            }
            } else if !settings.worker_url.is_empty() && !settings.device_shared_secret.is_empty() {
                let cloudcore_for_start = cloudcore_manager.clone();
                let app_handle_for_cloudcore = app_handle.clone();
                let worker_url_cc = settings.worker_url.clone();
    let device_secret_cc = settings.device_shared_secret.clone();
    // La identidad viene de la configuración persistida, no del nombre de la]
    // mǭquina: renombrar el PC no debe cambiarle el `deviceId`, y un]
    // `COMPUTERNAME` reutilizado en otra máquina sí habría colicionado.]
    let device_id_cc = if settings.installation_id.trim().is_empty() {
        local_device_id()
    } else {
        settings.installation_id.clone()
    };
                tauri::async_runtime::spawn(async move {
                    cloudcore_for_start
                        .start(
                            app_handle_for_cloudcore,
                            worker_url_cc,
                            ConversationAuth::LegacyDeviceSecret(device_secret_cc),
                            device_id_cc,
                        )
                        .await;
                });
            }
            app.manage(cloudcore_manager);

            // Pivote de diseno: main es ventana flotante, no wallpaper.
            // El modulo wallpaper.rs queda sin invocar para reusarlo despues.

            // Si el destino del Worker no era valido, la UI lo muestra con
            // un mensaje claro: el usuario sabe que corregir, y mientras tanto
            // Apollo no ha abierto ningun socket contra ningun Worker.
            if let Some(reason) = worker_url_error {
                let _ = app_handle.emit(
                    "error",
                    serde_json::json!({
                        "code": "worker_url_invalido",
                        "message": reason,
                    }),
                );
                let app_handle_for_status = app_handle.clone();
                let reason_for_status = reason.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = app_handle_for_status.try_state::<AppState>() {
                        state
                            .set_connection_status(crate::state::ConnectionStatus::Error(format!(
                                "destino del Worker invalido: {reason_for_status}",
                            )))
                            .await;
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // App de tray: cerrar con la X solo oculta, nunca destruye.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
.invoke_handler(tauri::generate_handler![
  // FASE 3.1 — actualizaciones
  update_commands::check_for_update,
  update_commands::download_and_install_update,
  update_commands::update_channel,
  update_commands::restart_after_update,
  // Window management
  show_orb_window,
            hide_orb_window,
            show_chat_window,
            hide_chat_window,
            show_settings_window,
            hide_settings_window,
            // Sidecar management
            start_sidecar,
            stop_sidecar,
            get_sidecar_status,
            // Manual push-to-talk
            manual_listen_start,
            manual_listen_stop,
            // UI text/confirm -> Worker via sidecar stdin
            send_text_to_sidecar,
            send_confirm_to_sidecar,
            // PcBridge companion
            start_pcbridge,
            stop_pcbridge,
            pcbridge_status,
            // Cloud Core (direct Worker WebSocket)
            start_cloud_core,
            stop_cloud_core,
            cloud_core_status,
            send_text_to_cloud_core,
            // Autostart
            get_autostart_enabled,
            set_autostart_enabled,
            set_mic_muted,
            set_tts_muted,
            set_response_output_target,
            // PC commands (send to sidecar)
            pc_open_app,
            pc_focus_app,
            pc_close_app,
            pc_lock_screen,
            pc_list_apps,
            pc_spotify_play,
            pc_spotify_pause,
            pc_spotify_next,
            pc_spotify_previous,
            pc_spotify_get_state,
            // PC commands (native Windows execution)
            execute_pc_open_app,
            execute_pc_focus_app,
            execute_pc_close_app,
            execute_pc_lock_screen,
            // Settings
            get_settings,
            update_settings,
            set_device_shared_secret,
            // FASE 2.3 - cuenta multiusuario
            account_status,
            account_register,
            account_login,
            account_logout,
            // Protocol messages from sidecar
            on_protocol_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn local_device_id() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "apollo-desktop".to_string())
}

fn create_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show_orb = MenuItem::with_id(app, "show-orb", "Mostrar Orbe", true, None::<&str>)?;
    let toggle_wallpaper = MenuItem::with_id(
        app,
        "toggle-wallpaper",
        "Mostrar/Ocultar fondo",
        true,
        None::<&str>,
    )?;
    let show_chat = MenuItem::with_id(app, "show-chat", "Abrir Chat", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Configuración", true, None::<&str>)?;
    let autostart_on_login = CheckMenuItem::with_id(
        app,
        "toggle-autostart",
        "Iniciar con Windows",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_orb,
            &toggle_wallpaper,
            &show_chat,
            &settings,
            &autostart_on_login,
            &separator,
            &quit,
        ],
    )?;

    // Tauri 2 auto-creates tray "main" from app.trayIcon in tauri.conf.json
    // during App::build, before .setup() runs. Attach the menu and handlers
    // to it instead of building a second icon.
    let tray = app
        .tray_by_id("main")
        .expect("tray icon 'main' should exist: declared via app.trayIcon in tauri.conf.json");
    tray.set_menu(Some(menu))?;

    let autostart_toggle = autostart_on_login.clone();
    tray.on_menu_event(move |app, event| match event.id.as_ref() {
        "show-orb" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "toggle-wallpaper" => {
            if let Some(window) = app.get_webview_window("main") {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                }
            }
        }
        "show-chat" => {
            if let Some(window) = app.get_webview_window("chat") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "settings" => {
            if let Some(window) = app.get_webview_window("settings") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "toggle-autostart" => {
            let currently_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let toggled = if currently_enabled {
                app.autolaunch().disable()
            } else {
                app.autolaunch().enable()
            };
            match toggled {
                Ok(()) => {
                    let new_state = !currently_enabled;
                    if let Some(settings_state) = app.try_state::<Mutex<AppSettings>>() {
                        if let Ok(mut settings) = settings_state.lock() {
                            settings.autostart_enabled = new_state;
                            let app_handle = app.clone();
                            let to_save = settings.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = to_save.save(&app_handle).await;
                            });
                        }
                    }
                    let _ = autostart_toggle.set_checked(new_state);
                }
                Err(error) => {
                    log::warn!("autostart: no se pudo cambiar: {error}");
                }
            }
        }
        "quit" => {
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(sidecar_manager) = app_handle.try_state::<SidecarManager>() {
                    if let Err(error) = sidecar_manager.stop().await {
                        log::warn!("sidecar: no se pudo detener al salir: {error}");
                    }
                }
                app_handle.exit(0);
            });
        }
        _ => {}
    });

    tray.on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            if let Some(window) = tray.app_handle().get_webview_window("main") {
                let is_visible = window.is_visible().unwrap_or(false);
                if is_visible {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }
    });

    Ok(())
}
