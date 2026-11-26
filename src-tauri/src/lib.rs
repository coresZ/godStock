mod auth;
mod commands;
mod db;
mod lhb;
mod models;
mod source;
mod splash;
mod strategy;
mod win;
mod yyz_tags;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use commands::AppState;
use tauri::Manager;

/// Set to true once the frontend has mounted its shell. The splash watchdog
/// uses it to decide whether it still needs to reveal the main window.
pub static APP_READY: AtomicBool = AtomicBool::new(false);

fn resolve_data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("TIANTI_DATA_DIR") {
        let p = PathBuf::from(custom);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let base = exe.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    base.join("data")
}

fn stored_theme(db_path: &PathBuf) -> bool {
    db::connect(db_path)
        .ok()
        .and_then(|conn| db::get_setting(&conn, "theme").ok().flatten())
        .map(|theme| theme != "light")
        .unwrap_or(true)
}

/// Reveal the main window and retire the native boot overlay. Kept idempotent
/// so the frontend and the watchdog can both call it safely.
pub fn reveal_main(app: &tauri::AppHandle) {
    APP_READY.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    let delay = splash::elapsed()
        .map(|elapsed| 1150u64.saturating_sub(elapsed.as_millis() as u64))
        .unwrap_or(0);
    std::thread::spawn(move || {
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(delay));
        }
        splash::close();
    });
}

pub fn run() {
    let data_dir = resolve_data_dir();
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("create data dir failed: {e}");
        panic!("无法创建数据目录: {}", data_dir.display());
    }
    let db_path = data_dir.join("tianti.db");
    if let Err(e) = db::init(&db_path) {
        eprintln!("init db failed: {e:#}");
        let _ = std::fs::write(
            data_dir.join("startup-error.log"),
            format!("database init failed: {e:#}\n"),
        );
        panic!("数据库初始化失败: {e}");
    }
    let dark = stored_theme(&db_path);
    win::prepare_process();
    win::refresh_icons_once(&db_path);
    let client = source::client().expect("http client");

    tauri::Builder::default()
        .manage(AppState {
            db_path,
            data_dir,
            client,
        })
        .setup(move |app| {
            // Explicitly paint the window background before WebView2 shows its
            // first frame. Without this the window can be transparent while the
            // webview is warming up, which reads as a black or see-through
            // launch screen on some machines.
            let background = if dark {
                tauri::window::Color(0x0b, 0x0c, 0x0f, 255)
            } else {
                tauri::window::Color(0xf2, 0xed, 0xe3, 255)
            };
            // Explicitly pin the window icon. Tauri usually derives it from the
            // exe resource, but an explicit icon also covers the taskbar and
            // Start menu entries when the portable exe was moved or renamed.
            if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png")) {
                for window in app.webview_windows().values() {
                    let _ = window.set_icon(icon.clone());
                    let _ = window.set_background_color(Some(background));
                }
            } else {
                for window in app.webview_windows().values() {
                    let _ = window.set_background_color(Some(background));
                }
            }
            // Boot animation lives *inside* the main window as a GDI child
            // layer, so there is no second top-level window and no full-screen
            // flash. It is destroyed by `app_ready` once the shell is mounted.
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(hwnd) = window.hwnd() {
                    splash::attach(hwnd.0 as isize, dark);
                }
            }
            // Watchdog: if the frontend never reports ready (JS error, stalled
            // WebView), never leave the user staring at the boot overlay forever.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(15));
                if !APP_READY.load(Ordering::SeqCst) {
                    reveal_main(&handle);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_ready,
            commands::get_calendar,
            commands::get_day,
            commands::get_kline,
            commands::get_index_kline,
            commands::get_intraday,
            commands::get_indices,
            commands::get_stock_quote,
            commands::get_stock_quotes,
            commands::get_index_quote,
            commands::search_stocks,
            commands::recent_stocks,
            commands::get_settings,
            commands::set_theme,
            commands::set_ui_scale,
            commands::get_data_info,
            commands::clear_cache,
            commands::get_watch_groups,
            commands::create_watch_group,
            commands::rename_watch_group,
            commands::delete_watch_group,
            commands::add_watch_stocks,
            commands::remove_watch_stock,
            commands::get_chart_prefs,
            commands::save_chart_prefs,
            commands::get_history_status,
            commands::sync_limit_history,
            commands::get_strategy_profile,
            commands::save_strategy_profile,
            commands::run_first_to_second,
            commands::capture_auction,
            commands::get_auction,
            commands::export_text,
            commands::window_control,
            commands::open_data_dir,
            commands::get_lhb_board,
            commands::get_lhb_detail,
            commands::get_lhb_agencies,
            commands::get_lhb_institutions,
            commands::get_lhb_seat_log,
            commands::iwc_auth_status,
            commands::iwc_open_login,
            commands::iwc_close_login,
            commands::iwc_login_window_open,
            commands::iwc_logout,
            commands::iwc_sync,
            commands::iwc_get_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running tianti");
}
