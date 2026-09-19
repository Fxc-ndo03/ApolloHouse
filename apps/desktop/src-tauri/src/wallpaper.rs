//! Live wallpaper: reparenta la ventana main bajo el WorkerW del escritorio.
//!
//! Tecnica estandar de Windows: se le pide a Progman (0x052C) que genere el
//! WorkerW y la ventana de Tauri pasa a ser hija suya, quedando detras de los
//! iconos y de cualquier ventana normal. Sin bordes, fullscreen y
//! click-through (los clicks caen al escritorio; el control es via tray).

use tauri::WebviewWindow;

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;

/// Convierte la ventana main en fondo de escritorio real.
/// Idempotente y no fatal: devuelve Err con el motivo si algo falla.
pub fn setup_wallpaper(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        setup_wallpaper_windows(window)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn setup_wallpaper_windows(window: &WebviewWindow) -> Result<(), String> {
    use windows::{
        core::{w, PCWSTR},
        Win32::Foundation::{LPARAM, WPARAM},
        Win32::UI::WindowsAndMessaging::*,
    };

    unsafe {
        let window_title: Vec<u16> = window
            .title()
            .map_err(|e| e.to_string())?
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let app_hwnd =
            FindWindowW(None, PCWSTR(window_title.as_ptr())).unwrap_or_default();
        if app_hwnd.is_invalid() {
            return Err("wallpaper: no se encontro la ventana main".to_string());
        }

        let progman = FindWindowW(w!("Progman"), None).unwrap_or_default();
        if progman.is_invalid() {
            return Err("wallpaper: no se encontro Progman".to_string());
        }
        let _ = SendMessageTimeoutW(
            progman,
            0x052C,
            WPARAM(0),
            LPARAM(0),
            SMTO_NORMAL,
            1000,
            None,
        );

        let workerw = find_wallpaper_workerw().ok_or_else(|| {
            "wallpaper: no se encontro el WorkerW del escritorio".to_string()
        })?;

        SetParent(app_hwnd, Some(workerw))
            .map_err(|e| format!("wallpaper: SetParent fallo: {e}"))?;

        let previous_style = GetWindowLongPtrW(app_hwnd, GWL_STYLE);
        let next_style = (previous_style
            & !(WS_CAPTION.0 as isize
                | WS_THICKFRAME.0 as isize
                | WS_MINIMIZEBOX.0 as isize
                | WS_MAXIMIZEBOX.0 as isize
                | WS_SYSMENU.0 as isize
                | WS_POPUP.0 as isize
                | WS_OVERLAPPED.0 as isize))
            | (WS_CHILD.0 as isize | WS_VISIBLE.0 as isize);
        SetWindowLongPtrW(app_hwnd, GWL_STYLE, next_style);

        let previous_ex_style = GetWindowLongPtrW(app_hwnd, GWL_EXSTYLE);
        let next_ex_style = (previous_ex_style
            | WS_EX_LAYERED.0 as isize
            | WS_EX_TRANSPARENT.0 as isize
            | WS_EX_NOACTIVATE.0 as isize
            | WS_EX_TOOLWINDOW.0 as isize)
            & !(WS_EX_APPWINDOW.0 as isize);
        SetWindowLongPtrW(app_hwnd, GWL_EXSTYLE, next_ex_style);

        let screen_x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let screen_y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let screen_width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let screen_height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        let _ = SetWindowPos(
            app_hwnd,
            Some(HWND_BOTTOM),
            screen_x,
            screen_y,
            screen_width,
            screen_height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );

        log::info!(
            "wallpaper: ventana anclada al WorkerW ({0}x{1})",
            screen_width,
            screen_height
        );
        Ok(())
    }
}

/// El WorkerW valido es el que aparece despues del que contiene los iconos
/// (hijo SHELLDLL_DefView). Fallback: ultimo WorkerW sin ese hijo.
#[cfg(target_os = "windows")]
unsafe fn find_wallpaper_workerw() -> Option<HWND> {
    use windows::{
        core::w,
        Win32::Foundation::{HWND, LPARAM, TRUE},
        Win32::UI::WindowsAndMessaging::*,
    };
    use windows_core::BOOL;

    struct Search {
        worker_list: Vec<HWND>,
    }

    unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = &mut *(lparam.0 as *mut Search);
        let mut class_name = [0u16; 256];
        let class_len = GetClassNameW(hwnd, &mut class_name);
        if class_len > 0
            && String::from_utf16_lossy(&class_name[..class_len as usize]) == "WorkerW"
        {
            search.worker_list.push(hwnd);
        }
        TRUE
    }

    let mut search = Search {
        worker_list: Vec::new(),
    };
    let _ = EnumWindows(
        Some(enum_callback),
        LPARAM(std::ptr::addr_of_mut!(search) as isize),
    );

    for (index, candidate) in search.worker_list.iter().enumerate() {
        let icons_child = FindWindowExW(Some(*candidate), None, w!("SHELLDLL_DefView"), None);
        if icons_child.is_ok() {
            if let Some(next) = search.worker_list.get(index + 1) {
                return Some(*next);
            }
        }
    }
    search.worker_list.into_iter().rev().find(|candidate| {
        FindWindowExW(Some(*candidate), None, w!("SHELLDLL_DefView"), None).is_err()
    })
}
