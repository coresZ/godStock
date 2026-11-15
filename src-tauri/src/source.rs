use std::collections::HashMap;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde_json::Value;

use crate::db;
use crate::models::*;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const THS_REFERER: &str = "https://data.10jqka.com.cn/";
const EM_REFERER: &str = "https://quote.eastmoney.com/";

pub fn client() -> Result<Client> {
    Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(6))
        .gzip(true)
        .build()
        .context("build http client")
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
    let pool = fetch_pool(client, date, "limit_up_pool", "330324").await?;
    let mut warnings: Vec<String> = Vec::new();
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

    let mut open_limit: Vec<Stock> = open_pool.iter().filter_map(|v| aux_stock(v)).collect();
    open_limit.sort_by(|a, b| {
        b.change_rate
            .partial_cmp(&a.change_rate)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.last_seal.cmp(&b.last_seal))
    });
    let mut limit_down: Vec<Stock> = down_pool.iter().filter_map(|v| aux_stock(v)).collect();
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
        fetched_at: db::now_ts(),
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
        "1m" => 1200,
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
    fetch_prev_close(client, &secid(code)).await
}

pub async fn fetch_kline(client: &Client, code: &str, period: &str) -> Result<(String, Vec<KlineCandle>)> {
    let sid = secid(code);
    let klt = period_klt(period);
    let lmt = kline_limit(period);
    let url = format!(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={sid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt={klt}&fqt=1&end=20500101&lmt={lmt}"
    );
    let json = get_json(client, &url, EM_REFERER).await?;
    parse_kline_json(&json["data"])
}

pub async fn fetch_prev_close(client: &Client, sid: &str) -> Option<f64> {
    let url = format!(
        "https://push2.eastmoney.com/api/qt/stock/get?fltt=2&secid={sid}&fields=f57,f58,f43,f60"
    );
    let json = get_json(client, &url, EM_REFERER).await.ok()?;
    let value = num(&json["data"]["f60"]);
    if value > 0.0 { Some(value) } else { None }
}

pub async fn fetch_index_kline(client: &Client, sid: &str, period: &str) -> Result<(String, Vec<KlineCandle>)> {
    let klt = period_klt(period);
    let lmt = kline_limit(period);
    let url = format!(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={sid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt={klt}&fqt=1&end=20500101&lmt={lmt}"
    );
    let json = get_json(client, &url, EM_REFERER).await?;
    parse_kline_json(&json["data"])
}

pub async fn fetch_indices(client: &Client) -> Vec<(String, Vec<(String, f64, f64)>)> {
    let list = [
        ("1.000001", "上证指数"),
        ("0.399001", "深证成指"),
        ("0.399006", "创业板指"),
    ];
    let quote_url = "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001,0.399006&fields=f2,f3,f4,f12,f14";
    let mut quote_pct: HashMap<String, f64> = HashMap::new();
    if let Ok(quote) = get_json(client, quote_url, EM_REFERER).await {
        if let Some(items) = quote["data"]["diff"].as_array() {
            for item in items {
                let code = string(&item["f12"]);
                let pct = num(&item["f3"]);
                if !code.is_empty() {
                    quote_pct.insert(code, pct);
                }
            }
        }
    }
    let mut out = Vec::new();
    for (sid, name) in list {
        let url = format!(
            "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={sid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=1&fqt=1&end=20500101&lmt=260"
        );
        let result = get_json(client, &url, EM_REFERER).await;
        let Ok(json) = result else { continue };
        let mut raw: Vec<(String, f64, f64)> = Vec::new();
        if let Some(lines) = json["data"]["klines"].as_array() {
            for line in lines {
                let Some(text) = line.as_str() else { continue };
                let parts: Vec<&str> = text.split(',').collect();
                if parts.len() < 3 {
                    continue;
                }
                let open = parts[1].parse::<f64>().unwrap_or(0.0);
                let close = parts[2].parse::<f64>().unwrap_or(0.0);
                if open > 0.0 && close > 0.0 {
                    raw.push((parts[0].to_string(), open, close));
                }
            }
        }
        let Some(last_day) = raw.last().map(|r| r.0.chars().take(10).collect::<String>()) else {
            continue;
        };
        let day_rows: Vec<&(String, f64, f64)> = raw.iter().filter(|r| r.0.starts_with(&last_day)).collect();
        let Some(first) = day_rows.first() else { continue };
        let base = first.1;
        let mut rows: Vec<(String, f64, f64)> = day_rows
            .iter()
            .map(|r| {
                let pct = if base > 0.0 { (r.2 / base - 1.0) * 100.0 } else { 0.0 };
                (r.0.clone(), r.2, pct)
            })
            .collect();
        // 1 分钟接口只能推算当日涨跌幅；用指数快照接口补回精确涨幅。
        if let Some(pct) = quote_pct.get(sid.split('.').nth(1).unwrap_or("")) {
            if let Some(last) = rows.last_mut() {
                last.2 = *pct;
            }
        }
        if !rows.is_empty() {
            let _ = name;
            out.push((sid.to_string(), rows));
        }
    }
    out
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
