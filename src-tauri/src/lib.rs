mod commands;
mod db;
mod models;
mod source;

use std::path::PathBuf;

use commands::AppState;

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
    let client = source::client().expect("http client");

    tauri::Builder::default()
        .manage(AppState {
            db_path,
            data_dir,
            client,
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_calendar,
            commands::get_day,
            commands::get_kline,
            commands::get_index_kline,
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
            commands::export_text,
            commands::window_control,
            commands::open_data_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tianti");
}
