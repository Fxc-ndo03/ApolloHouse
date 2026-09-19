//! Apollo Desktop - Library root (hosts the Tauri application builder)

pub mod commands;
pub mod pcbridge;
pub mod sidecar;
pub mod state;
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
use pcbridge::PcBridgeManager;
use sidecar::SidecarManager;
use state::{AppSettings, AppState};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
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
            let settings =
                tauri::async_runtime::block_on(AppSettings::load(&app_handle)).unwrap_or_default();
            if settings.autostart_enabled {
                if let Err(error) = app_handle.autolaunch().enable() {
                    log::warn!("autostart: no se pudo habilitar al arrancar: {error}");
                }
            }
            app.manage(Mutex::new(settings));

            // Initialize app state
            let state = AppState::new(app_handle.clone());
            app.manage(state);

            // Attach menu and handlers to the auto-created tray icon.
            // Windows come from app.windows in tauri.conf.json.
            create_tray(app)?;

            // Start sidecar (Python juana-client)
            let sidecar_manager = SidecarManager::new(app_handle.clone());
            
            // Auto-start sidecar if settings already configured
            let settings = tauri::async_runtime::block_on(AppSettings::load(&app_handle)).unwrap_or_default();
            eprintln!(
                "[apollo] settings: url={} secret={} autostart={}",
                if settings.worker_url.is_empty() { "(vacia)" } else { &settings.worker_url },
                if settings.device_shared_secret.is_empty() { "(vacio)" } else { "(ok)" },
                settings.autostart_enabled
            );
            if !settings.worker_url.is_empty() && !settings.device_shared_secret.is_empty() {
                let sidecar_manager_for_start = sidecar_manager.clone();
                let app_handle_for_sidecar = app_handle.clone();
                let worker_url = settings.worker_url.clone();
                let device_secret = settings.device_shared_secret.clone();
                let wake_words = settings.wake_words.clone();
                let use_vosk = settings.use_vosk_wake;
                let model_dir = settings.wake_model_dir.clone();
                let use_local_core = settings.use_local_core;
                let core_lan_url = settings.core_lan_url.clone();
                tauri::async_runtime::spawn(async move {
                    match sidecar_manager_for_start
                        .start(
                            worker_url,
                            device_secret,
                            wake_words,
                            use_vosk,
                            model_dir,
                            app_handle_for_sidecar,
                            use_local_core,
                            core_lan_url,
                        )
                        .await
                    {
                        Ok(()) => eprintln!("[apollo] sidecar arrancado"),
                        Err(error) => eprintln!("[apollo] sidecar auto-start fallo: {error}"),
                    }
                });
            }
            app.manage(sidecar_manager);

            // Companion del PcBridge DO (auto-start si hay settings)
            let pcbridge_manager = PcBridgeManager::new();
            let pcbridge_manager_for_start = pcbridge_manager.clone();
            let app_handle_for_pcbridge = app_handle.clone();
            let worker_url_pc = settings.worker_url.clone();
            let device_secret_pc = settings.device_shared_secret.clone();
            tauri::async_runtime::spawn(async move {
                pcbridge_manager_for_start
                    .start(app_handle_for_pcbridge, worker_url_pc, device_secret_pc)
                    .await;
            });
            app.manage(pcbridge_manager);

            // Pivote de diseno: main es ventana flotante, no wallpaper.
            // El modulo wallpaper.rs queda sin invocar para reusarlo despues.

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
            // Autostart
            get_autostart_enabled,
            set_autostart_enabled,
            set_mic_muted,
            set_tts_muted,
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
            // Protocol messages from sidecar
            on_protocol_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
            app.exit(0);
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
