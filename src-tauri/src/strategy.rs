//! 首板 → 二板 rule engine.
//!
//! Read-only by design: screening never writes the day snapshot. The only
//! persistence is the `stock_stats` cache (per-code history aggregates plus the
//! 20-day gain), which the auction tab reuses for `amount_ratio`.
//!
//! Rule keys (stable, the excluded list reports them verbatim):
//! `u1`, `first_board`, `f1`..`f5` are hard filters; `s1_one_word`,
//! `s1_seal_minute`, `s1_turnover`, `s2`, `s3` are the 封板质量 rules.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use anyhow::Result;
use reqwest::Client;

use crate::db;
use crate::models::*;
use crate::source;

/// Hard lookback for `max_streak_250d`; also caps the trade-day slice we load.
const HISTORY_WINDOW: usize = 250;
/// Contract: the excluded list is capped.
const EXCLUDED_LIMIT: usize = 40;

/* ————————————————— context ————————————————— */

#[derive(Default)]
struct Ctx {
    /// Trade days ≤ `date`, ascending; always ends with `date`.
    days: Vec<String>,
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
    Ok(Ctx {
        days,
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
/// (cheap SQL); the kline fields reuse the cache unless `refresh` was asked for.
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

    let cached = db::connect(db_path)
        .ok()
        .and_then(|conn| db::load_stock_stats(&conn, &stk.code).ok().flatten());
    let fresh = cached
        .as_ref()
        .map(|c| c.as_of == date && c.computed_at > 0)
        .unwrap_or(false);
    if !refresh && fresh {
        let c = cached.unwrap_or_default();
        row.max_gain_20d = c.max_gain_20d;
        row.max_gain_250d = c.max_gain_250d;
        row.prev_day_amount = c.prev_day_amount;
        row.computed_at = c.computed_at;
    } else {
        let got = kline_stats(client, db_path, &stk.code, date, refresh).await;
        match got {
            Some((gain20, gain250, prev_amount)) => {
                row.max_gain_20d = gain20;
                row.max_gain_250d = gain250;
                row.prev_day_amount = prev_amount;
            }
            None => {
                row.computed_at = 0;
                return (row, false);
            }
        }
    }
    row.computed_at = if row.computed_at > 0 { row.computed_at } else { db::now_ts() };
    if let Ok(conn) = db::connect(db_path) {
        if let Err(e) = db::save_stock_stats(&conn, &row) {
            eprintln!("save stock stats failed: {e:#}");
        }
    }
    (row, true)
}

/// `(max_gain_20d, max_gain_250d, prev_day_amount)` from the daily candles.
fn kline_metrics(candles: &[KlineCandle], date: &str) -> Option<(f64, f64, f64)> {
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
    let today = dash(date);
    let prev_amount = candles
        .iter()
        .filter(|c| c.date.as_str() < today.as_str())
        .next_back()
        .map(|c| c.amount)
        .unwrap_or(0.0);
    Some((gain20, gain250, prev_amount))
}

async fn kline_stats(
    client: &Client,
    db_path: &Path,
    code: &str,
    date: &str,
    refresh: bool,
) -> Option<(f64, f64, f64)> {
    let mut candles: Vec<KlineCandle> = Vec::new();
    if !refresh {
        if let Ok(conn) = db::connect(db_path) {
            if let Ok((rows, _, _)) = db::load_klines(&conn, code, "day") {
                candles = rows;
            }
        }
    }
    if candles.is_empty() {
        match source::fetch_kline(client, code, "day", false).await {
            Ok((name, rows)) if !rows.is_empty() => {
                if let Ok(mut conn) = db::connect(db_path) {
                    if let Err(e) = db::save_klines(&mut conn, code, "day", &name, &rows) {
                        eprintln!("save strategy kline failed: {e:#}");
                    }
                }
                candles = rows;
            }
            _ => return None,
        }
    }
    candles.sort_by(|a, b| a.date.cmp(&b.date));
    kline_metrics(&candles, date)
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
    let mut warnings: Vec<String> = Vec::new();
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
        if first_board.passed == Some(true) {
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
        if !failed.is_empty() {
            excluded.push(ExcludedStock {
                code: stk.code.clone(),
                name: stk.name.clone(),
                failed,
            });
            continue;
        }
        if checks.iter().any(|c| c.passed.is_none()) {
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
            excluded.push(ExcludedStock {
                code: stk.code.clone(),
                name: stk.name.clone(),
                failed: vec![f4.key.clone()],
            });
            continue;
        }
        if f4.passed.is_none() {
            pending += 1;
            continue;
        }
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
        if !failed.is_empty() {
            dropped_by_quality += 1;
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

    ScreenResult {
        date: date.to_string(),
        universe: first_board_count,
        hard_passed,
        candidates,
        excluded,
        warnings,
        history,
        has_amount: day.stocks.iter().any(|s| s.amount > 0.0),
    }
}
