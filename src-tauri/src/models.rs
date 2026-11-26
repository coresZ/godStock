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
    #[serde(default)]
    pub prev_close: Option<f64>,
    pub source: String,
    pub warning: Option<String>,
}

/// One trading day of 1-minute bars for a single stock. `candles[].date` keeps
/// the `KlineCandle` convention (`"YYYY-MM-DD HH:MM"`), sorted ascending and
/// covering only the requested `date`.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct IntradayPayload {
    pub code: String,
    pub name: String,
    pub date: String,
    pub candles: Vec<KlineCandle>,
    #[serde(default)]
    pub prev_close: Option<f64>,
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
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub as_of: String,
    #[serde(default)]
    pub stale: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct StockQuote {
    pub code: String,
    pub symbol: String,
    pub name: String,
    pub price: f64,
    pub prev_close: f64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub change: f64,
    pub pct: f64,
    pub volume: f64,
    pub amount: f64,
    pub turnover: f64,
    pub as_of: String,
    pub source: String,
    pub stale: bool,
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
    #[serde(default = "default_true")]
    pub visible: bool,
}

fn default_true() -> bool {
    true
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
            visible: true,
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

/* ————————————————— strategy ————————————————— */

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuleCheck {
    pub key: String,
    pub label: String,
    /// `None` means the underlying data is missing; never treated as a pass.
    pub passed: Option<bool>,
    pub value: String,
    pub threshold: String,
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CandidateStats {
    pub price: f64,
    pub float_cap: f64,
    pub amount: f64,
    pub amount_estimated: bool,
    pub seal_amount: f64,
    pub seal_ratio: Option<f64>,
    pub first_seal: i64,
    /// Minutes after 09:30; one-word boards can be 0 or negative.
    pub first_seal_minute: i64,
    pub open_num: i64,
    pub turnover_rate: f64,
    pub limit_up_120d: Option<i64>,
    pub max_streak_250d: Option<i64>,
    pub max_gain_20d: Option<f64>,
    pub sector_name: String,
    pub sector_limit_ups: i64,
    pub sector_continuous: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCandidate {
    pub code: String,
    pub name: String,
    pub rank: Option<i64>,
    pub score: f64,
    pub checks: Vec<RuleCheck>,
    pub stats: CandidateStats,
    pub missing: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedStock {
    pub code: String,
    pub name: String,
    pub failed: Vec<String>,
}

/// One stock of the day's limit-up pool plus the screening stage it reached.
/// `ScreenResult::excluded` is truncated, so the funnel tabs read their full
/// lists from here instead.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScreenStock {
    pub code: String,
    pub name: String,
    pub price: f64,
    /// 当日涨跌幅（%），来自 `Stock.change_rate`。
    pub change_rate: f64,
    /// 连板数，来自 `Stock.board`。
    pub board: i64,
    /// 首次封板时间戳（`Stock.first_seal`），0 表示未知。
    pub first_seal: i64,
    /// 规则分；只有候选会 > 0，其余为 0。
    pub score: f64,
    pub rank: Option<i64>,
    /// 是否首板（`first_board_check` 通过）。
    pub first_board: bool,
    /// 是否通过全部硬过滤（含 f4）。
    pub hard_passed: bool,
    /// 是否通过全部硬过滤 + 封板质量，即进入候选。
    pub candidate: bool,
    /// 失败规则的 key（与 `ExcludedStock.failed` 同一套 key），未失败为空。
    pub failed: Vec<String>,
    /// 是否有规则因数据不足未判定。
    pub pending: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatus {
    pub first_date: String,
    pub last_date: String,
    pub days: i64,
    pub expected_days: i64,
    pub syncing: bool,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScreenResult {
    pub date: String,
    pub universe: i64,
    pub hard_passed: i64,
    pub candidates: Vec<ScreenCandidate>,
    pub excluded: Vec<ExcludedStock>,
    pub warnings: Vec<String>,
    pub history: HistoryStatus,
    pub has_amount: bool,
    /// 当日涨停池里每一只票所处阶段；前端按 firstBoard / hardPassed / candidate / rank 过滤。
    pub stocks: Vec<ScreenStock>,
    /// 是否直接命中进程内筛选结果缓存（同日期 + 同参数 + 同历史覆盖 + 同当日快照）。
    pub cached: bool,
    /// 结果生成时间（unix 秒）；命中缓存时为首次计算时间。
    pub computed_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StrategyProfile {
    pub max_price: f64,
    pub max_float_cap: f64,
    pub min_limit_count: i64,
    pub limit_window_days: i64,
    pub max_streak: i64,
    pub max_gain_20d: f64,
    pub min_sector_limit_ups: i64,
    pub min_sector_continuous: i64,
    pub min_seal_ratio: f64,
    pub max_open_num: i64,
    pub latest_first_seal_minute: i64,
    pub min_turnover: f64,
    pub top_n: i64,
    pub updated_at: i64,
}

impl Default for StrategyProfile {
    fn default() -> Self {
        Self {
            max_price: 30.0,
            max_float_cap: 20_000_000_000.0,
            min_limit_count: 3,
            limit_window_days: 120,
            max_streak: 4,
            max_gain_20d: 60.0,
            min_sector_limit_ups: 3,
            min_sector_continuous: 1,
            min_seal_ratio: 0.10,
            max_open_num: 0,
            latest_first_seal_minute: 30,
            min_turnover: 5.0,
            top_n: 3,
            updated_at: 0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuctionRow {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub prev_close: f64,
    pub open: f64,
    pub volume: f64,
    pub amount: f64,
    pub turnover: f64,
    pub auction_pct: f64,
    pub amount_ratio: Option<f64>,
    pub captured_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuctionResult {
    pub date: String,
    pub captured: bool,
    pub captured_at: i64,
    pub in_window: bool,
    pub rows: Vec<AuctionRow>,
    pub warnings: Vec<String>,
}

/* ————————————————— other · 同花顺自选（问财只读同步） ————————————————— */

/// 登录态。`user_id` 已脱敏（后端从 cookie `userid` 取，绝不回传原值）。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct IwcAuthStatus {
    pub iwc_logged_in: bool,
    pub ths_logged_in: bool,
    pub user_id: String,
}

/// 自选股 / 板块成分股；`market`："1" 沪市 · "0" 深市。
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IwcStock {
    pub code: String,
    pub market: String,
    pub name: String,
}

/// 问财自选板块。`condition` 非空表示动态条件板块（`xn`），静态板块为空。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct IwcPlate {
    pub sn: String,
    pub name: String,
    pub condition: String,
    pub sort: i64,
    pub members: Vec<IwcStock>,
}

/// 一次只读同步的完整结果；`synced_at` 是 unix 秒。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct IwcSnapshot {
    pub plates: Vec<IwcPlate>,
    pub self_stocks: Vec<IwcStock>,
    pub synced_at: i64,
    pub user_id: String,
    pub warnings: Vec<String>,
}

/* ————————————————— 测试 ————————————————— */

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(value: serde_json::Value) -> Vec<String> {
        let mut keys: Vec<String> =
            value.as_object().expect("object").keys().cloned().collect();
        keys.sort_unstable();
        keys
    }

    /// 前端 `src/lib/types.ts` 已按 camelCase 写好，这里把 4 个契约结构的键名钉住。
    #[test]
    fn iwc_contract_camel_case_keys() {
        assert_eq!(keys(serde_json::to_value(IwcAuthStatus::default()).unwrap()), vec![
            "iwcLoggedIn",
            "thsLoggedIn",
            "userId"
        ]);
        assert_eq!(keys(serde_json::to_value(IwcStock::default()).unwrap()), vec![
            "code", "market", "name"
        ]);
        assert_eq!(keys(serde_json::to_value(IwcPlate::default()).unwrap()), vec![
            "condition",
            "members",
            "name",
            "sn",
            "sort"
        ]);
        assert_eq!(keys(serde_json::to_value(IwcSnapshot::default()).unwrap()), vec![
            "plates",
            "selfStocks",
            "syncedAt",
            "userId",
            "warnings"
        ]);
    }
}
