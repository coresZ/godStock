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
    if code.starts_with('6') || code.starts_with('9') {
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
            high_days: if raw_high.is_empty() {
                format!("{board}板")
            } else {
                raw_high
            },
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
    let market = if code.starts_with('6') || code.starts_with('9') {
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

pub async fn fetch_kline(client: &Client, code: &str, period: &str) -> Result<(String, Vec<KlineCandle>)> {
    match fetch_eastmoney_kline(client, code, period).await {
        Ok(data) => Ok(data),
        Err(primary) => {
            let fallback = match period {
                "1m" => fetch_tencent_minute_kline(client, &stock_symbol(code)).await,
                "day" | "week" | "month" => fetch_tencent_kline(client, code, period).await,
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

pub async fn fetch_index_kline(client: &Client, sid: &str, period: &str) -> Result<(String, Vec<KlineCandle>)> {
    match fetch_eastmoney_index_kline(client, sid, period).await {
        Ok(data) => Ok(data),
        Err(primary) => {
            let fallback = match period {
                "1m" => fetch_tencent_minute_kline(client, &tencent_symbol(sid)).await,
                "day" | "week" | "month" => fetch_tencent_index_kline(client, sid, period).await,
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
        turnover: 0.0,
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
            market: if q.starts_with('6') { "1".into() } else { "0".into() },
            security_type: String::new(),
        });
    }
    Ok(out)
}
