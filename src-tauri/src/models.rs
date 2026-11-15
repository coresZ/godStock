use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stock {
    pub code: String,
    pub name: String,
    pub board: i64,
    pub days: i64,
    pub streak: i64,
    pub high_days: String,
    pub price: f64,
    pub change_rate: f64,
    pub turnover_rate: f64,
    pub amount: f64,
    pub seal_amount: f64,
    pub first_seal: i64,
    pub last_seal: i64,
    pub open_num: i64,
    pub limit_type: String,
    pub reason: String,
    pub reason_tags: Vec<String>,
    pub market: String,
    pub market_id: i64,
    pub success_rate: f64,
    pub float_cap: f64,
    pub is_new: bool,
    pub is_again_limit: bool,
    pub spark: Vec<f64>,
    pub sectors: Vec<String>,
    pub primary_sector: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sector {
    pub code: String,
    pub name: String,
    pub change: f64,
    pub limit_up_num: i64,
    pub continuous_num: i64,
    pub high_days: String,
    pub days: i64,
    pub stock_codes: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DayStats {
    pub total: i64,
    pub consecutive: i64,
    pub first_board: i64,
    pub max_streak: i64,
    pub one_word: i64,
    pub early_seal: i64,
    pub avg_seal: f64,
    pub avg_success: f64,
    pub open_limit: i64,
    pub limit_down: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DayPayload {
    pub date: String,
    pub weekday: String,
    pub stats: DayStats,
    pub stocks: Vec<Stock>,
    pub open_limit: Vec<Stock>,
    pub limit_down: Vec<Stock>,
    pub sectors: Vec<Sector>,
    pub fetched_at: i64,
    pub source: String,
    pub warning: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInfo {
    pub today: String,
    pub is_trade_day: bool,
    pub initial_date: String,
    pub dates: Vec<String>,
    pub source: String,
    pub warning: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct KlineCandle {
    pub date: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub amount: f64,
    pub pct: f64,
    pub turnover: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct KlinePayload {
    pub code: String,
    pub name: String,
    pub period: String,
    pub candles: Vec<KlineCandle>,
    pub latest_date: String,
    pub source: String,
    pub warning: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexQuote {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub change: f64,
    pub pct: f64,
    pub spark: Vec<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchItem {
    pub code: String,
    pub name: String,
    pub market: String,
    pub security_type: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub ui_scale: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WatchStock {
    pub code: String,
    pub name: String,
    pub market: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WatchGroup {
    pub id: i64,
    pub name: String,
    pub stocks: Vec<WatchStock>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WatchAddResult {
    pub added: i64,
    pub skipped: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorLine {
    pub period: i64,
    pub color: String,
    pub width: f64,
    pub dashed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChartPrefs {
    pub ma_enabled: bool,
    pub ma_lines: Vec<IndicatorLine>,
    pub ema_enabled: bool,
    pub ema_lines: Vec<IndicatorLine>,
    pub kdj_enabled: bool,
    pub kdj_n: i64,
    pub kdj_k: i64,
    pub kdj_d: i64,
}

fn default_lines(periods: [i64; 4], colors: [&str; 4], width: f64, dashed: bool) -> Vec<IndicatorLine> {
    periods
        .into_iter()
        .zip(colors)
        .map(|(period, color)| IndicatorLine {
            period,
            color: color.into(),
            width,
            dashed,
        })
        .collect()
}

impl Default for ChartPrefs {
    fn default() -> Self {
        Self {
            ma_enabled: false,
            ma_lines: default_lines([5, 10, 20, 60], ["sky", "amber", "violet", "brass"], 1.0, true),
            ema_enabled: true,
            ema_lines: default_lines([5, 10, 20, 60], ["brass", "up", "down", "violet"], 1.2, false),
            kdj_enabled: true,
            kdj_n: 9,
            kdj_k: 3,
            kdj_d: 3,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DataInfo {
    pub data_dir: String,
    pub db_path: String,
    pub db_bytes: u64,
    pub day_count: i64,
    pub kline_count: i64,
    pub first_date: String,
    pub last_date: String,
}
