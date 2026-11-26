use std::collections::HashMap;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use chrono::{FixedOffset, Local, TimeZone, Timelike};
use encoding_rs::GBK;
use reqwest::Client;
use serde_json::Value;

use crate::db;
use crate::models::*;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const THS_REFERER: &str = "https://data.10jqka.com.cn/";
const EM_REFERER: &str = "https://quote.eastmoney.com/";
const TX_REFERER: &str = "https://gu.qq.com/";
const SINA_REFERER: &str = "https://finance.sina.com.cn/";

pub fn client() -> Result<Client> {
    Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(6))
        .gzip(true)
        .build()
        .context("build http client")
}

async fn get_bytes(client: &Client, url: &str, referer: &str) -> Result<Vec<u8>> {
    let res = client
        .get(url)
        .header(reqwest::header::REFERER, referer)
        .header(reqwest::header::ACCEPT, "*/*")
        .send()
        .await
        .with_context(|| format!("request {url}"))?;
    let status = res.status();
    let bytes = res.bytes().await.context("read response")?;
    if !status.is_success() {
        return Err(anyhow!("HTTP {} · {}", status.as_u16(), url));
    }
    Ok(bytes.to_vec())
}

fn gbk_text(bytes: &[u8]) -> String {
    let (text, _, _) = GBK.decode(bytes);
    text.into_owned()
}

fn tencent_symbol(secid: &str) -> String {
    let code = secid.split('.').nth(1).unwrap_or(secid);
    if secid.starts_with('1') {
        format!("sh{code}")
    } else {
        format!("sz{code}")
    }
}

fn stock_symbol(code: &str) -> String {
    // 6/9 = 沪市 A 股 / B 股，5 = 沪市场内基金（510-518 / 560-563 / 588 / 500 / 501…）。
    if code.starts_with('6') || code.starts_with('9') || code.starts_with('5') {
        format!("sh{code}")
    } else {
        format!("sz{code}")
    }
}

fn secid_from_symbol(symbol: &str) -> String {
    if let Some(code) = symbol.strip_prefix("sh") {
        format!("1.{code}")
    } else if let Some(code) = symbol.strip_prefix("sz") {
        format!("0.{code}")
    } else {
        symbol.to_string()
    }
}

fn tx_time(raw: &str) -> String {
    if raw.len() != 14 || !raw.chars().all(|c| c.is_ascii_digit()) {
        return Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    }
    let parse = |a: usize, b: usize| raw[a..b].parse::<i32>().unwrap_or(0);
    let (year, month, day) = (parse(0, 4), parse(4, 6), parse(6, 8));
    let (hour, minute, second) = (parse(8, 10), parse(10, 12), parse(12, 14));
    Local
        .with_ymd_and_hms(year, month as u32, day as u32, hour as u32, minute as u32, second as u32)
        .single()
        .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d %H:%M:%S").to_string())
}

async fn get_json(client: &Client, url: &str, referer: &str) -> Result<Value> {
    let res = client
        .get(url)
        .header(reqwest::header::REFERER, referer)
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .send()
        .await
        .with_context(|| format!("request {url}"))?;
    let status = res.status();
    let bytes = res.bytes().await.context("read response")?;
    if !status.is_success() {
        return Err(anyhow!("HTTP {} · {}", status.as_u16(), url));
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    serde_json::from_slice(body).with_context(|| format!("parse json · {}", &url[..url.len().min(90)]))
}

fn num(v: &Value) -> f64 {
    if let Some(n) = v.as_f64() {
        if n.is_finite() {
            return n;
        }
    }
    if let Some(s) = v.as_str() {
        if let Ok(n) = s.parse::<f64>() {
            if n.is_finite() {
                return n;
            }
        }
    }
    0.0
}

fn int(v: &Value) -> i64 {
    if let Some(n) = v.as_i64() {
        return n;
    }
    if let Some(n) = v.as_f64() {
        return n as i64;
    }
    if let Some(s) = v.as_str() {
        if let Ok(n) = s.parse::<i64>() {
            return n;
        }
        if let Ok(n) = s.parse::<f64>() {
            return n as i64;
        }
    }
    0
}

fn string(v: &Value) -> String {
    v.as_str().map(|s| s.trim().to_string()).unwrap_or_default()
}

fn is_date(s: &str) -> bool {
    s.len() == 8 && s.chars().all(|c| c.is_ascii_digit())
}

/// `time_preview` is a three-minute intraday percent series. Today's feed grows
/// during the session, but mirrors can also answer with a complete 80-point
/// series (or with the previous day's series right after the open). Trimming to
/// the number of samples that can possibly exist at `fetched_at` keeps the
/// ladder sparkline honest: it can never "finish" the day at 15:00 while the
/// market is still trading.
fn expected_spark_points(date: &str, fetched_at: i64) -> usize {
    if date != db::today_ymd() {
        return 80;
    }
    // The market clock is fixed at UTC+8 regardless of the machine timezone,
    // matching `db::today_ymd`; using `Local` here would zero today's series on
    // a non-China machine and persist that empty payload.
    let Some(tz) = FixedOffset::east_opt(8 * 3600) else {
        return 80;
    };
    let Some(now) = tz.timestamp_opt(fetched_at, 0).single() else {
        return 80;
    };
    let clock = now.hour() as i64 * 60 + now.minute() as i64;
    if clock < 9 * 60 + 30 {
        return 0;
    }
    let elapsed = if clock <= 11 * 60 + 30 {
        clock - (9 * 60 + 30)
    } else if clock < 13 * 60 {
        120
    } else if clock <= 15 * 60 {
        120 + (clock - 13 * 60)
    } else {
        240
    };
    ((elapsed / 3) + 1).clamp(0, 80) as usize
}

fn trim_spark(spark: &mut Vec<f64>, limit: usize) {
    if spark.len() > limit {
        spark.truncate(limit);
    }
}

fn session_minute_of(date: &str) -> i64 {
    let hour = date.get(11..13).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let minute = date.get(14..16).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let clock = hour * 60 + minute;
    if clock <= 11 * 60 + 30 {
        (clock - (9 * 60 + 30)).clamp(0, 120)
    } else if clock >= 13 * 60 {
        (120 + clock - 13 * 60).clamp(120, 240)
    } else {
        120
    }
}

/// Rebuild a three-minute percent series from real one-minute candles. Used for
/// the single highest-board card, where a stale `time_preview` would be most
/// visible ("今天的 4 板还在走昨天的分时").
fn spark_from_minute_candles(candles: &[KlineCandle], base: f64, limit: usize) -> Vec<f64> {
    if base <= 0.0 || limit < 2 {
        return Vec::new();
    }
    let points: Vec<(i64, f64)> = candles
        .iter()
        .filter(|candle| candle.close > 0.0)
        .map(|candle| (session_minute_of(&candle.date), candle.close))
        .collect();
    let Some(&(last_minute, _)) = points.last() else {
        return Vec::new();
    };
    let step = last_minute as f64 / (limit - 1) as f64;
    let mut out = Vec::with_capacity(limit);
    let mut cursor = 0usize;
    for index in 0..limit {
        let target = (index as f64 * step).round() as i64;
        while cursor + 1 < points.len() && points[cursor + 1].0 <= target {
            cursor += 1;
        }
        out.push((points[cursor].1 / base - 1.0) * 100.0);
    }
    out
}

/// The highest board is the visual focal point of the ladder. If it is unique
/// and the day is today, rebuild its sparkline from the raw minute feed so it
/// can never lag behind or show the previous session.
async fn refresh_hero_spark(client: &Client, stocks: &mut [Stock], spark_limit: usize) {
    let max_streak = stocks.iter().map(|s| s.streak).max().unwrap_or(0);
    if max_streak < 2 {
        return;
    }
    let tops: Vec<usize> = stocks
        .iter()
        .enumerate()
        .filter(|(_, s)| s.streak == max_streak)
        .map(|(i, _)| i)
        .collect();
    if tops.len() != 1 {
        return;
    }
    let index = tops[0];
    let stock = &stocks[index];
    let code = stock.code.clone();
    let base = if stock.price > 0.0 && stock.change_rate.abs() > 0.5 {
        stock.price / (1.0 + stock.change_rate / 100.0)
    } else {
        0.0
    };
    if base <= 0.0 {
        return;
    }
    let Ok((_, minutes)) = fetch_tencent_minute_kline(client, &stock_symbol(&code)).await else {
        return;
    };
    let today = db::today_ymd();
    let prefix = format!("{}-{}-{}", &today[0..4], &today[4..6], &today[6..8]);
    if !minutes.first().map(|c| c.date.starts_with(&prefix)).unwrap_or(false) {
        return;
    }
    let series = spark_from_minute_candles(&minutes, base, spark_limit);
    if series.len() > 3 {
        stocks[index].spark = series;
    }
}

pub async fn fetch_calendar(client: &Client, today: &str) -> Result<(bool, Vec<String>)> {
    let url = format!(
        "https://data.10jqka.com.cn/dataapi/limit_up/trade_day?stock=stock&prev=250&next=30&date={today}"
    );
    let json = get_json(client, &url, THS_REFERER).await?;
    if int(&json["status_code"]) != 0 {
        return Err(anyhow!("交易日历接口返回异常"));
    }
    let data = &json["data"];
    let is_trade = data["trade_day"].as_bool().unwrap_or(false);
    let mut dates: Vec<String> = Vec::new();
    if let Some(arr) = data["prev_dates"].as_array() {
        dates.extend(arr.iter().filter_map(|v| v.as_str()).filter(|s| is_date(s)).map(str::to_string));
    }
    if let Some(arr) = data["next_dates"].as_array() {
        dates.extend(arr.iter().filter_map(|v| v.as_str()).filter(|s| is_date(s)).map(str::to_string));
    }
    if is_trade {
        dates.push(today.to_string());
    }
    dates.sort();
    dates.dedup();
    dates.retain(|d| is_date(d));
    if dates.is_empty() {
        return Err(anyhow!("交易日历为空"));
    }
    Ok((is_trade, dates))
}

struct BlockInfo {
    sector: Sector,
    streaks: Vec<(String, i64)>,
}

async fn fetch_pool(client: &Client, date: &str, path: &str, order_field: &str) -> Result<Vec<Value>> {
    let fields = "199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004";
    let mut all = Vec::new();
    let mut page = 1;
    loop {
        let url = format!(
            "https://data.10jqka.com.cn/dataapi/limit_up/{path}?page={page}&limit=100&field={fields}&filter=HS,GEM2STAR&date={date}&order_field={order_field}&order_type=0"
        );
        let json = get_json(client, &url, THS_REFERER).await?;
        if int(&json["status_code"]) != 0 {
            return Err(anyhow!("行情池接口返回异常"));
        }
        let info = json["data"]["info"].as_array().cloned().unwrap_or_default();
        let total = int(&json["data"]["page"]["total"]);
        if info.is_empty() {
            break;
        }
        all.extend(info);
        if all.len() as i64 >= total || page >= 4 {
            break;
        }
        page += 1;
    }
    Ok(all)
}

async fn fetch_blocks(client: &Client, date: &str) -> Result<Vec<BlockInfo>> {
    let url = format!(
        "https://data.10jqka.com.cn/dataapi/limit_up/block_top?filter=HS,GEM2STAR&date={date}"
    );
    let json = get_json(client, &url, THS_REFERER).await?;
    if int(&json["status_code"]) != 0 {
        return Err(anyhow!("板块接口返回异常"));
    }
    let mut out = Vec::new();
    if let Some(arr) = json["data"].as_array() {
        for b in arr {
            let mut stock_codes = Vec::new();
            let mut streaks = Vec::new();
            if let Some(list) = b["stock_list"].as_array() {
                for st in list {
                    let code = string(&st["code"]);
                    if code.is_empty() {
                        continue;
                    }
                    if !stock_codes.contains(&code) {
                        stock_codes.push(code.clone());
                    }
                    let c = int(&st["continue_num"]);
                    if c > 0 {
                        streaks.push((code, c));
                    }
                }
            }
            out.push(BlockInfo {
                sector: Sector {
                    code: string(&b["code"]),
                    name: string(&b["name"]),
                    change: num(&b["change"]),
                    limit_up_num: int(&b["limit_up_num"]),
                    continuous_num: int(&b["continuous_plate_num"]),
                    high_days: string(&b["high"]),
                    days: int(&b["days"]),
                    stock_codes,
                },
                streaks,
            });
        }
    }
    Ok(out)
}

/// `high_days_value` packs `(board << 16) | days`; some mirrors omit it, in
/// which case the `high_days` label is parsed instead.
fn pool_board_days(item: &Value) -> (i64, i64, String) {
    let raw_high = string(&item["high_days"]);
    let hv = int(&item["high_days_value"]);
    let (mut board, mut days) = if hv > 0 {
        (((hv >> 16) & 0xffff) as i64, (hv & 0xffff) as i64)
    } else {
        (0, 0)
    };
    if board <= 0 {
        board = parse_board(&raw_high);
        days = parse_days(&raw_high).unwrap_or(board.max(1));
    }
    board = board.max(1);
    days = days.max(1);
    let high_days = if raw_high.is_empty() { format!("{board}板") } else { raw_high };
    (board, days, high_days)
}

/// Backfill one trade day into `limit_up_history`. Reuses [`fetch_pool`] so the
/// URL, page size and field mask stay in a single place; pagination and the
/// `status_code` check come along for free. The history endpoint has no block
/// payload, so `streak` falls back to `board` — real consecutive boards are
/// rebuilt from the date series by the strategy layer.
pub async fn fetch_limit_history_day(client: &Client, date: &str) -> Result<Vec<db::LimitHistoryRow>> {
    if !is_date(date) {
        return Err(anyhow!("日期格式应为 YYYYMMDD"));
    }
    let pool = fetch_pool(client, date, "limit_up_pool", "330324").await?;
    let mut out = Vec::with_capacity(pool.len());
    for item in &pool {
        let code = string(&item["code"]);
        if code.is_empty() {
            continue;
        }
        let (board, days, high_days) = pool_board_days(item);
        out.push(db::LimitHistoryRow {
            code,
            name: string(&item["name"]),
            board,
            days,
            streak: board,
            high_days,
            price: num(&item["latest"]),
            change_rate: num(&item["change_rate"]),
            turnover_rate: num(&item["turnover_rate"]),
            seal_amount: num(&item["order_amount"]),
            amount_est: num(&item["amount"]),
            first_seal: int(&item["first_limit_up_time"]),
            open_num: int(&item["open_num"]),
            limit_type: string(&item["limit_up_type"]),
            float_cap: num(&item["currency_value"]),
            market: string(&item["market_type"]),
            is_new: int(&item["is_new"]) != 0,
        });
    }
    Ok(out)
}

/// Batch-quote today's limit-up codes and write the real traded amount back
/// into `Stock.amount`. The pool feed lags intraday and often reports 0, and
/// `seal_amount / amount` (封单比) is meaningless without it. Turnover is only
/// taken from the quote when the pool feed supplied none. Batched at 60 codes
/// per request, which both Tencent and Sina accept in one URL.
async fn backfill_amounts(client: &Client, stocks: &mut [Stock]) -> usize {
    let mut codes: Vec<String> = stocks.iter().map(|s| s.code.clone()).filter(|c| !c.is_empty()).collect();
    codes.sort();
    codes.dedup();
    if codes.is_empty() {
        return 0;
    }
    let mut filled = 0usize;
    for chunk in codes.chunks(60) {
        let Ok(quotes) = fetch_stock_quotes(client, chunk).await else {
            continue;
        };
        for quote in quotes {
            if let Some(stk) = stocks.iter_mut().find(|s| s.code == quote.code) {
                if quote.amount > 0.0 {
                    stk.amount = quote.amount;
                    filled += 1;
                }
                if stk.turnover_rate <= 0.0 && quote.turnover > 0.0 {
                    stk.turnover_rate = quote.turnover;
                }
            }
        }
    }
    filled
}

pub async fn fetch_day(client: &Client, date: &str) -> Result<(DayPayload, Option<String>)> {
    if !is_date(date) {
        return Err(anyhow!("日期格式应为 YYYYMMDD"));
    }
    let fetched_at = db::now_ts();
    let spark_limit = expected_spark_points(date, fetched_at);
    let pool = fetch_pool(client, date, "limit_up_pool", "330324").await?;
    let mut warnings: Vec<String> = Vec::new();
    if date == db::today_ymd() && spark_limit == 0 {
        warnings.push("盘前数据可能仍为上一交易日，开盘后自动刷新".into());
    }
    let open_pool = match fetch_pool(client, date, "open_limit_pool", "199112").await {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("炸板池暂不可用 · {e}"));
            Vec::new()
        }
    };
    let down_pool = match fetch_pool(client, date, "lower_limit_pool", "199112").await {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("跌停池暂不可用 · {e}"));
            Vec::new()
        }
    };
    let (blocks, block_warning) = match fetch_blocks(client, date).await {
        Ok(b) => (b, None),
        Err(e) => (Vec::new(), Some(format!("板块数据暂不可用 · {e}"))),
    };
    if let Some(w) = block_warning {
        warnings.push(w);
    }

    let mut streak_map: HashMap<String, i64> = HashMap::new();
    let mut sector_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut sectors: Vec<Sector> = Vec::new();
    for b in blocks {
        for (code, c) in &b.streaks {
            let e = streak_map.entry(code.clone()).or_insert(0);
            if *c > *e {
                *e = *c;
            }
        }
        for code in &b.sector.stock_codes {
            let list = sector_map.entry(code.clone()).or_default();
            if !list.contains(&b.sector.name) {
                list.push(b.sector.name.clone());
            }
        }
        sectors.push(b.sector);
    }
    sectors.sort_by(|a, b| {
        b.limit_up_num
            .cmp(&a.limit_up_num)
            .then(b.continuous_num.cmp(&a.continuous_num))
    });

    let mut stocks: Vec<Stock> = Vec::new();
    for item in pool {
        let code = string(&item["code"]);
        if code.is_empty() {
            continue;
        }
        let (board, days, high_days) = pool_board_days(&item);
        let mut streak = streak_map.get(&code).copied().unwrap_or(board);
        if streak <= 0 {
            streak = board;
        }
        streak = streak.clamp(1, board.max(1));
        let reason = string(&item["reason_type"]);
        let spark = item["time_preview"]
            .as_array()
            .map(|a| a.iter().map(num).collect::<Vec<f64>>())
            .unwrap_or_default();
        let market = string(&item["market_type"]);
        let st = Stock {
            code: code.clone(),
            name: string(&item["name"]),
            board,
            days,
            streak,
            high_days,
            price: num(&item["latest"]),
            change_rate: num(&item["change_rate"]),
            turnover_rate: num(&item["turnover_rate"]),
            amount: num(&item["amount"]),
            seal_amount: num(&item["order_amount"]),
            first_seal: int(&item["first_limit_up_time"]),
            last_seal: int(&item["last_limit_up_time"]),
            open_num: int(&item["open_num"]),
            limit_type: string(&item["limit_up_type"]),
            reason_tags: db::split_reason(&reason),
            reason,
            market: market.clone(),
            market_id: int(&item["market_id"]),
            success_rate: num(&item["limit_up_suc_rate"]) * 100.0,
            float_cap: num(&item["currency_value"]),
            is_new: int(&item["is_new"]) != 0,
            is_again_limit: int(&item["is_again_limit"]) != 0,
            spark,
            sectors: Vec::new(),
            primary_sector: None,
        };
        stocks.push(st);
    }

    for st in &mut stocks {
        trim_spark(&mut st.spark, spark_limit);
        if let Some(list) = sector_map.get(&st.code) {
            st.primary_sector = list.first().cloned();
            st.sectors = list.clone();
        }
    }
    stocks.sort_by(|a, b| {
        b.streak
            .cmp(&a.streak)
            .then(b.board.cmp(&a.board))
            .then(b.seal_amount.partial_cmp(&a.seal_amount).unwrap_or(std::cmp::Ordering::Equal))
            .then(a.first_seal.cmp(&b.first_seal))
    });

    if date == db::today_ymd() && spark_limit > 0 {
        refresh_hero_spark(client, &mut stocks, spark_limit).await;
    }

    // Real traded amount for today only: the pool feed reports 0 for most
    // intraday rows, and the 封单比 rule needs a denominator. Historic days
    // keep whatever the pool feed returned.
    if date == db::today_ymd() {
        let filled = backfill_amounts(client, &mut stocks).await;
        if filled == 0 && !stocks.is_empty() {
            warnings.push("成交额补齐未命中，封单比可能无法计算".into());
        }
    }

    let mut open_limit: Vec<Stock> = open_pool.iter().filter_map(|v| aux_stock(v)).collect();
    for stock in &mut open_limit {
        trim_spark(&mut stock.spark, spark_limit);
    }
    open_limit.sort_by(|a, b| {
        b.change_rate
            .partial_cmp(&a.change_rate)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.last_seal.cmp(&b.last_seal))
    });
    let mut limit_down: Vec<Stock> = down_pool.iter().filter_map(|v| aux_stock(v)).collect();
    for stock in &mut limit_down {
        trim_spark(&mut stock.spark, spark_limit);
    }
    limit_down.sort_by(|a, b| {
        a.change_rate
            .partial_cmp(&b.change_rate)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.code.cmp(&b.code))
    });

    let total = stocks.len() as i64;
    let consecutive = stocks.iter().filter(|s| s.streak >= 2).count() as i64;
    let first_board = stocks.iter().filter(|s| s.streak <= 1).count() as i64;
    let max_streak = stocks.iter().map(|s| s.streak).max().unwrap_or(0);
    let one_word = stocks.iter().filter(|s| s.limit_type.contains("一字")).count() as i64;
    let early_seal = stocks
        .iter()
        .filter(|s| s.first_seal > 0 && (((s.first_seal + 8 * 3600).rem_euclid(86400)) < 10 * 3600))
        .count() as i64;
    let avg_seal = if total > 0 {
        stocks.iter().map(|s| s.seal_amount).sum::<f64>() / total as f64
    } else {
        0.0
    };
    let avg_success = if total > 0 {
        stocks.iter().map(|s| s.success_rate).sum::<f64>() / total as f64
    } else {
        0.0
    };

    let warning = if warnings.is_empty() { None } else { Some(warnings.join("；")) };
    let payload = DayPayload {
        date: date.to_string(),
        weekday: db::weekday_cn(date),
        stats: DayStats {
            total,
            consecutive,
            first_board,
            max_streak,
            one_word,
            early_seal,
            avg_seal,
            avg_success,
            open_limit: open_limit.len() as i64,
            limit_down: limit_down.len() as i64,
        },
        stocks,
        open_limit,
        limit_down,
        sectors,
        fetched_at,
        source: "network".into(),
        warning: warning.clone(),
    };
    Ok((payload, warning))
}

fn aux_stock(item: &Value) -> Option<Stock> {
    let code = string(&item["code"]);
    if code.is_empty() {
        return None;
    }
    let reason = string(&item["reason_type"]);
    let spark = item["time_preview"]
        .as_array()
        .map(|a| a.iter().map(num).collect::<Vec<f64>>())
        .unwrap_or_default();
    Some(Stock {
        code,
        name: string(&item["name"]),
        board: 0,
        days: 0,
        streak: 0,
        high_days: string(&item["high_days"]),
        price: num(&item["latest"]),
        change_rate: num(&item["change_rate"]),
        turnover_rate: num(&item["turnover_rate"]),
        amount: num(&item["amount"]),
        seal_amount: num(&item["order_amount"]),
        first_seal: int(&item["first_limit_up_time"]),
        last_seal: int(&item["last_limit_up_time"]),
        open_num: int(&item["open_num"]),
        limit_type: string(&item["limit_up_type"]),
        reason_tags: db::split_reason(&reason),
        reason,
        market: string(&item["market_type"]),
        market_id: int(&item["market_id"]),
        success_rate: num(&item["limit_up_suc_rate"]) * 100.0,
        float_cap: num(&item["currency_value"]),
        is_new: int(&item["is_new"]) != 0,
        is_again_limit: int(&item["is_again_limit"]) != 0,
        spark,
        sectors: Vec::new(),
        primary_sector: None,
    })
}

fn parse_board(s: &str) -> i64 {
    if s.contains("首板") {
        return 1;
    }
    let chars: Vec<char> = s.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if *c == '板' {
            let mut start = i;
            while start > 0 && chars[start - 1].is_ascii_digit() {
                start -= 1;
            }
            if start < i {
                let n: String = chars[start..i].iter().collect();
                if let Ok(v) = n.parse::<i64>() {
                    return v.max(1);
                }
            }
        }
    }
    1
}

fn parse_days(s: &str) -> Option<i64> {
    if s.contains("首板") {
        return Some(1);
    }
    if let Some(pos) = s.find('天') {
        let digits: String = s[..pos].chars().filter(|c| c.is_ascii_digit()).collect();
        return digits.parse::<i64>().ok();
    }
    None
}

fn secid(code: &str) -> String {
    // 与 `stock_symbol` 同一口径：6/9（沪 A / 沪 B）、5（沪市场内基金）走 "1."。
    let market = if code.starts_with('6') || code.starts_with('9') || code.starts_with('5') {
        "1"
    } else {
        "0"
    };
    format!("{market}.{code}")
}

fn period_klt(period: &str) -> &'static str {
    match period {
        "1m" => "1",
        "15m" => "15",
        "30m" => "30",
        "60m" => "60",
        "week" => "102",
        "month" => "103",
        "year" => "106",
        _ => "101",
    }
}

fn kline_limit(period: &str) -> i64 {
    match period {
        "1m" => 240,
        "15m" | "30m" | "60m" => 800,
        _ => 500,
    }
}

/// 场内基金 / ETF 代码：沪 `5` 开头（510-518、560-563、588、500/501…），
/// 深 `15/16/18` 开头（ETF / LOF / 封闭基金）。
///
/// 这类代码的 K 线不能用腾讯前复权接口（`fqkline/get` 对 ETF 固定返回 HTTP 501），
/// 需要走不复权的 `kline/kline` 接口兜底。
fn is_fund_code(code: &str) -> bool {
    code.starts_with('5')
        || code.starts_with("15")
        || code.starts_with("16")
        || code.starts_with("18")
}

fn parse_kline_json(data: &Value) -> Result<(String, Vec<KlineCandle>)> {
    if data.is_null() {
        return Err(anyhow!("未找到该代码的行情"));
    }
    let name = string(&data["name"]);
    let mut candles = Vec::new();
    if let Some(lines) = data["klines"].as_array() {
        for line in lines {
            let Some(text) = line.as_str() else { continue };
            let parts: Vec<&str> = text.split(',').collect();
            if parts.len() < 9 {
                continue;
            }
            candles.push(KlineCandle {
                date: parts[0].to_string(),
                open: parts[1].parse().unwrap_or(0.0),
                close: parts[2].parse().unwrap_or(0.0),
                high: parts[3].parse().unwrap_or(0.0),
                low: parts[4].parse().unwrap_or(0.0),
                volume: parts[5].parse().unwrap_or(0.0),
                amount: parts[6].parse().unwrap_or(0.0),
                pct: parts[8].parse().unwrap_or(0.0),
                turnover: parts.get(10).and_then(|v| v.parse().ok()).unwrap_or(0.0),
            });
        }
    }
    if candles.is_empty() {
        return Err(anyhow!("该代码暂无K线数据"));
    }
    Ok((name, candles))
}

pub async fn fetch_prev_close_for_stock(client: &Client, code: &str) -> Option<f64> {
    if let Ok(quote) = fetch_stock_quote(client, code).await {
        if quote.prev_close > 0.0 {
            return Some(quote.prev_close);
        }
    }
    fetch_prev_close(client, &secid(code)).await
}

async fn fetch_eastmoney_kline(client: &Client, code: &str, period: &str) -> Result<(String, Vec<KlineCandle>)> {
    let sid = secid(code);
    let klt = period_klt(period);
    let lmt = kline_limit(period);
    let url = format!(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={sid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt={klt}&fqt=1&end=20500101&lmt={lmt}"
    );
    let json = get_json(client, &url, EM_REFERER).await?;
    parse_kline_json(&json["data"])
}

fn parse_tencent_kline(json: &Value, symbol: &str, period: &str) -> Result<(String, Vec<KlineCandle>)> {
    let data = &json["data"][symbol];
    let key = format!("qfq{period}");
    let rows = data[&key]
        .as_array()
        .or_else(|| data[period].as_array())
        .ok_or_else(|| anyhow!("腾讯K线为空"))?;
    let mut out = Vec::new();
    let mut prev = 0.0;
    for row in rows {
        let Some(arr) = row.as_array() else { continue };
        if arr.len() < 6 {
            continue;
        }
        let date = string(&arr[0]);
        let open = num(&arr[1]);
        let close = num(&arr[2]);
        let high = num(&arr[3]);
        let low = num(&arr[4]);
        let volume = num(&arr[5]);
        if date.is_empty() || close <= 0.0 {
            continue;
        }
        let base = if prev > 0.0 { prev } else { open };
        let pct = if base > 0.0 { (close / base - 1.0) * 100.0 } else { 0.0 };
        out.push(KlineCandle {
            date: date.clone(),
            open,
            high,
            low,
            close,
            volume,
            amount: 0.0,
            pct,
            turnover: 0.0,
        });
        prev = close;
    }
    if out.is_empty() {
        Err(anyhow!("腾讯K线为空"))
    } else {
        let name = string(&data["qt"][symbol][1]);
        Ok((name, out))
    }
}

async fn fetch_tencent_kline(client: &Client, code: &str, period: &str) -> Result<(String, Vec<KlineCandle>)> {
    let symbol = stock_symbol(code);
    let tx_period = match period {
        "week" => "week",
        "month" => "month",
        _ => "day",
    };
    let url = format!(
        "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={symbol},{tx_period},,,{},qfq",
        kline_limit(period)
    );
    let json = get_json(client, &url, TX_REFERER).await?;
    parse_tencent_kline(&json, &symbol, tx_period)
}

/// 腾讯**不复权**日/周/月线（`kline/kline` 接口）。
///
/// 用于 ETF / 场内基金：前复权接口 `fqkline/get` 对基金代码固定 HTTP 501，而这条接口
/// 所有品种都返回 200。结构与 `parse_tencent_kline` 兼容
/// （`data.{symbol}.day = [[日期, 开, 收, 高, 低, 量], …]`，先找 `qfq{period}` 再回退
/// `{period}`，正好命中 `day`）。
/// 注意：这是**不复权**数据 —— ETF 分红少，可接受；股票仍走前复权接口。
async fn fetch_tencent_raw_kline(
    client: &Client,
    code: &str,
    period: &str,
) -> Result<(String, Vec<KlineCandle>)> {
    let symbol = stock_symbol(code);
    let tx_period = match period {
        "week" => "week",
        "month" => "month",
        _ => "day",
    };
    let url = format!(
        "https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param={symbol},{tx_period},,,{}",
        kline_limit(period)
    );
    let json = get_json(client, &url, TX_REFERER).await?;
    parse_tencent_kline(&json, &symbol, tx_period)
}

async fn fetch_tencent_minute_kline(client: &Client, symbol: &str) -> Result<(String, Vec<KlineCandle>)> {
    let url = format!("https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={symbol}");
    let json = get_json(client, &url, TX_REFERER).await?;
    let node = &json["data"][symbol]["data"];
    let raw_date = string(&node["date"]);
    let date = if raw_date.len() == 8 {
        format!("{}-{}-{}", &raw_date[0..4], &raw_date[4..6], &raw_date[6..8])
    } else {
        raw_date
    };
    let Some(lines) = node["data"].as_array() else {
        return Err(anyhow!("腾讯分时为空"));
    };
    let mut out = Vec::new();
    let mut prev_volume = 0.0;
    let mut prev_amount = 0.0;
    let mut prev_price = 0.0;
    for line in lines {
        let Some(text) = line.as_str() else { continue };
        let parts: Vec<&str> = text.split_whitespace().collect();
        if parts.len() < 4 {
            continue;
        }
        let Some(hhmm) = parts.first() else { continue };
        let price = parts[1].parse::<f64>().unwrap_or(0.0);
        let volume = parts[2].parse::<f64>().unwrap_or(0.0);
        let amount = parts[3].parse::<f64>().unwrap_or(0.0);
        if price <= 0.0 || hhmm.len() != 4 || date.is_empty() {
            continue;
        }
        let clock = hhmm.parse::<i32>().unwrap_or(0);
        if !((930..=1130).contains(&clock) || (1300..=1500).contains(&clock)) {
            continue;
        }
        let time = format!("{date} {}:{}", &hhmm[0..2], &hhmm[2..4]);
        let base = if prev_price > 0.0 { prev_price } else { price };
        out.push(KlineCandle {
            date: time,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: (volume - prev_volume).max(0.0),
            amount: (amount - prev_amount).max(0.0),
            pct: if base > 0.0 { (price / base - 1.0) * 100.0 } else { 0.0 },
            turnover: 0.0,
        });
        prev_volume = volume;
        prev_amount = amount;
        prev_price = price;
    }
    if out.is_empty() {
        Err(anyhow!("腾讯分时为空"))
    } else {
        Ok((String::new(), out))
    }
}

/// 东财 1 分钟线，按自然日取。可能被接口忽略 beg/end，调用方必须按日期过滤。
pub async fn fetch_em_intraday_day(client: &Client, code: &str, date: &str) -> Result<Vec<KlineCandle>> {
    let beg: String = date.chars().filter(|c| c.is_ascii_digit()).collect();
    if beg.len() != 8 {
        return Err(anyhow!("日期格式应为 YYYY-MM-DD"));
    }
    // Indices are addressed by secid ("1.000001"); stocks by bare code.
    let sid = if code.contains('.') { code.to_string() } else { secid(code) };
    let url = format!(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={sid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=1&fqt=1&beg={beg}&end={beg}&lmt=1000"
    );
    let json = get_json(client, &url, EM_REFERER).await?;
    let (_, candles) = parse_kline_json(&json["data"])?;
    let mut bars: Vec<KlineCandle> = candles
        .into_iter()
        .filter(|c| c.date.starts_with(date))
        .collect();
    bars.sort_by(|a, b| a.date.cmp(&b.date));
    if bars.len() < 30 {
        return Err(anyhow!("东财该日分时为空"));
    }
    Ok(bars)
}

/// 腾讯 day/query：一次返回最近 5 个交易日的分时，返回 (日期, 昨收, bars)。
pub async fn fetch_tencent_intraday_days(
    client: &Client,
    code: &str,
) -> Result<Vec<(String, f64, Vec<KlineCandle>)>> {
    let symbol = if code.contains('.') {
        tencent_symbol(code)
    } else {
        stock_symbol(code)
    };
    let url = format!("https://web.ifzq.gtimg.cn/appstock/app/day/query?code={symbol}");
    let json = get_json(client, &url, TX_REFERER).await?;
    let Some(days) = json["data"][symbol.as_str()]["data"].as_array() else {
        return Err(anyhow!("腾讯分时为空"));
    };
    let mut out: Vec<(String, f64, Vec<KlineCandle>)> = Vec::new();
    for day in days {
        let raw_date = string(&day["date"]);
        if !is_date(&raw_date) {
            continue;
        }
        let date = format!("{}-{}-{}", &raw_date[0..4], &raw_date[4..6], &raw_date[6..8]);
        let prec = num(&day["prec"]);
        let Some(lines) = day["data"].as_array() else { continue };
        let mut bars: Vec<KlineCandle> = Vec::new();
        let mut prev_volume = 0.0;
        let mut prev_amount = 0.0;
        let mut prev_price = 0.0;
        for line in lines {
            let Some(text) = line.as_str() else { continue };
            let parts: Vec<&str> = text.split_whitespace().collect();
            if parts.len() < 4 {
                continue;
            }
            let Some(hhmm) = parts.first() else { continue };
            let price = parts[1].parse::<f64>().unwrap_or(0.0);
            let volume = parts[2].parse::<f64>().unwrap_or(0.0);
            let amount = parts[3].parse::<f64>().unwrap_or(0.0);
            if price <= 0.0 || hhmm.len() != 4 {
                continue;
            }
            let clock = hhmm.parse::<i32>().unwrap_or(0);
            if !((930..=1130).contains(&clock) || (1300..=1500).contains(&clock)) {
                continue;
            }
            let base = if prev_price > 0.0 { prev_price } else { price };
            bars.push(KlineCandle {
                date: format!("{date} {}:{}", &hhmm[0..2], &hhmm[2..4]),
                open: price,
                high: price,
                low: price,
                close: price,
                volume: (volume - prev_volume).max(0.0),
                amount: (amount - prev_amount).max(0.0),
                pct: if base > 0.0 { (price / base - 1.0) * 100.0 } else { 0.0 },
                turnover: 0.0,
            });
            prev_volume = volume;
            prev_amount = amount;
            prev_price = price;
        }
        if bars.len() < 30 {
            continue;
        }
        out.push((date, prec, bars));
    }
    if out.is_empty() {
        Err(anyhow!("腾讯分时为空"))
    } else {
        Ok(out)
    }
}

pub async fn fetch_kline(
    client: &Client,
    code: &str,
    period: &str,
    allow_minute_fallback: bool,
) -> Result<(String, Vec<KlineCandle>, bool)> {
    match fetch_eastmoney_kline(client, code, period).await {
        Ok((name, candles)) => Ok((name, candles, false)),
        Err(primary) => {
            // The third element says "these bars are Tencent's tick line": the
            // caller must not persist it as 1-minute candles.
            let fallback = match period {
                // Tencent's minute endpoint is a tick line, not OHLC. Using it
                // for the K-line view produced open=high=low=close candles and
                // stale flat charts, so 1m only falls back to a real cache. The
                // timeshare view reads nothing but close, and may still use it.
                "1m" if allow_minute_fallback => fetch_tencent_minute_kline(client, &stock_symbol(code))
                    .await
                    .map(|(name, candles)| (name, candles, true)),
                "1m" => Err(anyhow!("1分钟K线没有备用数据源")),
                "day" | "week" | "month" => {
                    // ETF / 场内基金：腾讯前复权接口固定 501，直接用不复权接口兜底，
                    // 不再白试一次。普通股票仍走前复权接口。
                    let raw = if is_fund_code(code) {
                        fetch_tencent_raw_kline(client, code, period).await
                    } else {
                        fetch_tencent_kline(client, code, period).await
                    };
                    raw.map(|(name, candles)| (name, candles, false))
                }
                _ => Err(anyhow!("该周期没有备用K线源")),
            };
            fallback.map_err(|e| anyhow!("{primary:#} · 备用源: {e:#}"))
        }
    }
}

pub async fn fetch_prev_close(client: &Client, sid: &str) -> Option<f64> {
    if let Ok(quote) = fetch_index_quote(client, sid).await {
        if quote.prev_close > 0.0 {
            return Some(quote.prev_close);
        }
    }
    let url = format!(
        "https://push2.eastmoney.com/api/qt/stock/get?fltt=2&secid={sid}&fields=f57,f58,f43,f60"
    );
    let json = get_json(client, &url, EM_REFERER).await.ok()?;
    let value = num(&json["data"]["f60"]);
    if value > 0.0 { Some(value) } else { None }
}

async fn fetch_eastmoney_index_kline(client: &Client, sid: &str, period: &str) -> Result<(String, Vec<KlineCandle>)> {
    let klt = period_klt(period);
    let lmt = kline_limit(period);
    let url = format!(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={sid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt={klt}&fqt=1&end=20500101&lmt={lmt}"
    );
    let json = get_json(client, &url, EM_REFERER).await?;
    parse_kline_json(&json["data"])
}

async fn fetch_tencent_index_kline(client: &Client, sid: &str, period: &str) -> Result<(String, Vec<KlineCandle>)> {
    let symbol = tencent_symbol(sid);
    let tx_period = match period {
        "week" => "week",
        "month" => "month",
        _ => "day",
    };
    let url = format!(
        "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={symbol},{tx_period},,,{},qfq",
        kline_limit(period)
    );
    let json = get_json(client, &url, TX_REFERER).await?;
    parse_tencent_kline(&json, &symbol, tx_period)
}

pub async fn fetch_index_kline(
    client: &Client,
    sid: &str,
    period: &str,
    allow_minute_fallback: bool,
) -> Result<(String, Vec<KlineCandle>, bool)> {
    match fetch_eastmoney_index_kline(client, sid, period).await {
        Ok((name, candles)) => Ok((name, candles, false)),
        Err(primary) => {
            let fallback = match period {
                "1m" if allow_minute_fallback => fetch_tencent_minute_kline(client, &tencent_symbol(sid))
                    .await
                    .map(|(name, candles)| (name, candles, true)),
                "1m" => Err(anyhow!("1分钟K线没有备用数据源")),
                "day" | "week" | "month" => fetch_tencent_index_kline(client, sid, period)
                    .await
                    .map(|(name, candles)| (name, candles, false)),
                _ => Err(anyhow!("该周期没有备用K线源")),
            };
            fallback.map_err(|e| anyhow!("{primary:#} · 备用源: {e:#}"))
        }
    }
}

fn parse_tencent_line(symbol: &str, body: &str) -> Option<StockQuote> {
    let fields: Vec<&str> = body.split('~').collect();
    if fields.len() < 8 {
        return None;
    }
    let price = fields.get(3)?.parse::<f64>().ok()?;
    let prev_close = fields.get(4)?.parse::<f64>().ok().unwrap_or(0.0);
    if price <= 0.0 {
        return None;
    }
    let time = fields
        .iter()
        .position(|field| field.len() == 14 && field.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or(0);
    let pick = |offset: usize| -> f64 {
        fields
            .get(time + offset)
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    let change = pick(1);
    let pct = pick(2);
    let high = pick(3);
    let low = pick(4);
    let amount = fields
        .get(time + 5)
        .and_then(|v| v.split('/').nth(2))
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    // Tencent only: `time + 8` is 换手率. Sina/EastMoney replies carry no
    // turnover, so `StockQuote.turnover` stays 0 for those sources.
    let turnover = pick(8);
    Some(StockQuote {
        code: fields.get(2).unwrap_or(&"").to_string(),
        symbol: symbol.to_string(),
        name: fields.get(1).unwrap_or(&"").trim().to_string(),
        price,
        prev_close,
        open: fields.get(5).unwrap_or(&"0").parse::<f64>().unwrap_or(0.0),
        high,
        low,
        change,
        pct,
        volume: fields.get(6).unwrap_or(&"0").parse::<f64>().unwrap_or(0.0),
        amount,
        turnover,
        as_of: tx_time(fields.get(time).unwrap_or(&"")),
        source: "tencent".into(),
        stale: false,
    })
}

async fn fetch_tencent_quotes(client: &Client, symbols: &[String]) -> Result<Vec<StockQuote>> {
    let url = format!("https://qt.gtimg.cn/q={}", symbols.join(","));
    let bytes = get_bytes(client, &url, TX_REFERER).await?;
    let text = gbk_text(&bytes);
    let mut found: HashMap<String, StockQuote> = HashMap::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let Some(symbol) = key.trim().strip_prefix("v_") else {
            continue;
        };
        let body = value.trim().trim_end_matches(';').trim_matches('"');
        if let Some(quote) = parse_tencent_line(symbol, body) {
            found.insert(quote.symbol.clone(), quote);
        }
    }
    let out: Vec<StockQuote> = symbols.iter().filter_map(|s| found.remove(s)).collect();
    if out.is_empty() {
        Err(anyhow!("腾讯行情没有返回有效数据"))
    } else {
        Ok(out)
    }
}

async fn fetch_sina_quotes(client: &Client, symbols: &[String]) -> Result<Vec<StockQuote>> {
    let url = format!("https://hq.sinajs.cn/list={}", symbols.join(","));
    let bytes = get_bytes(client, &url, SINA_REFERER).await?;
    let text = gbk_text(&bytes);
    let mut found: HashMap<String, StockQuote> = HashMap::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let Some(symbol) = key.trim().strip_prefix("var hq_str_") else {
            continue;
        };
        let body = value.trim().trim_end_matches(';').trim_matches('"');
        let fields: Vec<&str> = body.split(',').collect();
        if fields.len() < 32 {
            continue;
        }
        let price = fields[3].parse::<f64>().unwrap_or(0.0);
        let prev_close = fields[2].parse::<f64>().unwrap_or(0.0);
        if price <= 0.0 {
            continue;
        }
        let change = price - prev_close;
        let pct = if prev_close > 0.0 { change / prev_close * 100.0 } else { 0.0 };
        found.insert(
            symbol.to_string(),
            StockQuote {
                code: symbol.chars().skip(2).collect(),
                symbol: symbol.to_string(),
                name: fields[0].to_string(),
                price,
                prev_close,
                open: fields[1].parse::<f64>().unwrap_or(0.0),
                high: fields[4].parse::<f64>().unwrap_or(0.0),
                low: fields[5].parse::<f64>().unwrap_or(0.0),
                change,
                pct,
                volume: fields[8].parse::<f64>().unwrap_or(0.0),
                amount: fields[9].parse::<f64>().unwrap_or(0.0),
                turnover: 0.0,
                as_of: format!("{} {}", fields[30], fields[31]),
                source: "sina".into(),
                stale: false,
            },
        );
    }
    let out: Vec<StockQuote> = symbols.iter().filter_map(|s| found.remove(s)).collect();
    if out.is_empty() {
        Err(anyhow!("新浪行情没有返回有效数据"))
    } else {
        Ok(out)
    }
}

async fn fetch_eastmoney_quotes(client: &Client, symbols: &[String]) -> Result<Vec<StockQuote>> {
    let secids: Vec<String> = symbols.iter().map(|s| secid_from_symbol(s)).collect();
    let url = format!(
        "https://push2.eastmoney.com/api/qt/ulist.np/get?ut=7eea3edcaed734bea9cbfc24409ed989&fltt=2&secids={}&fields=f2,f3,f4,f12,f14",
        secids.join(",")
    );
    let json = get_json(client, &url, EM_REFERER).await?;
    let mut items = HashMap::new();
    if let Some(arr) = json["data"]["diff"].as_array() {
        for item in arr {
            items.insert(string(&item["f12"]), item.clone());
        }
    }
    let as_of = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let mut out = Vec::new();
    for symbol in symbols {
        let code = symbol.chars().skip(2).collect::<String>();
        let Some(item) = items.get(&code) else { continue };
        let price = num(&item["f2"]);
        let pct = num(&item["f3"]);
        let change = num(&item["f4"]);
        if price <= 0.0 {
            continue;
        }
        out.push(StockQuote {
            code,
            symbol: symbol.clone(),
            name: string(&item["f14"]),
            price,
            prev_close: price - change,
            open: 0.0,
            high: 0.0,
            low: 0.0,
            change,
            pct,
            volume: 0.0,
            amount: 0.0,
            turnover: 0.0,
            as_of: as_of.clone(),
            source: "eastmoney".into(),
            stale: false,
        });
    }
    if out.is_empty() {
        Err(anyhow!("东方财富行情没有返回有效数据"))
    } else {
        Ok(out)
    }
}

async fn fetch_quote_list(client: &Client, symbols: &[String]) -> Result<Vec<StockQuote>> {
    if let Ok(quotes) = fetch_tencent_quotes(client, symbols).await {
        return Ok(quotes);
    }
    if let Ok(quotes) = fetch_sina_quotes(client, symbols).await {
        return Ok(quotes);
    }
    fetch_eastmoney_quotes(client, symbols).await
}

async fn fetch_tencent_spark(client: &Client, symbol: &str) -> Result<Vec<f64>> {
    let url = format!("https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={symbol}");
    let json = get_json(client, &url, TX_REFERER).await?;
    let Some(lines) = json["data"][symbol]["data"]["data"].as_array() else {
        return Err(anyhow!("分钟行情为空"));
    };
    let mut out = Vec::new();
    for line in lines {
        let Some(text) = line.as_str() else { continue };
        let parts: Vec<&str> = text.split_whitespace().collect();
        if let Some(price) = parts.get(1).and_then(|v| v.parse::<f64>().ok()) {
            if price > 0.0 {
                out.push(price);
            }
        }
    }
    if out.is_empty() {
        Err(anyhow!("分钟行情为空"))
    } else {
        Ok(out)
    }
}

async fn fetch_eastmoney_spark(client: &Client, secid: &str) -> Result<Vec<f64>> {
    let url = format!(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=1&fqt=1&end=20500101&lmt=260"
    );
    let json = get_json(client, &url, EM_REFERER).await?;
    let Some(lines) = json["data"]["klines"].as_array() else {
        return Err(anyhow!("东方财富分钟行情为空"));
    };
    let mut raw: Vec<(String, f64)> = Vec::new();
    for line in lines {
        let Some(text) = line.as_str() else { continue };
        let parts: Vec<&str> = text.split(',').collect();
        if parts.len() < 3 {
            continue;
        }
        let close = parts[2].parse::<f64>().unwrap_or(0.0);
        if close > 0.0 {
            raw.push((parts[0].to_string(), close));
        }
    }
    let Some(last_day) = raw.last().map(|r| r.0.chars().take(10).collect::<String>()) else {
        return Err(anyhow!("东方财富分钟行情为空"));
    };
    let out: Vec<f64> = raw
        .iter()
        .filter(|r| r.0.starts_with(&last_day))
        .map(|r| r.1)
        .collect();
    if out.is_empty() {
        Err(anyhow!("东方财富分钟行情为空"))
    } else {
        Ok(out)
    }
}

pub async fn fetch_indices(client: &Client) -> Result<Vec<IndexQuote>> {
    let symbols = ["sh000001".to_string(), "sz399001".to_string(), "sz399006".to_string()];
    let quotes = fetch_quote_list(client, &symbols).await?;
    let mut out = Vec::new();
    for quote in quotes {
        let secid = secid_from_symbol(&quote.symbol);
        let spark = match fetch_tencent_spark(client, &quote.symbol).await {
            Ok(spark) => spark,
            Err(_) => fetch_eastmoney_spark(client, &secid).await.unwrap_or_default(),
        };
        let name = if quote.name.is_empty() {
            match secid.as_str() {
                "1.000001" => "上证指数",
                "0.399001" => "深证成指",
                "0.399006" => "创业板指",
                _ => &quote.name,
            }
            .to_string()
        } else {
            quote.name.clone()
        };
        out.push(IndexQuote {
            code: secid,
            name,
            price: quote.price,
            change: quote.change,
            pct: quote.pct,
            spark,
            source: quote.source,
            as_of: quote.as_of,
            stale: false,
        });
    }
    if out.is_empty() {
        Err(anyhow!("指数行情为空"))
    } else {
        Ok(out)
    }
}

pub async fn fetch_stock_quote(client: &Client, code: &str) -> Result<StockQuote> {
    let symbol = stock_symbol(code);
    fetch_quote_list(client, &[symbol]).await?.into_iter().next().ok_or_else(|| anyhow!("个股行情为空"))
}

pub async fn fetch_stock_quotes(client: &Client, codes: &[String]) -> Result<Vec<StockQuote>> {
    let symbols: Vec<String> = codes.iter().map(|code| stock_symbol(code)).collect();
    fetch_quote_list(client, &symbols).await
}

pub async fn fetch_index_quote(client: &Client, secid: &str) -> Result<StockQuote> {
    let symbol = tencent_symbol(secid);
    fetch_quote_list(client, &[symbol]).await?.into_iter().next().ok_or_else(|| anyhow!("指数行情为空"))
}

pub async fn search(client: &Client, q: &str) -> Result<Vec<SearchItem>> {
    let q = q.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let mut url = reqwest::Url::parse("https://searchapi.eastmoney.com/api/suggest/get").unwrap();
    url.query_pairs_mut()
        .append_pair("input", q)
        .append_pair("type", "14")
        .append_pair("token", "D43BF722C8E33BDC906FB84D85E326E8&count=5");
    let json = get_json(client, url.as_str(), "https://quote.eastmoney.com/").await?;
    let mut out: Vec<SearchItem> = Vec::new();
    if let Some(arr) = json["QuotationCodeTable"]["Data"].as_array() {
        for it in arr {
            if string(&it["Classify"]) != "AStock" {
                continue;
            }
            let code = string(&it["Code"]);
            if code.len() != 6 {
                continue;
            }
            let quote_id = string(&it["QuoteID"]);
            let market = quote_id.split('.').next().unwrap_or("").to_string();
            let item = SearchItem {
                code: code.clone(),
                name: string(&it["Name"]),
                market,
                security_type: string(&it["SecurityTypeName"]),
            };
            if !out.iter().any(|x| x.code == item.code) {
                out.push(item);
            }
            if out.len() >= 9 {
                break;
            }
        }
    }
    if out.is_empty() && q.len() == 6 && q.chars().all(|c| c.is_ascii_digit()) {
        out.push(SearchItem {
            code: q.to_string(),
            name: String::new(),
            // 与 `stock_symbol` / `secid` 同一口径：6/9/5 归沪（5 = 沪市场内基金）。
            market: if q.starts_with('6') || q.starts_with('9') || q.starts_with('5') {
                "1".into()
            } else {
                "0".into()
            },
            security_type: String::new(),
        });
    }
    Ok(out)
}

/* ————————————————— 其他 · 同花顺自选（问财 / t.10jqka 只读同步） ————————————————— */
//
// 契约与证据见 `.tmp/research-blocks/ths-selfstock-plate-login.md`：脚本（docs/wencai2.js）
// 不生成任何签名，鉴权完全由 cookie 承担，所以纯 Rust 带上正确的 `Cookie` 头即可复现。
// 这些函数只负责抓取 + 解析；cookie 从哪来、结果怎么落库由 `auth.rs` 决定。

const IWC_REFERER: &str = "https://www.iwencai.com/";
const THS_SELF_REFERER: &str = "https://t.10jqka.com.cn/";
const IWC_JSON_ACCEPT: &str = "application/json, text/plain, */*";
const IWC_PLATE_GATEWAY: &str =
    "https://www.iwencai.com/gateway/userstore/iwc/userinfo/self-stock/plate/list";
const IWC_PLATE_LEGACY: &str = "https://www.iwencai.com/unifiedwap/self-stock/plate/list";
const THS_SELF_STOCK_URL: &str = "https://t.10jqka.com.cn/newcircle/group/getSelfStockWithMarket";

/// 板块成分股的候选键名。服务端按账号 / 版本返回不同键（脚本 1874-1880 行同样兜底），
/// 全部试一遍并按代码去重，避免某个键是空数组时漏掉成分股。
const IWC_MEMBER_KEYS: [&str; 10] = [
    "list",
    "stocks",
    "stock_list",
    "stockList",
    "codes",
    "items",
    "code_list",
    "codeList",
    "stock_codes",
    "stockCodes",
];

async fn iwc_request_json(request: reqwest::RequestBuilder, what: &str) -> Result<Value> {
    let res = request.send().await.with_context(|| format!("request {what}"))?;
    let status = res.status();
    let bytes = res.bytes().await.context("read response")?;
    if !status.is_success() {
        return Err(anyhow!("{what} HTTP {}", status.as_u16()));
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    serde_json::from_slice(body).with_context(|| format!("parse json · {what}"))
}

/// 问财 gateway：`GET .../plate/list?stocks={0|1}&ths=0`。
async fn fetch_iwc_gateway(
    client: &Client,
    cookie: &str,
    user_id: &str,
    stocks: u8,
) -> Result<Vec<IwcPlate>> {
    let url = format!("{IWC_PLATE_GATEWAY}?stocks={stocks}&ths=0");
    let mut request = client
        .get(url)
        .header(reqwest::header::REFERER, IWC_REFERER)
        .header(reqwest::header::ACCEPT, IWC_JSON_ACCEPT);
    if !cookie.is_empty() {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    if !user_id.is_empty() {
        request = request.header("X-User-Id", user_id);
    }
    let body = iwc_request_json(request, "问财自选板块").await?;
    iwc_plates_from_body(&body)
}

/// 问财 legacy 兜底：`POST /unifiedwap/self-stock/plate/list`，body `stocks={0|1}&ths=0`。
async fn fetch_iwc_legacy(client: &Client, cookie: &str, stocks: u8) -> Result<Vec<IwcPlate>> {
    let mut request = client
        .post(IWC_PLATE_LEGACY)
        .header(reqwest::header::REFERER, IWC_REFERER)
        .header(reqwest::header::ACCEPT, IWC_JSON_ACCEPT)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(format!("stocks={stocks}&ths=0"));
    if !cookie.is_empty() {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    let body = iwc_request_json(request, "问财自选板块（旧接口）").await?;
    iwc_plates_from_body(&body)
}

/// 拉取问财自选板块：gateway `stocks=1` / `stocks=0` 各请求一次并按 `sn`/`ln` 合并；
/// 合并后仍有板块缺成分股时走 legacy，完全没成分股则 legacy 的 1 / 0 都试。
///
/// 只要有一个变体给出了可识别的板块数组就算成功（数组为空也算 —— 用户确实没有板块）；
/// **全部变体都失败才返回 Err**，调用方据此保留上一次落库的数据。
pub async fn fetch_iwc_plates(
    client: &Client,
    cookie: &str,
    user_id: &str,
) -> Result<Vec<IwcPlate>> {
    let mut merged: Option<Vec<IwcPlate>> = None;
    let mut errors: Vec<String> = Vec::new();
    for stocks in [1u8, 0u8] {
        match fetch_iwc_gateway(client, cookie, user_id, stocks).await {
            Ok(list) => {
                merged = Some(match merged {
                    Some(previous) => merge_iwc_plates(previous, &list),
                    None => list,
                });
            }
            Err(error) => errors.push(format!("gateway stocks={stocks}: {error}")),
        }
    }
    let missing = |list: &[IwcPlate]| list.iter().any(|plate| plate.members.is_empty());
    if merged.as_ref().map(|list| missing(list)).unwrap_or(true) {
        let any_members = merged
            .as_ref()
            .map(|list| list.iter().any(|plate| !plate.members.is_empty()))
            .unwrap_or(false);
        let variants: &[u8] = if any_members { &[1] } else { &[1, 0] };
        for &stocks in variants {
            match fetch_iwc_legacy(client, cookie, stocks).await {
                Ok(list) => {
                    merged = Some(match merged {
                        Some(previous) => merge_iwc_plates(previous, &list),
                        None => list,
                    });
                    if merged.as_ref().map(|list| !missing(list)).unwrap_or(false) {
                        break;
                    }
                }
                Err(error) => errors.push(format!("legacy stocks={stocks}: {error}")),
            }
        }
    }
    let Some(mut plates) = merged else {
        return Err(anyhow!(iwc_plate_failure_message(&errors)));
    };
    finalize_iwc_plates(&mut plates);
    Ok(plates)
}

/// 同花顺自选股：`GET t.10jqka.com.cn/newcircle/group/getSelfStockWithMarket`（无参数）。
/// `errorCode != 0` 视为失败（调用方只加 warning，不阻断板块同步）。
pub async fn fetch_ths_self_stocks(client: &Client, cookie: &str) -> Result<Vec<IwcStock>> {
    let mut request = client
        .get(THS_SELF_STOCK_URL)
        .header(reqwest::header::REFERER, THS_SELF_REFERER)
        .header(reqwest::header::ACCEPT, IWC_JSON_ACCEPT);
    if !cookie.is_empty() {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    let body = iwc_request_json(request, "同花顺自选股").await?;
    parse_ths_self_stocks(&body).map_err(|message| anyhow!(message))
}

/// 失败文案优先级：登录类错误 > 第一条错误 > 空。
fn iwc_plate_failure_message(errors: &[String]) -> String {
    let login_like = errors.iter().find(|error| {
        error.contains("未登") || error.contains("登录") || error.to_lowercase().contains("login")
    });
    if login_like.is_some() {
        return "问财未登录或登录已失效，请重新登录".to_string();
    }
    match errors.first() {
        Some(error) => format!("问财自选板块拉取失败：{error}"),
        None => "问财自选板块为空".to_string(),
    }
}

/// 响应提取（脚本 1828-1836 行的同序优先级）：
/// `result` → `data` → `data.plate_list` → `data.list` → `result.plate_list`。
fn extract_iwc_plate_list(body: &Value) -> Option<&Vec<Value>> {
    if let Some(list) = body.get("result").and_then(Value::as_array) {
        return Some(list);
    }
    if let Some(list) = body.get("data").and_then(Value::as_array) {
        return Some(list);
    }
    if let Some(list) = body.pointer("/data/plate_list").and_then(Value::as_array) {
        return Some(list);
    }
    if let Some(list) = body.pointer("/data/list").and_then(Value::as_array) {
        return Some(list);
    }
    if let Some(list) = body.pointer("/result/plate_list").and_then(Value::as_array) {
        return Some(list);
    }
    None
}

/// 文本字段：字符串取 trim，数字转字符串（`id` / `sn` 偶尔是数字），其余空串。
fn iwc_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

/// 错误文案：`status_msg` / `message` / `error`（脚本 1837-1840 行）。
fn iwc_response_error(body: &Value) -> String {
    for key in ["status_msg", "message", "error"] {
        let text = iwc_text(&body[key]);
        if !text.is_empty() {
            return text;
        }
    }
    String::new()
}

/// 只有带 `sn` / `ln` / `name` 之一的对象数组才算板块列表（脚本 1881 行）。
fn is_iwc_plate_list(list: &[Value]) -> bool {
    list.is_empty()
        || list.iter().any(|item| {
            item.get("sn").is_some() || item.get("ln").is_some() || item.get("name").is_some()
        })
}

fn iwc_plates_from_body(body: &Value) -> Result<Vec<IwcPlate>> {
    let message = iwc_response_error(body);
    let Some(raw) = extract_iwc_plate_list(body) else {
        return Err(anyhow!(if message.is_empty() {
            "问财自选板块返回结构无法识别".to_string()
        } else {
            message
        }));
    };
    if !is_iwc_plate_list(raw) {
        return Err(anyhow!(if message.is_empty() {
            "问财自选板块返回结构无法识别".to_string()
        } else {
            message
        }));
    }
    // 空数组 + 错误文案：过期会话会回 200 + `{result: [], status_msg: "未登录"}`，
    // 这种不能当成「用户没有板块」，否则一次失败就会把镜像覆盖成空。
    // 真正没有板块的账号只回空数组、不带任何错误文案。
    if raw.is_empty() && !message.is_empty() {
        return Err(anyhow!(message));
    }
    let plates: Vec<IwcPlate> = raw.iter().filter_map(parse_iwc_plate).collect();
    // 数组非空却一条板块都解析不出来 = 结构漂移 / 非预期响应，同样按失败处理，
    // 不能拿空结果覆盖上一次的镜像。
    if !raw.is_empty() && plates.is_empty() {
        return Err(anyhow!(if message.is_empty() {
            "问财自选板块返回结构无法识别".to_string()
        } else {
            message
        }));
    }
    Ok(plates)
}

fn parse_iwc_plate(item: &Value) -> Option<IwcPlate> {
    if !item.is_object() {
        return None;
    }
    let sn = {
        let raw = iwc_text(&item["sn"]);
        if raw.is_empty() {
            iwc_text(&item["id"])
        } else {
            raw
        }
    };
    let name = {
        let raw = iwc_text(&item["ln"]);
        if raw.is_empty() {
            iwc_text(&item["name"])
        } else {
            raw
        }
    };
    if sn.is_empty() && name.is_empty() {
        return None;
    }
    Some(IwcPlate {
        sn,
        name,
        // `xn` = 动态板块的问财查询条件，原样存（静态板块为空）。
        condition: iwc_text(&item["xn"]),
        sort: 0,
        members: parse_iwc_plate_members(item),
    })
}

/// 成分股容器可能被包装成数组 / 字符串（`"600000|000001"`）/ 对象（key 是代码）。
fn iwc_member_items(raw: &Value) -> Vec<Value> {
    match raw {
        Value::Array(items) => items.clone(),
        Value::String(text) => text
            .split(|c: char| c == '|' || c == ',' || c == ';' || c.is_whitespace())
            .map(str::trim)
            .filter(|piece| !piece.is_empty())
            .map(|piece| Value::String(piece.to_string()))
            .collect(),
        Value::Object(map) => map.keys().map(|key| Value::String(key.clone())).collect(),
        _ => Vec::new(),
    }
}

fn parse_iwc_plate_members(item: &Value) -> Vec<IwcStock> {
    let mut members: Vec<IwcStock> = Vec::new();
    for key in IWC_MEMBER_KEYS {
        let Some(raw) = item.get(key) else { continue };
        for value in iwc_member_items(raw) {
            let Some(stock) = parse_iwc_stock(&value) else { continue };
            if members.iter().any(|existing| existing.code == stock.code) {
                continue;
            }
            members.push(stock);
        }
    }
    members
}

/// 一个成分股元素：`"600000"` / `"sh600000"` / `"600000.SH"` / `"600000_17"` / `{mark,stock}`。
fn parse_iwc_stock(value: &Value) -> Option<IwcStock> {
    let code = match value {
        Value::String(text) => iwc_code_from_text(text),
        Value::Number(number) => iwc_code_from_text(&number.to_string()),
        Value::Object(map) => iwc_code_from_object(map),
        _ => None,
    }?;
    let market = iwc_market_of(&code)?;
    Some(IwcStock { code, market, name: String::new() })
}

fn iwc_six_digits(text: &str) -> Option<String> {
    let text = text.trim();
    if text.len() == 6 && text.chars().all(|c| c.is_ascii_digit()) {
        Some(text.to_string())
    } else {
        None
    }
}

fn iwc_code_from_text(text: &str) -> Option<String> {
    let raw = text.trim();
    if raw.is_empty() {
        return None;
    }
    let lowered = raw.to_ascii_lowercase();
    // sh/sz 前缀；hk/ny/oq/am 是港股 / 美股，一律丢弃。
    if let Some(rest) = lowered.strip_prefix("sh").or_else(|| lowered.strip_prefix("sz")) {
        return iwc_six_digits(rest);
    }
    if ["hk", "ny", "oq", "am"].iter().any(|prefix| lowered.starts_with(prefix)) {
        return None;
    }
    // 600000.SH / 600000.SZ / 600000.SS
    if let Some((head, tail)) = raw.split_once('.') {
        if matches!(tail.to_ascii_uppercase().as_str(), "SH" | "SZ" | "SS") {
            return iwc_six_digits(head);
        }
    }
    // 600000_17 / 17_600000 / 600000-17 …
    for separator in ['_', ',', ':', '-', '|'] {
        if let Some((head, tail)) = raw.split_once(separator) {
            if let Some(code) = iwc_six_digits(head) {
                return Some(code);
            }
            if let Some(code) = iwc_six_digits(tail) {
                return Some(code);
            }
        }
    }
    iwc_six_digits(raw)
}

fn iwc_code_from_object(map: &serde_json::Map<String, Value>) -> Option<String> {
    let lookup = |keys: &[&str]| -> Option<&Value> {
        keys.iter().find_map(|key| {
            map.iter()
                .find(|(field, _)| field.eq_ignore_ascii_case(key))
                .map(|(_, value)| value)
        })
    };
    let stock = lookup(&["stock", "code", "stock_code", "stockcode", "hqcode", "symbol", "c"]);
    let has_mark = lookup(&["mark", "market", "marketid", "market_id", "marketcode", "m"]).is_some();
    // `{mark, stock}` 是接口的「市场 + 代码」写法；`mark` 只表示这是股票项，
    // 市场最终仍按代码前缀归一，避免 17/33 之类映射不一致。
    if has_mark {
        if let Some(stock) = stock {
            if let Some(code) = iwc_code_value(stock) {
                return Some(code);
            }
        }
        return None;
    }
    stock.and_then(iwc_code_value)
}

fn iwc_code_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => iwc_code_from_text(text),
        Value::Number(number) => iwc_code_from_text(&number.to_string()),
        _ => None,
    }
}

/// 只接受**可交易的 A 股 / 场内基金代码**，返回市场 "1"=沪 / "0"=深（北交所按深处理）。
///
/// 必须按前缀白名单判断，不能只看首位数字：同花顺板块指数 / 中证指数（`885640`、
/// `884036`、`881166`、`886020`、`930986`、`399001` …）都是 6 位数字，按首位会把它们
/// 当成分股混进板块，还会连累行情名称补全。
///
/// 前缀白名单：
/// - 沪市：`600/601/603/605/688/689`（股票）、`5`（场内基金 / ETF：510-518、560-563、
///   588、500 / 501 …）→ `"1"`
/// - 深市：`000/001/002/003/300/301`（股票）、`15/16/18`（ETF / LOF / 封闭基金）→ `"0"`
/// - 北交所：`43/83/87/920` → `"0"`
///
/// 其余一律丢弃：指数 `88xxxx`（88 不在 83/87 白名单内，天然排除）/ `399xxx` /
/// `93xxxx` / `99xxxx`，债券 `110/113/123/127/128`，B 股 `900/200` 等。
fn iwc_market_of(code: &str) -> Option<String> {
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    const SHANGHAI_STOCK: [&str; 6] = ["600", "601", "603", "605", "688", "689"];
    const SHENZHEN_STOCK: [&str; 6] = ["000", "001", "002", "003", "300", "301"];
    const SHENZHEN_FUND: [&str; 3] = ["15", "16", "18"];
    const BEIJING: [&str; 4] = ["43", "83", "87", "920"];
    let shanghai = SHANGHAI_STOCK.iter().any(|prefix| code.starts_with(prefix))
        // 沪市场内基金 / ETF 都在 5 开头
        || code.starts_with('5');
    let shenzhen = SHENZHEN_STOCK.iter().any(|prefix| code.starts_with(prefix))
        // 深市 ETF / LOF / 封闭基金
        || SHENZHEN_FUND.iter().any(|prefix| code.starts_with(prefix));
    if shanghai {
        Some("1".to_string())
    } else if shenzhen {
        Some("0".to_string())
    } else if BEIJING.iter().any(|prefix| code.starts_with(prefix)) {
        // 北交所：前端 market 只有 "1"/"0" 两档，按深市处理。
        Some("0".to_string())
    } else {
        None
    }
}

/// 按 `sn`（缺失时用 `ln` 名称）合并两次响应：主响应保持顺序，次响应补板块 / 成分股。
fn merge_iwc_plates(primary: Vec<IwcPlate>, secondary: &[IwcPlate]) -> Vec<IwcPlate> {
    let mut merged = primary;
    for plate in secondary {
        let index = merged.iter().position(|existing| {
            if !plate.sn.is_empty() && !existing.sn.is_empty() {
                existing.sn == plate.sn
            } else {
                !plate.name.is_empty() && existing.name == plate.name
            }
        });
        match index {
            Some(index) => {
                let target = &mut merged[index];
                if target.sn.is_empty() {
                    target.sn = plate.sn.clone();
                }
                if target.name.is_empty() {
                    target.name = plate.name.clone();
                }
                if target.condition.is_empty() {
                    target.condition = plate.condition.clone();
                }
                for member in &plate.members {
                    if !target.members.iter().any(|existing| existing.code == member.code) {
                        target.members.push(member.clone());
                    }
                }
            }
            None => merged.push(plate.clone()),
        }
    }
    merged
}

/// 收尾：`sort` = 合并后的数组顺序（0 起）；缺名给「未命名板块」；`sn` 缺失时给一个
/// 快照内唯一键（`iwc_plate.sn` 是主键，空串会让多个板块互相覆盖）。
fn finalize_iwc_plates(plates: &mut [IwcPlate]) {
    for (index, plate) in plates.iter_mut().enumerate() {
        plate.sort = index as i64;
        if plate.name.trim().is_empty() {
            plate.name = "未命名板块".to_string();
        }
        if plate.sn.trim().is_empty() {
            plate.sn = format!("plate-{index}");
        }
    }
}

/// `{ errorCode, errorMsg, result: [{ marketid, code }] }`。
///
/// A 股判定**完全交给代码前缀**（`iwc_market_of`：沪 600/601/603/605/688/689、
/// 深 000/001/002/003/300/301、北交所 43/83/87/920），marketid 只用于显式排除港股 /
/// 美股等非 A 股市场 —— 这样北交所（`920001` / `830799`）不会因为 marketid 不在白名单里
/// 被误杀；两者冲突时以代码前缀为准。
fn parse_ths_self_stocks(body: &Value) -> std::result::Result<Vec<IwcStock>, String> {
    let error_code = int(&body["errorCode"]);
    if error_code != 0 {
        let message = string(&body["errorMsg"]);
        return Err(if message.is_empty() {
            format!("同花顺自选股接口返回 errorCode={error_code}")
        } else {
            message
        });
    }
    let mut stocks: Vec<IwcStock> = Vec::new();
    if let Some(list) = body["result"].as_array() {
        for item in list {
            // marketid 只排除明确的非 A 股市场：177 港股、169 美股 NY、185 美股 OQ。
            // （16 / 120 等是沪市通道，代码前缀才决定是不是 A 股。）
            if matches!(int(&item["marketid"]), 177 | 169 | 185) {
                continue;
            }
            let Some(code) = iwc_code_value(&item["code"]) else { continue };
            let Some(market) = iwc_market_of(&code) else { continue };
            if stocks.iter().any(|existing| existing.code == code) {
                continue;
            }
            stocks.push(IwcStock { code, market, name: String::new() });
        }
    }
    Ok(stocks)
}

/* ————————————————— 测试 ————————————————— */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stock(code: &str, market: &str) -> IwcStock {
        IwcStock { code: code.to_string(), market: market.to_string(), name: String::new() }
    }

    fn plate(sn: &str, name: &str, condition: &str, members: Vec<IwcStock>) -> IwcPlate {
        IwcPlate {
            sn: sn.to_string(),
            name: name.to_string(),
            condition: condition.to_string(),
            sort: 0,
            members,
        }
    }

    /// 问财响应有 5 种包装，提取顺序固定；未登录时是 200 + `status_msg`。
    #[test]
    fn iwc_extract_response_wrappers() {
        let bodies = [
            json!({"result": [{"sn": "1", "ln": "A"}]}),
            json!({"data": [{"sn": "2", "ln": "B"}]}),
            json!({"data": {"plate_list": [{"sn": "3", "ln": "C"}]}}),
            json!({"data": {"list": [{"sn": "4", "ln": "D"}]}}),
            json!({"result": {"plate_list": [{"sn": "5", "ln": "E"}]}}),
        ];
        let sns: Vec<String> = bodies
            .iter()
            .map(|body| iwc_plates_from_body(body).unwrap()[0].sn.clone())
            .collect();
        assert_eq!(sns, vec!["1", "2", "3", "4", "5"]);

        // 空板块数组是合法的「没有自选板块」。
        assert!(iwc_plates_from_body(&json!({"result": []})).unwrap().is_empty());

        // 未登录 / 接口报错：文案要能透出给前端。
        assert_eq!(
            iwc_plates_from_body(&json!({"status_msg": "未登录"})).unwrap_err().to_string(),
            "未登录"
        );
        assert_eq!(
            iwc_plates_from_body(&json!({"data": {}, "message": "请先登录"})).unwrap_err().to_string(),
            "请先登录"
        );
        assert!(iwc_plates_from_body(&json!({"foo": 1}))
            .unwrap_err()
            .to_string()
            .contains("无法识别"));
        // 业务字段不是数组（HTML 兜底页会被解析成对象）也算失败。
        assert!(iwc_plates_from_body(&json!({"result": "oops"})).is_err());
    }

    /// 成分股 11 种键名里的 10 个 + 字符串 / 对象两种元素形态。
    #[test]
    fn iwc_parse_member_shapes() {
        let body = json!({
            "sn": "sn-1",
            "ln": "我的板块",
            "xn": "涨幅>5%",
            "list": ["600000", "sh600519", "000001.SZ", "300750_33", "600000", "512880"],
            "stocks": [
                {"mark": 17, "stock": "601318"},
                {"mark": "33", "stock": "002594"},
                {"mark": "177", "stock": "00700"},
                {"code": "688981"}
            ]
        });
        let parsed = parse_iwc_plate(&body).unwrap();
        assert_eq!(parsed.sn, "sn-1");
        assert_eq!(parsed.name, "我的板块");
        assert_eq!(parsed.condition, "涨幅>5%");
        let codes: Vec<&str> = parsed.members.iter().map(|member| member.code.as_str()).collect();
        // 去重 + 丢弃非 6 位 / 港美股（hk00700），ETF（512880）保留
        assert_eq!(
            codes,
            vec!["600000", "600519", "000001", "300750", "512880", "601318", "002594", "688981"]
        );
        let markets: Vec<&str> = parsed.members.iter().map(|member| member.market.as_str()).collect();
        // 512880（沪 ETF）market 为 "1"
        assert_eq!(markets, vec!["1", "1", "0", "0", "1", "1", "0", "1"]);
    }

    /// 板块成分股里混入的指数 / 债券 / B 股必须丢弃；ETF / 场内基金必须保留
    /// （问财的「ETF」板块整板都是 5/15/16/18 开头）。
    #[test]
    fn iwc_parse_keeps_funds_and_drops_index_codes() {
        let body = json!({
            "sn": "sn-2",
            "ln": "ETF 与指数混入",
            "list": [
                // 指数：沪深指数 / 同花顺板块指数
                "885640", "884036", "881166", "886020", "930986", "399001",
                // 债券 / B 股
                "113050", "123456", "110038", "127045", "900901", "200011",
                // 股票 + 北交所
                "600519", "000001", "300750", "688981", "830799", "920001",
                // 场内基金：沪 ETF / 深 ETF / LOF
                "510300", "512880", "588000", "159915", "161725"
            ]
        });
        let parsed = parse_iwc_plate(&body).unwrap();
        let codes: Vec<&str> = parsed.members.iter().map(|member| member.code.as_str()).collect();
        assert_eq!(
            codes,
            vec![
                "600519", "000001", "300750", "688981", "830799", "920001", "510300", "512880",
                "588000", "159915", "161725"
            ]
        );
        let markets: Vec<&str> = parsed.members.iter().map(|member| member.market.as_str()).collect();
        assert_eq!(
            markets,
            vec!["1", "0", "0", "1", "0", "0", "1", "1", "1", "0", "0"]
        );
    }

    /// 行情 / K 线符号映射：沪市场内基金（5 开头）必须走 sh / "1."，否则 ETF 取不到数据。
    #[test]
    fn fund_symbols_map_to_shanghai() {
        assert_eq!(stock_symbol("510300"), "sh510300");
        assert_eq!(stock_symbol("512880"), "sh512880");
        assert_eq!(stock_symbol("588000"), "sh588000");
        assert_eq!(stock_symbol("159915"), "sz159915");
        assert_eq!(stock_symbol("161725"), "sz161725");
        assert_eq!(stock_symbol("600519"), "sh600519");
        assert_eq!(stock_symbol("000001"), "sz000001");
        assert_eq!(secid("510300"), "1.510300");
        assert_eq!(secid("512880"), "1.512880");
        assert_eq!(secid("159915"), "0.159915");
        assert_eq!(secid("161725"), "0.161725");
        assert_eq!(secid("600519"), "1.600519");
        assert_eq!(secid("000001"), "0.000001");
        // 已带 sh/sz 前缀的形式不经过这两个函数
        assert_eq!(secid_from_symbol("sh510300"), "1.510300");
        assert_eq!(secid_from_symbol("sz159915"), "0.159915");
    }

    /// ETF / 场内基金识别：决定 K 线走腾讯不复权接口还是前复权接口。
    #[test]
    fn fund_code_detection() {
        for code in ["510300", "512880", "588000", "501050", "159915", "161725", "184801"] {
            assert!(is_fund_code(code), "{code} 应识别为场内基金");
        }
        for code in ["600519", "000001", "300750", "688981", "830799", "920001", "110038"] {
            assert!(!is_fund_code(code), "{code} 不应识别为场内基金");
        }
    }

    /// 腾讯不复权日线（ETF K 线兜底）：`data.sh510300.day = [[日期, 开, 收, 高, 低, 量], …]`。
    /// 复用 `parse_tencent_kline`（先 `qfq{period}`，回退 `{period}`），这里走 `day` 分支。
    #[test]
    fn parse_tencent_raw_etf_kline() {
        let json = json!({
            "code": 0,
            "msg": "",
            "data": {
                "sh510300": {
                    "day": [
                        ["2026-10-29", "4.050", "4.059", "4.066", "4.045", "19800000.000"],
                        ["2026-10-30", "4.059", "4.065", "4.126", "4.046", "21130014.000"],
                        ["2026-11-02", "4.070", "4.052", "4.075", "4.040", "15300000.000"]
                    ],
                    "qt": { "sh510300": ["1", "沪深300ETF", "510300", "4.052"] }
                }
            }
        });
        let (name, candles) = parse_tencent_kline(&json, "sh510300", "day").unwrap();
        assert_eq!(name, "沪深300ETF");
        assert_eq!(candles.len(), 3);
        let first = &candles[0];
        assert_eq!(first.date, "2026-10-29");
        assert!((first.open - 4.050).abs() < 1e-9);
        assert!((first.close - 4.059).abs() < 1e-9);
        assert!((first.high - 4.066).abs() < 1e-9);
        assert!((first.low - 4.045).abs() < 1e-9);
        assert!((first.volume - 19_800_000.0).abs() < 1e-6);
        // 涨跌幅按前一根收盘价算
        let second = &candles[1];
        assert!((second.pct - ((4.065 / 4.059 - 1.0) * 100.0)).abs() < 1e-9);
        assert_eq!(candles[2].date, "2026-11-02");
        assert!((candles[2].close - 4.052).abs() < 1e-9);

        // 前复权节点优先（股票仍走 `qfqday`），raw 节点作为回退。
        let both = json!({"data": {"sh600519": {
            "qfqday": [["2026-10-30", "1500", "1510", "1520", "1490", "30000"]],
            "day": [["2026-10-30", "1600", "1610", "1620", "1590", "30000"]]
        }}});
        let (_, candles) = parse_tencent_kline(&both, "sh600519", "day").unwrap();
        assert!((candles[0].close - 1510.0).abs() < 1e-9);
    }

    /// 容器是字符串 / 对象 / 空数组 / 不同键名时的容错。
    #[test]
    fn iwc_parse_member_containers() {
        let from_text = parse_iwc_plate(&json!({"sn": "a", "ln": "x", "stocks": "600000|000001;300750"}))
            .unwrap();
        assert_eq!(from_text.members.len(), 3);

        let from_object =
            parse_iwc_plate(&json!({"sn": "b", "ln": "y", "codes": {"600000": true, "000001": 1}}))
                .unwrap();
        assert_eq!(from_object.members.len(), 2);

        // 第一个候选键是空数组时仍要尝试后面的键。
        let fallback_key = parse_iwc_plate(&json!({"sn": "c", "ln": "z", "list": [], "items": ["600519"]}))
            .unwrap();
        assert_eq!(fallback_key.members.len(), 1);

        assert!(parse_iwc_plate(&json!({"sn": "d", "ln": "w"})).unwrap().members.is_empty());
        assert!(parse_iwc_plate(&json!({"foo": 1})).is_none());
        // `name` / `id` 是 `ln` / `sn` 的兜底键（脚本同样接受）。
        assert_eq!(parse_iwc_plate(&json!({"id": 7, "name": "旧接口"})).unwrap().sn, "7");
    }

    /// `stocks=1` / `stocks=0` 两份响应按 sn（缺失时 ln）合并。
    #[test]
    fn iwc_merge_by_sn_then_name() {
        let primary = vec![
            plate("10", "涨幅榜", "", vec![stock("600000", "1")]),
            plate("", "静态自选", "", Vec::new()),
        ];
        let secondary = vec![
            plate("10", "", "", vec![stock("000001", "0"), stock("600000", "1")]),
            plate("", "静态自选", "", vec![stock("600519", "1")]),
            plate("11", "动态板块", "涨幅>5%", Vec::new()),
        ];
        let merged = merge_iwc_plates(primary, &secondary);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].members.len(), 2);
        assert_eq!(merged[0].members[1].code, "000001");
        assert_eq!(merged[1].members.len(), 1);
        assert_eq!(merged[1].members[0].code, "600519");
        assert_eq!(merged[2].condition, "涨幅>5%");
    }

    /// 收尾：sort = 数组顺序，缺名 / 缺 sn 时兜底。
    #[test]
    fn iwc_finalize_sorts_names_and_sn() {
        let mut plates = vec![
            plate("a", "", "", Vec::new()),
            plate("", "B", "", Vec::new()),
        ];
        finalize_iwc_plates(&mut plates);
        assert_eq!(plates[0].sort, 0);
        assert_eq!(plates[0].name, "未命名板块");
        assert_eq!(plates[1].sort, 1);
        assert_eq!(plates[1].sn, "plate-1");
    }

    /// 市场归一：沪股票 + 沪场内基金（5）/ 深股票 + 深基金（15/16/18）/ 北交所，
    /// 指数、债券、B 股一律丢弃。
    #[test]
    fn iwc_market_normalize() {
        // 真实 A 股：沪 600/601/603/605/688/689，深 000/001/002/003/300/301，北交所 43/83/87/920
        assert_eq!(iwc_market_of("600000").as_deref(), Some("1"));
        assert_eq!(iwc_market_of("688981").as_deref(), Some("1"));
        assert_eq!(iwc_market_of("601318").as_deref(), Some("1"));
        assert_eq!(iwc_market_of("000001").as_deref(), Some("0"));
        assert_eq!(iwc_market_of("002594").as_deref(), Some("0"));
        assert_eq!(iwc_market_of("300750").as_deref(), Some("0"));
        assert_eq!(iwc_market_of("301001").as_deref(), Some("0"));
        assert_eq!(iwc_market_of("830799").as_deref(), Some("0"));
        assert_eq!(iwc_market_of("430047").as_deref(), Some("0"));
        assert_eq!(iwc_market_of("920001").as_deref(), Some("0"));
        // 场内基金：沪 5 开头（ETF/LOF），深 15/16/18
        assert_eq!(iwc_market_of("510300").as_deref(), Some("1"));
        assert_eq!(iwc_market_of("512880").as_deref(), Some("1"));
        assert_eq!(iwc_market_of("588000").as_deref(), Some("1"));
        assert_eq!(iwc_market_of("501050").as_deref(), Some("1"));
        assert_eq!(iwc_market_of("159915").as_deref(), Some("0"));
        assert_eq!(iwc_market_of("161725").as_deref(), Some("0"));
        assert_eq!(iwc_market_of("184801").as_deref(), Some("0"));
        // 同花顺板块指数 / 中证指数混在成分股里时要丢弃
        assert_eq!(iwc_market_of("885640"), None);
        assert_eq!(iwc_market_of("884036"), None);
        assert_eq!(iwc_market_of("881166"), None);
        assert_eq!(iwc_market_of("886020"), None);
        assert_eq!(iwc_market_of("930986"), None);
        assert_eq!(iwc_market_of("399001"), None);
        assert_eq!(iwc_market_of("990001"), None);
        // 债券 / B 股 / 非 6 位
        assert_eq!(iwc_market_of("110038"), None);
        assert_eq!(iwc_market_of("113050"), None);
        assert_eq!(iwc_market_of("127045"), None);
        assert_eq!(iwc_market_of("128136"), None);
        assert_eq!(iwc_market_of("900901"), None);
        assert_eq!(iwc_market_of("200011"), None);
        assert_eq!(iwc_market_of("60000"), None);
        // 非 6 位的文本形态同样被丢弃
        assert_eq!(iwc_code_from_text("sh600000").as_deref(), Some("600000"));
        assert_eq!(iwc_code_from_text("600000.SH").as_deref(), Some("600000"));
        assert_eq!(iwc_code_from_text("hk00700"), None);
        assert_eq!(iwc_code_from_text("nyAAPL"), None);
    }

    /// t.10jqka 自选股：marketid 映射 + errorCode 判定 + 非 A 股过滤。
    #[test]
    fn ths_self_stocks_error_code() {
        let ok = json!({"errorCode": 0, "errorMsg": "", "result": [
            {"marketid": 17, "code": "600000"},
            {"marketid": 33, "code": "000001"},
            {"marketid": 20, "code": "601318"},
            {"marketid": 36, "code": "002594"},
            {"marketid": 177, "code": "00700"},
            // 未知 marketid 但代码是 A 股：以代码前缀为准，保留
            {"marketid": 99, "code": "600519"},
            // 北交所：marketid 不在旧的沪/深白名单里，但代码前缀 87/920 有效，必须保留
            {"marketid": 16, "code": "830799"},
            {"marketid": 120, "code": "920001"},
            // 港股 / 美股 marketid 即使代码看起来像 A 股也排除
            {"marketid": 177, "code": "601988"},
            {"marketid": 169, "code": "600036"},
            // 场内基金（ETF）也要保留：沪 5 开头 / 深 15 开头
            {"marketid": 17, "code": "510300"},
            {"marketid": 33, "code": "159915"},
            // 债券仍丢弃
            {"marketid": 17, "code": "113050"},
            {"marketid": 33, "code": "123456"},
            {"marketid": 17, "code": "600000"}
        ]});
        let stocks = parse_ths_self_stocks(&ok).unwrap();
        let pairs: Vec<(&str, &str)> =
            stocks.iter().map(|item| (item.code.as_str(), item.market.as_str())).collect();
        assert_eq!(
            pairs,
            vec![
                ("600000", "1"),
                ("000001", "0"),
                ("601318", "1"),
                ("002594", "0"),
                ("600519", "1"),
                ("830799", "0"),
                ("920001", "0"),
                ("510300", "1"),
                ("159915", "0"),
            ]
        );

        assert_eq!(
            parse_ths_self_stocks(&json!({"errorCode": 4, "errorMsg": "未登录", "result": []}))
                .unwrap_err(),
            "未登录"
        );
        // errorCode 是字符串 "4" 也要判失败；无 errorMsg 时给可读文案。
        let failed = parse_ths_self_stocks(&json!({"errorCode": "4", "errorMsg": ""})).unwrap_err();
        assert!(failed.contains("errorCode=4"));
        // 缺 result 时按空列表处理，不算失败。
        assert!(parse_ths_self_stocks(&json!({"errorCode": 0})).unwrap().is_empty());
    }

    /// 空板块数组 + 错误文案 = 失败（过期会话）；只有「空且无文案」才是真的没有板块。
    #[test]
    fn iwc_empty_plates_with_error_text_is_failure() {
        assert_eq!(
            iwc_plates_from_body(&json!({"result": [], "status_msg": "未登录"}))
                .unwrap_err()
                .to_string(),
            "未登录"
        );
        assert_eq!(
            iwc_plates_from_body(&json!({"data": [], "message": "登录已过期"})).unwrap_err().to_string(),
            "登录已过期"
        );
        // 空且无文案：合法（用户确实没有自选板块）。
        assert!(iwc_plates_from_body(&json!({"result": []})).unwrap().is_empty());
        assert!(iwc_plates_from_body(&json!({"data": [], "status_msg": " "})).unwrap().is_empty());
        // 有数据时错误文案不参与判定（部分接口会顺带返回过期提示）。
        assert_eq!(
            iwc_plates_from_body(&json!({"result": [{"sn": "1", "ln": "A"}], "message": "提示"}))
                .unwrap()
                .len(),
            1
        );
        // 数组非空却一条板块都解析不出来（字段漂移 / 非预期包装）：按失败处理，
        // 不能拿空结果覆盖上一次的镜像。
        assert!(iwc_plates_from_body(&json!({"result": [{"foo": 1}, "bar", 42]}))
            .unwrap_err()
            .to_string()
            .contains("无法识别"));
        assert_eq!(
            iwc_plates_from_body(&json!({"result": [{"foo": 1}], "message": "服务异常"}))
                .unwrap_err()
                .to_string(),
            "服务异常"
        );
        // 带 sn/ln 键但值为空：过了「是不是板块数组」的判定，却解析不出任何板块，
        // 同样按失败处理（不能被当成「空账号」覆盖镜像）。
        assert!(iwc_plates_from_body(&json!({"result": [{"sn": null, "ln": null}, {"sn": "", "ln": ""}]}))
            .unwrap_err()
            .to_string()
            .contains("无法识别"));
    }

    /// 失败文案：登录类错误优先给「请重新登录」。
    #[test]
    fn iwc_failure_message_priority() {
        let login = vec!["gateway stocks=1: 未登录".to_string()];
        assert_eq!(iwc_plate_failure_message(&login), "问财未登录或登录已失效，请重新登录");
        let other = vec!["gateway stocks=1: HTTP 500".to_string()];
        assert!(iwc_plate_failure_message(&other).contains("HTTP 500"));
        assert_eq!(iwc_plate_failure_message(&[]), "问财自选板块为空");
    }
}
