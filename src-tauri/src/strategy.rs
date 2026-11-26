//! 首板 → 二板 rule engine.
//!
//! Read-only by design: screening never writes the day snapshot. The only
//! persistence is the `stock_stats` cache (per-code history aggregates plus the
//! 20-day gain), which the auction tab reuses for `amount_ratio`. Two more
//! caches are derived only: `stock_stats_day` (kline aggregates per trade day)
//! and the in-process `SCREEN_CACHE` (a whole result); neither writes the day
//! snapshot.
//!
//! A past-date miss tops the day series up at most once per hard candidate
//! before pinning `stock_stats_day`; `date >= today` never pins and only uses
//! the whole-result cache, so a half-formed intraday result cannot become a
//! "historical" final when it is reviewed the next day.
//!
//! Rule keys (stable, the excluded list reports them verbatim):
//! `u1`, `first_board`, `f1`..`f5` are hard filters; `s1_one_word`,
//! `s1_seal_minute`, `s1_turnover`, `s2`, `s3` are the 封板质量 rules.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use anyhow::Result;
use reqwest::Client;

use crate::db;
use crate::models::*;
use crate::source;

/// Hard lookback for `max_streak_250d`; also caps the trade-day slice we load.
const HISTORY_WINDOW: usize = 250;
/// Contract: the excluded list is capped.
const EXCLUDED_LIMIT: usize = 40;

/* ————————————————— screen result cache ————————————————— */

/// One whole screening result kept in process memory; A→B→A date/tab flipping
/// returns without re-running the rules.
struct CachedScreen {
    result: ScreenResult,
    computed_at: i64,
}

static SCREEN_CACHE: OnceLock<Mutex<HashMap<String, CachedScreen>>> = OnceLock::new();
/// Small on purpose: a session flips between a handful of dates/profiles.
const SCREEN_CACHE_MAX: usize = 24;

fn screen_cache() -> &'static Mutex<HashMap<String, CachedScreen>> {
    SCREEN_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drop every in-process screening result. Called from the "清除缓存" command so
/// the UI's cache clear really starts from a clean slate (memory + SQLite).
pub fn clear_screen_cache() {
    if let Some(cache) = SCREEN_CACHE.get() {
        if let Ok(mut guard) = cache.lock() {
            guard.clear();
        }
    }
}

/// `date | profile json | history days | history last date | day fetched_at`.
/// `fetched_at` is the day snapshot's fingerprint, so a re-loaded day misses.
fn screen_cache_key(
    date: &str,
    profile: &StrategyProfile,
    history: &HistoryStatus,
    day: &DayPayload,
) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        date,
        serde_json::to_string(profile).unwrap_or_default(),
        history.days,
        history.last_date,
        day.fetched_at
    )
}

/* ————————————————— context ————————————————— */

#[derive(Default)]
struct Ctx {
    /// Trade days ≤ `date`, ascending; always ends with `date`.
    days: Vec<String>,
    /// Dashed last trade day the day-candle series must reach before kline
    /// aggregates may be pinned to `date`. Empty when nothing can be required:
    /// no calendar/history, or `date` is today/future (the bar may not exist
    /// yet). Pinning with a stale series would freeze the wrong percentages.
    require_kline_date: String,
    /// The most recent `limit_window_days` of `days`.
    recent: HashSet<String>,
    prev_date: String,
    prev_codes: HashSet<String>,
    /// `prev_codes` is non-empty → the first-board test can use history.
    history_ok: bool,
    /// Distinct days already backfilled (0 → history was never synced).
    hist_days: i64,
    /// `code -> dates` inside the window.
    occ: HashMap<String, Vec<String>>,
    last_limit: HashMap<String, String>,
    /// `sector name -> (limit_up_num, continuous_num)`.
    sectors: HashMap<String, (i64, i64)>,
    has_sector_data: bool,
}

fn load_ctx(db_path: &Path, date: &str, profile: &StrategyProfile) -> Result<Ctx> {
    let conn = db::connect(db_path)?;
    let mut days = db::trade_days_upto(&conn, date, HISTORY_WINDOW)?;
    // Captured before `date` is appended below: it is the last trade day the
    // calendar (or history fallback) actually knows about.
    let calendar_last = days.last().cloned().unwrap_or_default();
    if days.last().map(|d| d.as_str()) != Some(date) {
        // A loaded snapshot for `date` proves it traded; keep the series dense.
        days.push(date.to_string());
    }
    let prev_date = days
        .iter()
        .filter(|d| d.as_str() < date)
        .next_back()
        .cloned()
        .unwrap_or_default();
    let prev_codes = if prev_date.is_empty() {
        HashSet::new()
    } else {
        db::history_codes_for_date(&conn, &prev_date)?
    };
    let start = days.first().cloned().unwrap_or_else(|| date.to_string());
    let occ = db::history_occurrences(&conn, &start, date)?;
    let last_limit = db::history_last_dates(&conn)?;
    let (_, _, hist_days) = db::history_coverage(&conn)?;
    let window = profile.limit_window_days.clamp(1, 250) as usize;
    let recent: HashSet<String> = days.iter().rev().take(window).cloned().collect();
    // Today/future cannot require a bar (it may not be published yet); for a
    // past date the series must reach the last trade day the calendar knows.
    let require_kline_date = if calendar_last.is_empty() || date >= db::today_ymd().as_str() {
        String::new()
    } else {
        dash(&calendar_last)
    };
    Ok(Ctx {
        days,
        require_kline_date,
        recent,
        prev_date,
        history_ok: !prev_codes.is_empty(),
        prev_codes,
        hist_days,
        occ,
        last_limit,
        sectors: HashMap::new(),
        has_sector_data: false,
    })
}

impl Ctx {
    /// Limit-up dates of `code` inside the window. `date` itself always counts:
    /// the stock is in today's pool by definition, even when the history sync
    /// has not covered today yet.
    fn occurrences(&self, code: &str, date: &str) -> Vec<String> {
        let mut dates = self.occ.get(code).cloned().unwrap_or_default();
        if !dates.iter().any(|d| d == date) {
            dates.push(date.to_string());
        }
        dates.sort();
        dates.dedup();
        dates
    }
}

/* ————————————————— formatting helpers ————————————————— */

fn money(v: f64) -> String {
    format!("{v:.2} 元")
}

fn yi(v: f64) -> String {
    format!("{:.2} 亿", v / 1e8)
}

fn pct(v: f64) -> String {
    format!("{v:.2}%")
}

/// Minutes since 09:30 for a Beijing-time unix timestamp (09:30 → 0).
fn seal_minute(ts: i64) -> i64 {
    if ts <= 0 {
        return 0;
    }
    let secs = (ts + 8 * 3600).rem_euclid(86_400);
    secs / 60 - 570
}

/// `09:35` clock label for a Beijing-time unix timestamp.
fn clock_label(ts: i64) -> String {
    let secs = (ts + 8 * 3600).rem_euclid(86_400);
    format!("{:02}:{:02}", secs / 3600, (secs % 3600) / 60)
}

/// `10:00` label for an offset that is already "minutes after 09:30".
fn minute_label(minute: i64) -> String {
    let total = (570 + minute).rem_euclid(24 * 60);
    format!("{:02}:{:02}", total / 60, total % 60)
}

fn dash(date: &str) -> String {
    if date.len() == 8 && date.chars().all(|c| c.is_ascii_digit()) {
        format!("{}-{}-{}", &date[0..4], &date[4..6], &date[6..8])
    } else {
        date.to_string()
    }
}

fn check(
    key: &str,
    label: &str,
    passed: Option<bool>,
    value: String,
    threshold: String,
    note: Option<String>,
) -> RuleCheck {
    RuleCheck {
        key: key.into(),
        label: label.into(),
        passed,
        value,
        threshold,
        note,
    }
}

/* ————————————————— hard filters ————————————————— */

fn name_is_special(name: &str) -> bool {
    let upper = name.to_uppercase();
    upper.contains("ST") || upper.contains("PT") || name.contains('退')
}

/// U1 — ST / \*ST / 退市 / 新股。
fn u1_check(stk: &Stock) -> RuleCheck {
    let value = if name_is_special(&stk.name) {
        format!("{}（ST/退市风险）", stk.name)
    } else if stk.is_new {
        "新股".to_string()
    } else {
        "正常".to_string()
    };
    let passed = Some(!name_is_special(&stk.name) && !stk.is_new);
    check("u1", "排除 ST / 退市 / 新股", passed, value, "非 ST / 非退市 / 非新股".into(), None)
}

/// 首板 — today in the pool, absent from the previous trade day's pool.
fn first_board_check(stk: &Stock, ctx: &Ctx) -> RuleCheck {
    if ctx.history_ok {
        let passed = !ctx.prev_codes.contains(&stk.code);
        let value = if passed {
            "前一交易日未涨停".to_string()
        } else {
            format!("{} 板（前一交易日已涨停）", stk.streak)
        };
        check("first_board", "首板", Some(passed), value, "前一交易日不在涨停池".into(), None)
    } else {
        let passed = stk.streak <= 1;
        check(
            "first_board",
            "首板",
            Some(passed),
            format!("{} 板（回退）", stk.streak),
            "≤ 1 板".into(),
            Some(if ctx.prev_date.is_empty() {
                "没有交易日历，按涨停池 streak 回退判断".into()
            } else {
                format!("{} 无涨停记录，按涨停池 streak 回退判断", ctx.prev_date)
            }),
        )
    }
}

/// F1 — 股价。
fn f1_check(stk: &Stock, profile: &StrategyProfile) -> RuleCheck {
    let value = if stk.price > 0.0 { money(stk.price) } else { "—".into() };
    let passed = if stk.price > 0.0 { Some(stk.price <= profile.max_price) } else { None };
    check("f1", "股价", passed, value, format!("≤ {}", money(profile.max_price)), None)
}

/// F2 — 流通市值。
fn f2_check(stk: &Stock, profile: &StrategyProfile) -> RuleCheck {
    let value = if stk.float_cap > 0.0 { yi(stk.float_cap) } else { "—".into() };
    let passed = if stk.float_cap > 0.0 {
        Some(stk.float_cap <= profile.max_float_cap)
    } else {
        None
    };
    check("f2", "流通市值", passed, value, format!("≤ {}", yi(profile.max_float_cap)), None)
}

/// F3 — 近 N 个交易日涨停次数（`trade_days` 口径，含当日）。
fn f3_check(stk: &Stock, ctx: &Ctx, date: &str, profile: &StrategyProfile) -> RuleCheck {
    let window = profile.limit_window_days.clamp(1, 250);
    let threshold = format!("≥ {} 次 / {} 日", profile.min_limit_count, window);
    if ctx.hist_days <= 0 {
        return check("f3", "近期涨停次数", None, "—".into(), threshold, Some("历史未回填".into()));
    }
    let count = ctx
        .occurrences(&stk.code, date)
        .iter()
        .filter(|d| ctx.recent.contains(*d))
        .count() as i64;
    check(
        "f3",
        "近期涨停次数",
        Some(count >= profile.min_limit_count),
        format!("{count} 次"),
        threshold,
        None,
    )
}

/// F5 — 主板块涨停 / 连板家数。
fn f5_check(stk: &Stock, ctx: &Ctx, profile: &StrategyProfile) -> RuleCheck {
    let threshold = format!(
        "涨停 ≥ {} 家 · 连板 ≥ {} 家",
        profile.min_sector_limit_ups, profile.min_sector_continuous
    );
    if !ctx.has_sector_data {
        return check("f5", "主板块效应", None, "—".into(), threshold, Some("板块数据不可用".into()));
    }
    let name = stk
        .primary_sector
        .clone()
        .or_else(|| stk.sectors.first().cloned())
        .unwrap_or_default();
    let (ups, cont) = ctx.sectors.get(&name).copied().unwrap_or((0, 0));
    let passed = ups >= profile.min_sector_limit_ups && cont >= profile.min_sector_continuous;
    let value = if name.is_empty() {
        "无主板块 · 0 家".to_string()
    } else {
        format!("{name} · 涨停 {ups} 家 / 连板 {cont} 家")
    };
    check("f5", "主板块效应", Some(passed), value, threshold, None)
}

/// F4 — 近 250 日最大连板与 20 日涨幅都不能太夸张。
fn f4_check(row: &db::StockStatsRow, profile: &StrategyProfile, hist_ok: bool) -> RuleCheck {
    let streak = if hist_ok && row.max_streak_250d > 0 {
        Some(row.max_streak_250d)
    } else {
        None
    };
    // `max_gain_20d == 0` doubles as "kline unavailable": a stock sitting on a
    // limit-up cannot have a 0% best 20-day gain.
    let gain = if row.max_gain_20d > 0.0 { Some(row.max_gain_20d) } else { None };

    let streak_ok = streak.map(|v| v < profile.max_streak);
    let gain_ok = gain.map(|v| v < profile.max_gain_20d);
    let passed = match (streak_ok, gain_ok) {
        (Some(false), _) | (_, Some(false)) => Some(false),
        (Some(true), Some(true)) => Some(true),
        _ => None,
    };
    let value = format!(
        "连板 {} · 20 日涨幅 {}",
        streak.map(|v| format!("{v} 板")).unwrap_or_else(|| "—".into()),
        gain.map(pct).unwrap_or_else(|| "—".into()),
    );
    let threshold = format!("< {} 板 · < {}", profile.max_streak, pct(profile.max_gain_20d));
    let note = if streak.is_none() || gain.is_none() {
        Some("历史或日K不足".to_string())
    } else {
        None
    };
    check("f4", "历史高度 / 涨幅", passed, value, threshold, note)
}

/* ————————————————— 封板质量 ————————————————— */

fn quality_checks(stk: &Stock, stats: &CandidateStats, profile: &StrategyProfile) -> Vec<RuleCheck> {
    let mut out = Vec::new();

    let one_word = stk.limit_type.contains("一字");
    let one_word_passed = if stk.limit_type.trim().is_empty() {
        None
    } else {
        Some(!one_word)
    };
    out.push(check(
        "s1_one_word",
        "非一字板",
        one_word_passed,
        if stk.limit_type.trim().is_empty() {
            "—".into()
        } else if one_word {
            format!("{}（一字）", stk.limit_type)
        } else {
            "非一字".into()
        },
        "非一字板".into(),
        None,
    ));

    let seal_passed = if stats.first_seal > 0 {
        Some(stats.first_seal_minute <= profile.latest_first_seal_minute)
    } else {
        None
    };
    out.push(check(
        "s1_seal_minute",
        "首封时间",
        seal_passed,
        if stats.first_seal > 0 { clock_label(stats.first_seal) } else { "—".into() },
        format!("≤ {}", minute_label(profile.latest_first_seal_minute)),
        None,
    ));

    let turnover_passed = if stats.turnover_rate > 0.0 {
        Some(stats.turnover_rate >= profile.min_turnover)
    } else {
        None
    };
    out.push(check(
        "s1_turnover",
        "换手率",
        turnover_passed,
        if stats.turnover_rate > 0.0 { pct(stats.turnover_rate) } else { "—".into() },
        format!("≥ {}", pct(profile.min_turnover)),
        None,
    ));

    out.push(check(
        "s2",
        "开板次数",
        Some(stats.open_num <= profile.max_open_num),
        format!("{} 次", stats.open_num),
        format!("≤ {} 次", profile.max_open_num),
        None,
    ));

    out.push(check(
        "s3",
        "封单比",
        stats.seal_ratio.map(|r| r >= profile.min_seal_ratio),
        stats.seal_ratio.map(|r| pct(r * 100.0)).unwrap_or_else(|| "—".into()),
        format!("≥ {}", pct(profile.min_seal_ratio * 100.0)),
        if stats.seal_ratio.is_none() {
            Some("成交额不可用".into())
        } else {
            None
        },
    ));

    out
}

/* ————————————————— stats ————————————————— */

/// Longest run of *consecutive trade days* in `dates` (contract: rebuild the
/// streak from the date series, never from the history `streak` column).
fn max_consecutive(dates: &[String], days: &[String]) -> i64 {
    if dates.is_empty() || days.is_empty() {
        return 0;
    }
    let index: HashMap<&str, usize> = days.iter().enumerate().map(|(i, d)| (d.as_str(), i)).collect();
    let mut idx: Vec<usize> = dates.iter().filter_map(|d| index.get(d.as_str()).copied()).collect();
    idx.sort_unstable();
    idx.dedup();
    if idx.is_empty() {
        return 0;
    }
    let mut best = 1i64;
    let mut run = 1i64;
    for pair in idx.windows(2) {
        if pair[1] == pair[0] + 1 {
            run += 1;
            best = best.max(run);
        } else {
            run = 1;
        }
    }
    best
}

/// Max `close[i] / close[i - window] - 1` over the last `lookback` bars, in %.
fn rolling_max_gain(closes: &[f64], window: usize, lookback: usize) -> Option<f64> {
    if closes.len() <= window {
        return None;
    }
    let start = closes.len().saturating_sub(lookback);
    let mut best: Option<f64> = None;
    for i in start.max(window)..closes.len() {
        let base = closes[i - window];
        if base <= 0.0 {
            continue;
        }
        let gain = (closes[i] / base - 1.0) * 100.0;
        best = Some(best.map_or(gain, |b: f64| b.max(gain)));
    }
    best
}

fn build_stats(stk: &Stock, row: &db::StockStatsRow, ctx: &Ctx) -> CandidateStats {
    let amount = if stk.amount > 0.0 {
        stk.amount
    } else if stk.turnover_rate > 0.0 && stk.float_cap > 0.0 {
        stk.turnover_rate / 100.0 * stk.float_cap
    } else {
        0.0
    };
    let amount_estimated = stk.amount <= 0.0 && amount > 0.0;
    let seal_ratio = if amount > 0.0 { Some(stk.seal_amount / amount) } else { None };
    let name = stk
        .primary_sector
        .clone()
        .or_else(|| stk.sectors.first().cloned())
        .unwrap_or_default();
    let (ups, cont) = ctx.sectors.get(&name).copied().unwrap_or((0, 0));
    let hist_ok = ctx.hist_days > 0;
    CandidateStats {
        price: stk.price,
        float_cap: stk.float_cap,
        amount,
        amount_estimated,
        seal_amount: stk.seal_amount,
        seal_ratio,
        first_seal: stk.first_seal,
        first_seal_minute: seal_minute(stk.first_seal),
        open_num: stk.open_num,
        turnover_rate: stk.turnover_rate,
        limit_up_120d: if hist_ok { Some(row.limit_up_120d) } else { None },
        max_streak_250d: if hist_ok { Some(row.max_streak_250d) } else { None },
        max_gain_20d: if row.max_gain_20d > 0.0 { Some(row.max_gain_20d) } else { None },
        sector_name: name,
        sector_limit_ups: ups,
        sector_continuous: cont,
    }
}

/// 首封 40% · 封单比 30% · 板块 20% · 换手 10%, 0–100.
fn score_candidate(stats: &CandidateStats, profile: &StrategyProfile) -> f64 {
    let latest = profile.latest_first_seal_minute.max(1) as f64;
    let remaining = (latest - stats.first_seal_minute as f64).clamp(0.0, latest);
    let seal_time = 40.0 * remaining / latest;

    let ratio_ref = (profile.min_seal_ratio * 3.0).max(0.01);
    let ratio = 30.0 * (stats.seal_ratio.unwrap_or(0.0) / ratio_ref).clamp(0.0, 1.0);

    let sector_ref = (profile.min_sector_limit_ups.saturating_mul(3)).max(1) as f64;
    let sector = 20.0 * (stats.sector_limit_ups as f64 / sector_ref).clamp(0.0, 1.0);

    let turnover_ref = (profile.min_turnover * 4.0).max(1.0);
    let turnover = 10.0 * (stats.turnover_rate / turnover_ref).clamp(0.0, 1.0);

    let total = seal_time + ratio + sector + turnover;
    (total.clamp(0.0, 100.0) * 10.0).round() / 10.0
}

/// Cached aggregates for one code. History fields are recomputed every run
/// (cheap SQL); the kline fields come from `stock_stats_day` (pinned to `date`)
/// unless `refresh` was asked for. At most two connections per stock: one load
/// before the await, one save after it (never shared across the await).
async fn ensure_stats(
    client: &Client,
    db_path: &Path,
    stk: &Stock,
    date: &str,
    ctx: &Ctx,
    refresh: bool,
) -> (db::StockStatsRow, bool) {
    let mut row = db::StockStatsRow {
        code: stk.code.clone(),
        as_of: date.to_string(),
        ..Default::default()
    };

    if ctx.hist_days > 0 {
        let dates = ctx.occurrences(&stk.code, date);
        row.limit_up_120d = dates.iter().filter(|d| ctx.recent.contains(*d)).count() as i64;
        row.max_streak_250d = max_consecutive(&dates, &ctx.days);
        // `last_limit` also covers limit-ups older than the 250-day window.
        let mut last = ctx.last_limit.get(&stk.code).cloned().unwrap_or_default();
        if let Some(window_last) = dates.last() {
            if window_last.as_str() > last.as_str() {
                last = window_last.clone();
            }
        }
        row.last_limit_date = last;
    }

    // The day cache key is `(code, as_of)`, so a positive `computed_at` is a hit
    // on its own — no need to re-check the date. Only covered rows are ever
    // pinned now, so a hit is trusted (legacy rows are honoured as-is).
    let day_cached = if refresh {
        None
    } else {
        db::connect(db_path)
            .ok()
            .and_then(|conn| db::load_stock_stats_day(&conn, &stk.code, date).ok().flatten())
            .filter(|c| c.computed_at > 0)
    };
    let day_fresh = day_cached.is_none();
    let mut covered = true;
    if let Some(c) = day_cached {
        // Hits are historical pins only: today is never pinned (see the write
        // gate below), so a hit is always a past-date final.
        row.max_gain_20d = c.max_gain_20d;
        row.max_gain_250d = c.max_gain_250d;
        row.prev_day_amount = c.prev_day_amount;
        row.computed_at = c.computed_at;
    } else {
        match kline_stats(client, db_path, &stk.code, date, &ctx.require_kline_date, refresh).await {
            Some(agg) => {
                row.max_gain_20d = agg.max_gain_20d;
                row.max_gain_250d = agg.max_gain_250d;
                row.prev_day_amount = agg.prev_day_amount;
                // Numbers are usable this run even when stale, but they must
                // not be pinned to the date (next run retries). A today row is
                // returned but never pinned either — see the write gate below.
                covered = agg.covers_date;
                row.computed_at = db::now_ts();
            }
            None => {
                row.computed_at = 0;
                return (row, false);
            }
        }
    }
    row.computed_at = if row.computed_at > 0 { row.computed_at } else { db::now_ts() };
    if let Ok(conn) = db::connect(db_path) {
        // Old table keeps its "latest value per code" semantics (auction tab).
        if let Err(e) = db::save_stock_stats(&conn, &row) {
            eprintln!("save stock stats failed: {e:#}");
        }
        // Pin only when the candle series really reaches the as-of date: a row
        // written from a stale series would otherwise never be invalidated.
        // `date >= today` is never pinned — today is still forming, so a
        // half-formed intraday result must not read as a historical final when
        // the same date is reviewed tomorrow.
        if day_fresh && covered && date < db::today_ymd().as_str() {
            let day_row = db::StockStatsDayRow {
                code: row.code.clone(),
                as_of: row.as_of.clone(),
                max_gain_20d: row.max_gain_20d,
                max_gain_250d: row.max_gain_250d,
                prev_day_amount: row.prev_day_amount,
                computed_at: row.computed_at,
            };
            if let Err(e) = db::save_stock_stats_day(&conn, &day_row) {
                eprintln!("save stock stats day failed: {e:#}");
            }
        }
    }
    (row, true)
}

/// `(max_gain_20d, max_gain_250d, prev_day_amount)` from the daily candles.
///
/// Only candles up to and including `date` are used: a past-date replay must
/// not see later bars (look-ahead), and `prev_day_amount` stays `< date`.
fn kline_metrics(candles: &[KlineCandle], date: &str) -> Option<(f64, f64, f64)> {
    let today = dash(date);
    let candles: Vec<&KlineCandle> = candles
        .iter()
        .filter(|c| c.date.as_str() <= today.as_str())
        .collect();
    let closes: Vec<f64> = candles.iter().filter(|c| c.close > 0.0).map(|c| c.close).collect();
    if closes.len() < 2 {
        return None;
    }
    let gain20 = rolling_max_gain(&closes, 20, 250).unwrap_or(0.0);
    // 250-day range gain: last close vs. the first close of the window.
    let window = closes.len().min(250);
    let base = closes[closes.len() - window];
    let gain250 = if base > 0.0 {
        (closes[closes.len() - 1] / base - 1.0) * 100.0
    } else {
        0.0
    };
    let prev_amount = candles
        .iter()
        .filter(|c| c.date.as_str() < today.as_str())
        .next_back()
        .map(|c| c.amount)
        .unwrap_or(0.0);
    Some((gain20, gain250, prev_amount))
}

/// Aggregates for one code/date plus whether the series actually reaches the
/// day the screen needs (see `Ctx::require_kline_date`).
struct KlineAgg {
    max_gain_20d: f64,
    max_gain_250d: f64,
    prev_day_amount: f64,
    /// `false` → stale series: show the numbers for this run, never pin them.
    covers_date: bool,
}

/// `true` when the series has a bar at/after `require` (dashed `YYYY-MM-DD`).
/// Empty `require` means "nothing can be required" and counts as covered.
fn kline_covers(candles: &[KlineCandle], require: &str) -> bool {
    if require.is_empty() {
        return true;
    }
    candles.last().map(|c| c.date.as_str() >= require).unwrap_or(false)
}

/// One source top-up of the day series, persisted for the next run. `None`
/// when the source has nothing usable (offline / empty payload).
async fn fetch_day_klines(client: &Client, db_path: &Path, code: &str) -> Option<Vec<KlineCandle>> {
    match source::fetch_kline(client, code, "day", false).await {
        Ok((name, rows, _)) if !rows.is_empty() => {
            if let Ok(mut conn) = db::connect(db_path) {
                if let Err(e) = db::save_klines(&mut conn, code, "day", &name, &rows) {
                    eprintln!("save strategy kline failed: {e:#}");
                }
            }
            Some(rows)
        }
        _ => None,
    }
}

async fn kline_stats(
    client: &Client,
    db_path: &Path,
    code: &str,
    date: &str,
    require_date: &str,
    refresh: bool,
) -> Option<KlineAgg> {
    let mut candles: Vec<KlineCandle> = Vec::new();
    if !refresh {
        if let Ok(conn) = db::connect(db_path) {
            if let Ok((rows, _, _)) = db::load_klines(&conn, code, "day") {
                candles = rows;
            }
        }
    }
    let mut fetched = false;
    if candles.is_empty() {
        candles = fetch_day_klines(client, db_path, code).await?;
        fetched = true;
    }
    candles.sort_by(|a, b| a.date.cmp(&b.date));
    // A local series ending before the as-of date would pin wrong aggregates,
    // so top it up from the source once before judging coverage. Skipped when
    // this call already fetched (avoid a second request for the same code).
    if !fetched && !kline_covers(&candles, require_date) {
        if let Some(rows) = fetch_day_klines(client, db_path, code).await {
            candles = rows;
            candles.sort_by(|a, b| a.date.cmp(&b.date));
        }
    }
    let (gain20, gain250, prev_amount) = kline_metrics(&candles, date)?;
    Some(KlineAgg {
        max_gain_20d: gain20,
        max_gain_250d: gain250,
        prev_day_amount: prev_amount,
        covers_date: kline_covers(&candles, require_date),
    })
}

/* ————————————————— entry point ————————————————— */

pub async fn screen(
    client: &Client,
    db_path: &Path,
    date: &str,
    day: &DayPayload,
    profile: &StrategyProfile,
    history: HistoryStatus,
    refresh: bool,
) -> ScreenResult {
    let cache_key = screen_cache_key(date, profile, &history, day);
    if !refresh {
        if let Ok(cache) = screen_cache().lock() {
            if let Some(hit) = cache.get(&cache_key) {
                let mut r = hit.result.clone();
                r.cached = true;
                r.computed_at = hit.computed_at;
                // The history status is a live input (sync progress), not a
                // result, so keep it current even on a cache hit.
                r.history = history;
                return r;
            }
        }
    }
    let mut warnings: Vec<String> = Vec::new();
    // Every pool stock gets a row up front (day order preserved) so the funnel
    // tabs can show all four stages; each step below only updates its own row.
    let mut stocks: Vec<ScreenStock> = day
        .stocks
        .iter()
        .map(|stk| ScreenStock {
            code: stk.code.clone(),
            name: stk.name.clone(),
            price: stk.price,
            change_rate: stk.change_rate,
            board: stk.board,
            first_seal: stk.first_seal,
            ..ScreenStock::default()
        })
        .collect();
    let mut index_of: HashMap<&str, usize> = HashMap::with_capacity(day.stocks.len());
    for (i, stk) in day.stocks.iter().enumerate() {
        index_of.entry(stk.code.as_str()).or_insert(i);
    }
    let mut ctx = match load_ctx(db_path, date, profile) {
        Ok(c) => c,
        Err(e) => {
            warnings.push(format!("历史缓存读取失败 · {e:#}"));
            Ctx::default()
        }
    };
    for sector in &day.sectors {
        ctx.sectors
            .insert(sector.name.clone(), (sector.limit_up_num, sector.continuous_num));
    }
    ctx.has_sector_data = !day.sectors.is_empty();

    if ctx.hist_days <= 0 {
        warnings.push("历史未回填：近 120 日涨停次数与 250 日最大连板无法计算，请先同步历史".into());
    } else if ctx.hist_days < 60 {
        warnings.push(format!("历史仅覆盖 {} 个交易日，涨停次数与连板高度口径偏窄", ctx.hist_days));
    }
    if !ctx.history_ok {
        warnings.push(format!(
            "历史缺少 {} 的涨停池，首板按 streak ≤ 1 回退判断",
            if ctx.prev_date.is_empty() { "上一交易日".to_string() } else { ctx.prev_date.clone() }
        ));
    }
    if !ctx.has_sector_data {
        warnings.push("板块数据缺失，主板块规则无法判定".into());
    }

    // 1) cheap hard filters
    let mut excluded: Vec<ExcludedStock> = Vec::new();
    let mut pending = 0usize;
    let mut first_board_count = 0i64;
    let mut hard_candidates: Vec<usize> = Vec::new();
    for (i, stk) in day.stocks.iter().enumerate() {
        let first_board = first_board_check(stk, &ctx);
        let is_first_board = first_board.passed == Some(true);
        if is_first_board {
            first_board_count += 1;
        }
        let checks = vec![
            u1_check(stk),
            first_board,
            f1_check(stk, profile),
            f2_check(stk, profile),
            f3_check(stk, &ctx, date, profile),
            f5_check(stk, &ctx, profile),
        ];
        let failed: Vec<String> = checks
            .iter()
            .filter(|c| c.passed == Some(false))
            .map(|c| c.key.clone())
            .collect();
        let has_pending = checks.iter().any(|c| c.passed.is_none());
        {
            let slot = &mut stocks[i];
            slot.first_board = is_first_board;
            slot.failed = failed.clone();
            slot.pending = has_pending;
        }
        if !failed.is_empty() {
            excluded.push(ExcludedStock {
                code: stk.code.clone(),
                name: stk.name.clone(),
                failed,
            });
            continue;
        }
        if has_pending {
            pending += 1;
            continue;
        }
        hard_candidates.push(i);
    }

    // 2) F4 needs the kline aggregates, so it runs last among the hard filters
    let mut kline_fail = 0usize;
    let mut final_pass: Vec<(usize, db::StockStatsRow)> = Vec::new();
    for i in hard_candidates {
        let stk = &day.stocks[i];
        let (row, ok) = ensure_stats(client, db_path, stk, date, &ctx, refresh).await;
        if !ok {
            kline_fail += 1;
        }
        let f4 = f4_check(&row, profile, ctx.hist_days > 0);
        if f4.passed == Some(false) {
            stocks[i].failed = vec![f4.key.clone()];
            excluded.push(ExcludedStock {
                code: stk.code.clone(),
                name: stk.name.clone(),
                failed: vec![f4.key.clone()],
            });
            continue;
        }
        if f4.passed.is_none() {
            stocks[i].pending = true;
            pending += 1;
            continue;
        }
        stocks[i].hard_passed = true;
        final_pass.push((i, row));
    }
    let hard_passed = final_pass.len() as i64;

    // 3) 封板质量 — only `passed == true` survives into the candidate list
    let mut candidates: Vec<ScreenCandidate> = Vec::new();
    let mut estimated = 0usize;
    let mut dropped_by_quality = 0usize;
    for (i, row) in final_pass {
        let stk = &day.stocks[i];
        let stats = build_stats(stk, &row, &ctx);
        if stats.amount_estimated {
            estimated += 1;
        }
        let checks = quality_checks(stk, &stats, profile);
        let failed: Vec<String> = checks
            .iter()
            .filter(|c| c.passed != Some(true))
            .map(|c| c.key.clone())
            .collect();
        let has_pending = checks.iter().any(|c| c.passed.is_none());
        if !failed.is_empty() {
            dropped_by_quality += 1;
            stocks[i].failed = failed.clone();
            if has_pending {
                stocks[i].pending = true;
            }
            excluded.push(ExcludedStock {
                code: stk.code.clone(),
                name: stk.name.clone(),
                failed,
            });
            continue;
        }
        let missing: Vec<String> = checks
            .iter()
            .filter(|c| c.passed.is_none())
            .map(|c| c.key.clone())
            .collect();
        let score = score_candidate(&stats, profile);
        stocks[i].candidate = true;
        stocks[i].score = score;
        candidates.push(ScreenCandidate {
            code: stk.code.clone(),
            name: stk.name.clone(),
            rank: None,
            score,
            checks,
            stats,
            missing,
        });
    }

    // 4) rank: score desc, then earlier first seal, then higher seal ratio
    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.stats.first_seal_minute.cmp(&b.stats.first_seal_minute))
            .then(
                b.stats
                    .seal_ratio
                    .unwrap_or(0.0)
                    .partial_cmp(&a.stats.seal_ratio.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
            .then(a.code.cmp(&b.code))
    });
    let top_n = profile.top_n.clamp(1, 50) as usize;
    for (i, c) in candidates.iter_mut().enumerate() {
        c.rank = if i < top_n { Some(i as i64 + 1) } else { None };
        // `candidates` is sorted now, so the rank goes back through the code index.
        if let Some(&idx) = index_of.get(c.code.as_str()) {
            stocks[idx].rank = c.rank;
        }
    }
    excluded.sort_by(|a, b| a.code.cmp(&b.code));
    excluded.truncate(EXCLUDED_LIMIT);

    if dropped_by_quality > 0 {
        warnings.push(format!("{dropped_by_quality} 只通过硬过滤的个股未通过封板质量规则"));
    }
    if pending > 0 {
        warnings.push(format!("{pending} 只个股因历史或板块数据不足未参与判定"));
    }
    if kline_fail > 0 {
        warnings.push(format!("{kline_fail} 只个股日K不可用，20 日涨幅按缺失处理"));
    }
    if estimated > 0 {
        warnings.push(format!("{estimated} 只个股成交额由换手率×流通市值估算"));
    }

    let computed_at = db::now_ts();
    let result = ScreenResult {
        date: date.to_string(),
        universe: first_board_count,
        hard_passed,
        candidates,
        excluded,
        warnings,
        history,
        has_amount: day.stocks.iter().any(|s| s.amount > 0.0),
        stocks,
        cached: false,
        computed_at,
    };
    if let Ok(mut cache) = screen_cache().lock() {
        if cache.len() >= SCREEN_CACHE_MAX && !cache.contains_key(&cache_key) {
            cache.clear();
        }
        cache.insert(
            cache_key,
            CachedScreen {
                result: result.clone(),
                computed_at,
            },
        );
    }
    result
}

/* ————————————————— offline cache check ————————————————— */

/// Manual, fully offline check of the two new caches. Ignored by default so the
/// normal suite stays fast; run it after touching the cache code:
/// `cargo test --lib -- --ignored screen_cache --nocapture`
#[cfg(test)]
mod cache_tests {
    use super::*;
    use std::future::Future;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::task::{Context, Poll, Wake, Waker};

    /// Minimal executor. Every awaited path here is served from local SQLite
    /// (klines are seeded), so the first poll already returns `Ready`; a stuck
    /// future means the test accidentally reached the network.
    fn block_on<F: Future>(f: F) -> F::Output {
        struct Noop;
        impl Wake for Noop {
            fn wake(self: Arc<Self>) {}
            fn wake_by_ref(self: &Arc<Self>) {}
        }
        let waker = Waker::from(Arc::new(Noop));
        let mut cx = Context::from_waker(&waker);
        let mut f = std::pin::pin!(f);
        for _ in 0..1_000_000 {
            if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
            std::thread::yield_now();
        }
        panic!("screen future stayed pending — it tried to do real I/O");
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "tianti-cache-test-{}-{}",
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ));
            std::fs::create_dir_all(&p).expect("create temp dir");
            Self(p)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn profile() -> StrategyProfile {
        StrategyProfile {
            max_price: 1000.0,
            max_float_cap: 1e12,
            min_limit_count: 1,
            limit_window_days: 120,
            max_streak: 20,
            max_gain_20d: 1000.0,
            min_sector_limit_ups: 0,
            min_sector_continuous: 0,
            min_seal_ratio: 0.0,
            max_open_num: 99,
            latest_first_seal_minute: 240,
            min_turnover: 0.0,
            top_n: 5,
            updated_at: 0,
        }
    }

    fn stock() -> Stock {
        Stock {
            code: "600001".into(),
            name: "测试股份".into(),
            board: 1,
            days: 1,
            streak: 1,
            price: 10.0,
            change_rate: 10.0,
            turnover_rate: 5.0,
            amount: 1e8,
            seal_amount: 1e7,
            limit_type: "换手板".into(),
            float_cap: 1e9,
            sectors: vec!["测试板块".into()],
            primary_sector: Some("测试板块".into()),
            ..Default::default()
        }
    }

    fn day(date: &str, stocks: Vec<Stock>) -> DayPayload {
        DayPayload {
            date: date.into(),
            fetched_at: 1_700_000_000,
            stocks,
            sectors: vec![Sector {
                name: "测试板块".into(),
                limit_up_num: 3,
                continuous_num: 1,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    fn history() -> HistoryStatus {
        HistoryStatus {
            first_date: "20240102".into(),
            last_date: "20240102".into(),
            days: 1,
            expected_days: 1,
            syncing: false,
            updated_at: 0,
        }
    }

    /// 40 day bars: 2023-12-01 … 2024-01-09, rising 10.0 → 13.4 through
    /// 2024-01-04 and a 100.0 spike afterwards. The spike is the look-ahead
    /// probe: screening 2024-01-04 must ignore it (20.0% vs 769.57%).
    fn kline_bars() -> Vec<KlineCandle> {
        let start = chrono::NaiveDate::from_ymd_opt(2023, 12, 1).expect("valid date");
        (0..40i64)
            .map(|i| {
                let date = (start + chrono::Duration::days(i)).format("%Y-%m-%d").to_string();
                let close = if i <= 34 { 10.0 + i as f64 * 0.1 } else { 100.0 };
                KlineCandle {
                    date,
                    open: close,
                    high: close,
                    low: close,
                    close,
                    volume: 1e6,
                    amount: 1e7 + i as f64 * 1e6,
                    pct: 0.5,
                    turnover: 1.0,
                }
            })
            .collect()
    }

    fn seed_db(path: &Path) {
        db::init(path).expect("init temp db");
        let mut conn = db::connect(path).expect("connect temp db");
        // Real trade calendar for the probe dates: `require_kline_date` then
        // demands the as-of day's own bar instead of leaning on history.
        db::save_calendar(
            &mut conn,
            "20240105",
            &[
                "20240102".into(),
                "20240103".into(),
                "20240104".into(),
                "20240105".into(),
            ],
            true,
        )
        .expect("seed calendar");
        // The only history row sits on 20240102 and carries another code, so
        // 600001 keeps a positive history coverage but no streak.
        db::save_limit_history(
            &mut conn,
            "20240102",
            &[db::LimitHistoryRow {
                code: "000002".into(),
                ..Default::default()
            }],
        )
        .expect("seed prev day history");
        // Local day series, reaching past both screening dates: coverage passes,
        // so the look-ahead filter is what decides the aggregates.
        db::save_klines(&mut conn, "600001", "day", "测试股份", &kline_bars()).expect("seed klines");
    }

    #[test]
    #[ignore = "offline cache check: run with --lib -- --ignored screen_cache --nocapture"]
    fn screen_cache_roundtrip() {
        let tmp = TempDir::new();
        let path = tmp.0.join("tianti.db");
        seed_db(&path);
        let client = Client::new();
        let prof = profile();
        let hist = history();

        // P1-A: a past-date replay must not see later bars. Same series, two
        // as-of dates: 2024-01-04 excludes the 2024-01-05…09 spike.
        let bars = kline_bars();
        let (gain20_at, gain250_at, prev_amount) =
            kline_metrics(&bars, "20240104").expect("metrics at as_of");
        let (gain20_all, gain250_all, _) =
            kline_metrics(&bars, "20240109").expect("metrics to series end");
        eprintln!(
            "[look-ahead] as_of=20240104 gain20={gain20_at:.2}% gain250={gain250_at:.2}% \
             prev_amount={prev_amount:.0} | same series read to 20240109 \
             gain20={gain20_all:.2}% gain250={gain250_all:.2}%"
        );
        assert!((gain20_at - 20.0).abs() < 0.001, "filtered gain20 should be 20.0%, got {gain20_at}");
        assert!((gain250_at - 34.0).abs() < 0.001, "filtered gain250 should be 34.0%, got {gain250_at}");
        assert!((prev_amount - 4.3e7).abs() < 1.0, "prev amount is the 2024-01-03 bar");
        assert!(gain20_all > 700.0, "unfiltered look-ahead would be ~769.57%, got {gain20_all}");
        assert!((gain250_all - 900.0).abs() < 0.001, "unfiltered gain250 would be 900%, got {gain250_all}");

        // P1-B: coverage = the series reaches the last known trade day.
        assert!(kline_covers(&bars, "2024-01-04"), "series reaches the as-of day");
        assert!(!kline_covers(&bars, "2024-01-10"), "series stops before 2024-01-10");
        assert!(kline_covers(&bars, ""), "empty requirement counts as covered");

        // 1) first run: no cache anywhere, computes and fills both caches.
        let first = block_on(screen(&client, &path, "20240104", &day("20240104", vec![stock()]), &prof, hist.clone(), false));
        eprintln!(
            "[cache] #1 date=20240104 refresh=false  cached={} computed_at={}",
            first.cached, first.computed_at
        );
        assert!(!first.cached, "first run must compute");
        assert!(first.computed_at > 0, "first run must stamp computed_at");
        assert_eq!(first.hard_passed, 1, "fixture should reach the F4 stage");
        let day_row = {
            let conn = db::connect(&path).expect("connect");
            db::load_stock_stats_day(&conn, "600001", "20240104").expect("load day row")
        };
        let day_row = day_row.expect("stock_stats_day row must exist after the first run");
        assert!(day_row.computed_at > 0);
        assert!(
            (day_row.max_gain_20d - 20.0).abs() < 0.001,
            "pinned gain20 must be the filtered 20.0%, got {}",
            day_row.max_gain_20d
        );
        assert!(
            (day_row.max_gain_250d - 34.0).abs() < 0.001,
            "pinned gain250 must be the filtered 34.0%, got {}",
            day_row.max_gain_250d
        );
        let legacy = {
            let conn = db::connect(&path).expect("connect");
            db::load_stock_stats(&conn, "600001").expect("load legacy row")
        };
        assert!(legacy.map(|r| r.computed_at > 0).unwrap_or(false), "legacy stock_stats write kept");

        // 2) same date + profile + history + day snapshot → cache hit, same stamp.
        std::thread::sleep(std::time::Duration::from_millis(1_100));
        let second = block_on(screen(&client, &path, "20240104", &day("20240104", vec![stock()]), &prof, hist.clone(), false));
        eprintln!(
            "[cache] #2 date=20240104 refresh=false  cached={} computed_at={}",
            second.cached, second.computed_at
        );
        assert!(second.cached, "second run must hit the in-process cache");
        assert_eq!(second.computed_at, first.computed_at, "cached stamp must not move");

        // 3) another date → different key → recompute.
        let other = block_on(screen(&client, &path, "20240105", &day("20240105", vec![stock()]), &prof, hist.clone(), false));
        eprintln!(
            "[cache] #3 date=20240105 refresh=false  cached={} computed_at={}",
            other.cached, other.computed_at
        );
        assert!(!other.cached, "another date must recompute");

        // 4) A→B→A: going back to the first date still hits the cache.
        let back = block_on(screen(&client, &path, "20240104", &day("20240104", vec![stock()]), &prof, hist.clone(), false));
        eprintln!(
            "[cache] #4 date=20240104 refresh=false  cached={} computed_at={} (back to A)",
            back.cached, back.computed_at
        );
        assert!(back.cached, "A→B→A must reuse the first date's result");
        assert_eq!(back.computed_at, first.computed_at);

        // 5) refresh=true bypasses both levels and overwrites. The empty stock
        // list keeps this branch offline (no F4/kline work) while the cache key
        // — date|profile|history|fetched_at — stays the same.
        std::thread::sleep(std::time::Duration::from_millis(1_100));
        let thin = day("20240104", Vec::new());
        let forced = block_on(screen(&client, &path, "20240104", &thin, &prof, hist.clone(), true));
        eprintln!(
            "[cache] #5 date=20240104 refresh=true   cached={} computed_at={}",
            forced.cached, forced.computed_at
        );
        assert!(!forced.cached, "refresh=true must recompute");
        assert!(forced.computed_at > first.computed_at, "refresh must stamp a newer time");
        let after = block_on(screen(&client, &path, "20240104", &thin, &prof, hist.clone(), false));
        eprintln!(
            "[cache] #6 date=20240104 refresh=false  cached={} computed_at={} (after refresh)",
            after.cached, after.computed_at
        );
        assert!(after.cached, "refreshed result must replace the cached entry");
        assert_eq!(after.computed_at, forced.computed_at);
        assert!(after.stocks.is_empty(), "refresh overwrote the cached payload");

        let day_rows: i64 = {
            let conn = db::connect(&path).expect("connect");
            conn.query_row("SELECT COUNT(*) FROM stock_stats_day", [], |r| r.get(0))
                .expect("count day rows")
        };
        eprintln!("[cache] stock_stats_day rows={day_rows} (one per computed date; hits add none)");
        assert_eq!(day_rows, 2, "20240104 and 20240105 each pinned once, cache hits add no rows");

        // 7) `date >= today` still computes (from the local series) but must
        // never pin: a half-formed intraday result would otherwise read as a
        // historical final when the same date is reviewed tomorrow.
        let today = db::today_ymd();
        let today_result = block_on(screen(
            &client,
            &path,
            &today,
            &day(&today, vec![stock()]),
            &prof,
            hist.clone(),
            false,
        ));
        eprintln!(
            "[cache] #7 date={today} today   cached={} hard_passed={}",
            today_result.cached, today_result.hard_passed
        );
        assert!(!today_result.cached, "today is a new screen key");
        assert_eq!(today_result.hard_passed, 1, "today still computes F4 from the local series");
        let day_rows_today: i64 = {
            let conn = db::connect(&path).expect("connect");
            conn.query_row("SELECT COUNT(*) FROM stock_stats_day", [], |r| r.get(0))
                .expect("count day rows")
        };
        eprintln!("[cache] stock_stats_day rows after today={day_rows_today} (today never pins)");
        assert_eq!(day_rows_today, 2, "date >= today must not add a stock_stats_day row");

        // 8) the per-day cache must serve a *different* screen cache key without
        // any kline work: drop the local candles, change the profile, and the
        // past date still screens from `stock_stats_day` alone (offline proof).
        {
            let conn = db::connect(&path).expect("connect");
            conn.execute("DELETE FROM klines", []).expect("drop klines");
        }
        let mut prof2 = profile();
        prof2.top_n = 3;
        let from_day_cache = block_on(screen(&client, &path, "20240104", &day("20240104", vec![stock()]), &prof2, hist.clone(), false));
        eprintln!(
            "[cache] #8 date=20240104 profile2     cached={} computed_at={} hard_passed={}",
            from_day_cache.cached, from_day_cache.computed_at, from_day_cache.hard_passed
        );
        assert!(!from_day_cache.cached, "profile change is a different screen key");
        assert_eq!(from_day_cache.hard_passed, 1, "stock_stats_day must serve the aggregates without klines");
        let day_rows_after: i64 = {
            let conn = db::connect(&path).expect("connect");
            conn.query_row("SELECT COUNT(*) FROM stock_stats_day", [], |r| r.get(0))
                .expect("count day rows")
        };
        assert_eq!(day_rows_after, 2, "a day-cache hit writes no new row");

        // 9) `stats_day_v` bump: a v1-marked DB drops its (old-semantics) pins
        // the next time `db::init` runs.
        {
            let conn = db::connect(&path).expect("connect");
            conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES ('stats_day_v','1')", [])
                .expect("downgrade marker");
            conn.execute(
                r#"INSERT OR REPLACE INTO stock_stats_day
                   (code, as_of, max_gain_20d, max_gain_250d, prev_day_amount, computed_at)
                   VALUES ('600001','20240109',1,1,1,1)"#,
                [],
            )
            .expect("insert v1-era pin");
        }
        db::init(&path).expect("re-init migrates");
        let (stats_day_version, rows_after_migrate): (String, i64) = {
            let conn = db::connect(&path).expect("connect");
            (
                conn.query_row("SELECT value FROM settings WHERE key='stats_day_v'", [], |r| {
                    r.get(0)
                })
                .expect("read stats_day_v"),
                conn.query_row("SELECT COUNT(*) FROM stock_stats_day", [], |r| r.get(0))
                    .expect("count day rows"),
            )
        };
        eprintln!(
            "[cache] #9 stats_day_v={stats_day_version} rows={rows_after_migrate} (v1-era pins cleared)"
        );
        assert_eq!(stats_day_version, "2", "migrate must stamp stats_day_v=2");
        assert_eq!(rows_after_migrate, 0, "v1-era stock_stats_day rows must be cleared");
    }
}
