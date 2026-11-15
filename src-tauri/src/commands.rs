use std::path::PathBuf;

use reqwest::Client;
use tauri::State;

use crate::db;
use crate::models::*;
use crate::source;

pub struct AppState {
    pub db_path: PathBuf,
    pub data_dir: PathBuf,
    pub client: Client,
}

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

fn state_conn(state: &AppState) -> Result<rusqlite::Connection, String> {
    db::connect(&state.db_path).map_err(|e| err(e))
}

fn index_name(code: &str) -> &'static str {
    match code {
        "1.000001" => "上证指数",
        "0.399001" => "深证成指",
        "0.399006" => "创业板指",
        _ => "指数",
    }
}

fn compute_calendar(
    today: String,
    is_trade_day: bool,
    dates: Vec<String>,
    source: &str,
    warning: Option<String>,
) -> CalendarInfo {
    let initial = dates
        .iter()
        .filter(|d| d.as_str() <= today.as_str())
        .max()
        .cloned()
        .or_else(|| dates.last().cloned())
        .unwrap_or_default();
    CalendarInfo {
        today,
        is_trade_day,
        initial_date: initial,
        dates,
        source: source.into(),
        warning,
    }
}

#[tauri::command]
pub async fn get_calendar(state: State<'_, AppState>, refresh: bool) -> Result<CalendarInfo, String> {
    let today = db::today_ymd();
    if !refresh {
        if let Ok(conn) = state_conn(&state) {
            if let Ok(Some(mut cached)) = db::load_calendar(&conn) {
                cached.source = "cache".into();
                return Ok(cached);
            }
        }
    }
    match source::fetch_calendar(&state.client, &today).await {
        Ok((is_trade, dates)) => {
            let mut conn = state_conn(&state)?;
            db::save_calendar(&mut conn, &today, &dates, is_trade).map_err(|e| err(e))?;
            drop(conn);
            Ok(compute_calendar(today, is_trade, dates, "network", None))
        }
        Err(e) => {
            let conn = state_conn(&state)?;
            let cached = db::load_calendar(&conn).map_err(|e| err(e))?;
            drop(conn);
            if let Some(mut c) = cached {
                c.warning = Some(format!("交易日历更新失败，使用本地日历 · {e}"));
                return Ok(c);
            }
            Err(format!("无法连接行情服务，请检查网络 · {e}"))
        }
    }
}

#[tauri::command]
pub async fn get_day(
    state: State<'_, AppState>,
    date: String,
    refresh: bool,
) -> Result<DayPayload, String> {
    let date = date.trim().to_string();
    if date.len() != 8 || !date.chars().all(|c| c.is_ascii_digit()) {
        return Err("日期格式应为 YYYYMMDD".into());
    }
    let conn = state_conn(&state)?;
    let cached = db::load_day(&conn, &date).map_err(|e| err(e))?;
    drop(conn);
    if !refresh {
        if let Some(day) = cached {
            return Ok(day);
        }
    }

    match source::fetch_day(&state.client, &date).await {
        Ok((mut day, warning)) => {
            let mut conn = match state_conn(&state) {
                Ok(c) => c,
                Err(e) => return Err(e),
            };
            if let Err(e) = db::save_day(&mut conn, &day) {
                eprintln!("save day failed: {e:#}");
            }
            drop(conn);
            day.source = "network".into();
            day.warning = warning;
            Ok(day)
        }
        Err(e) => {
            if let Some(mut day) = cached {
                day.warning = Some(format!("网络不可用，展示本地缓存 · {e}"));
                return Ok(day);
            }
            Err(format!("无法获取 {date} 的涨停数据 · {e}"))
        }
    }
}

#[tauri::command]
pub async fn get_kline(
    state: State<'_, AppState>,
    code: String,
    period: String,
    refresh: bool,
) -> Result<KlinePayload, String> {
    let code = code.trim().to_string();
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err("股票代码应为 6 位数字".into());
    }
    let period = match period.as_str() {
        "week" => "week",
        "month" => "month",
        _ => "day",
    }
    .to_string();

    let (cached, cached_name, _) = {
        let conn = state_conn(&state)?;
        let loaded = db::load_klines(&conn, &code, &period).map_err(|e| err(e))?;
        let name = if loaded.1.as_deref().unwrap_or("").is_empty() {
            db::stock_name(&conn, &code).unwrap_or_default()
        } else {
            loaded.1.clone().unwrap_or_default()
        };
        (loaded.0, name, loaded.2)
    };

    if !refresh && !cached.is_empty() {
        return Ok(KlinePayload {
            code,
            name: cached_name,
            period,
            latest_date: cached.last().map(|c| c.date.clone()).unwrap_or_default(),
            candles: cached,
            source: "cache".into(),
            warning: None,
        });
    }

    match source::fetch_kline(&state.client, &code, &period).await {
        Ok((name, candles)) => {
            let mut conn = state_conn(&state)?;
            if let Err(e) = db::save_klines(&mut conn, &code, &period, &name, &candles) {
                eprintln!("save kline failed: {e:#}");
            }
            drop(conn);
            Ok(KlinePayload {
                code,
                name,
                period,
                latest_date: candles.last().map(|c| c.date.clone()).unwrap_or_default(),
                candles,
                source: "network".into(),
                warning: None,
            })
        }
        Err(e) => {
            if !cached.is_empty() {
                return Ok(KlinePayload {
                    code,
                    name: cached_name,
                    period,
                    latest_date: cached.last().map(|c| c.date.clone()).unwrap_or_default(),
                    candles: cached,
                    source: "cache".into(),
                    warning: Some(format!("行情更新失败，展示本地K线 · {e}")),
                });
            }
            Err(format!("无法获取 {code} 的K线 · {e}"))
        }
    }
}

fn read_indices(state: &AppState) -> Result<Vec<IndexQuote>, String> {
    let conn = state_conn(state)?;
    let mut out = Vec::new();
    for code in ["1.000001", "0.399001", "0.399006"] {
        let rows = db::load_index_series(&conn, code).map_err(|e| err(e))?;
        if rows.is_empty() {
            continue;
        }
        let last = rows.last().unwrap();
        let prev_close = if rows.len() > 1 { rows[rows.len() - 2].1 } else { last.1 };
        out.push(IndexQuote {
            code: code.to_string(),
            name: index_name(code).to_string(),
            price: last.1,
            change: last.1 - prev_close,
            pct: last.2,
            spark: rows.iter().map(|r| r.1).collect(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn get_indices(state: State<'_, AppState>, refresh: bool) -> Result<Vec<IndexQuote>, String> {
    if !refresh {
        let cached = read_indices(&state)?;
        if !cached.is_empty() {
            return Ok(cached);
        }
    }
    let series = source::fetch_indices(&state.client).await;
    if !series.is_empty() {
        if let Ok(mut conn) = state_conn(&state) {
            for (code, rows) in &series {
                if let Err(e) = db::save_index_series(&mut conn, code, rows) {
                    eprintln!("save index failed: {e:#}");
                }
            }
        }
    }
    read_indices(&state)
}

#[tauri::command]
pub async fn search_stocks(state: State<'_, AppState>, query: String) -> Result<Vec<SearchItem>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let local = {
        let conn = state_conn(&state)?;
        db::local_search(&conn, &q, 8).unwrap_or_default()
    };
    match source::search(&state.client, &q).await {
        Ok(remote) => {
            if !remote.is_empty() {
                if let Ok(conn) = state_conn(&state) {
                    for item in &remote {
                        let _ = db::upsert_stock(&conn, &item.code, &item.name, &item.market);
                    }
                }
            }
            let mut merged = Vec::new();
            for item in remote.into_iter().chain(local.into_iter()) {
                if !merged.iter().any(|x: &SearchItem| x.code == item.code) {
                    merged.push(item);
                }
            }
            merged.truncate(10);
            Ok(merged)
        }
        Err(_) => {
            if local.is_empty() {
                Err("搜索服务暂时不可用".into())
            } else {
                Ok(local)
            }
        }
    }
}

#[tauri::command]
pub async fn recent_stocks(state: State<'_, AppState>) -> Result<Vec<SearchItem>, String> {
    let conn = state_conn(&state)?;
    db::recent_stocks(&conn, 6).map_err(|e| err(e))
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let conn = state_conn(&state)?;
    let theme = db::get_setting(&conn, "theme")
        .map_err(|e| err(e))?
        .unwrap_or_else(|| "dark".into());
    Ok(Settings {
        theme: if theme == "light" { "light".into() } else { "dark".into() },
    })
}

#[tauri::command]
pub async fn set_theme(state: State<'_, AppState>, theme: String) -> Result<(), String> {
    let theme = if theme == "light" { "light" } else { "dark" };
    let conn = state_conn(&state)?;
    db::set_setting(&conn, "theme", theme).map_err(|e| err(e))?;
    Ok(())
}

#[tauri::command]
pub async fn get_data_info(state: State<'_, AppState>) -> Result<DataInfo, String> {
    let conn = state_conn(&state)?;
    db::data_info(&conn, &state.data_dir, &state.db_path).map_err(|e| err(e))
}

#[tauri::command]
pub async fn clear_cache(state: State<'_, AppState>) -> Result<(), String> {
    let mut conn = state_conn(&state)?;
    db::clear_cache(&mut conn).map_err(|e| err(e))?;
    Ok(())
}

#[tauri::command]
pub fn window_control(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => {
            let maximized = window.is_maximized().unwrap_or(false);
            if maximized {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        _ => return Err("unknown window action".into()),
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_data_dir(state: State<'_, AppState>) -> Result<(), String> {
    let path = state.data_dir.clone();
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
    }
    Ok(())
}
