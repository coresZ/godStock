//! 龙虎榜（「其他 · 游资动态」）数据层。
//!
//! 数据源是公开的龙虎榜接口：行情列表 / 个股明细 / 席位榜 / 机构榜 / 席位操作记录，
//! 连板与板块用东方财富涨停池做 best-effort 补充。所有抓取都在这里完成，前端只拿
//! `commands.rs` 里的薄封装。解析函数保持纯函数，便于单测。

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use anyhow::{anyhow, Context, Result};
use chrono::{Datelike, Duration, NaiveDate, Utc};
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;

use crate::db;
use crate::yyz_tags;

/// 与 `source.rs` 保持一致的 Chrome UA（那里是私有常量，这里复制一份）。
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const LHB_BASE: &str = "https://applhb.longhuvip.com/w1/api/index.php?";
const LHB_REFERER: &str = "https://www.longhuvip.com/";
const EM_REFERER: &str = "https://quote.eastmoney.com/";
const EM_POOL_BASE: &str = "https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&Pagesize=500&sort=fbt%3Aasc";

/// 请求日无数据时向前逐日探测的最大次数（含请求日）。
const BOARD_PROBE_LIMIT: usize = 10;
/// 席位操作记录最多保留条数。
const SEAT_LOG_LIMIT: usize = 200;

const BOARD_TTL: i64 = 300;
const DETAIL_TTL: i64 = 600;
const AGENCY_TTL: i64 = 300;
const INSTITUTION_TTL: i64 = 300;
const SEAT_TTL: i64 = 1800;
const META_TTL: i64 = 300;

/* ————————————————— 前端契约（字段与 src/lib/types.ts 一一对应） ————————————————— */

/// 龙虎榜买 / 卖席位。金额单位：元。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LhbSeat {
    pub id: String,
    pub name: String,
    pub buy: f64,
    pub sell: f64,
    pub net: f64,
    pub tags: Vec<String>,
    /// 0 无 · 1 一线游资 · 2 顶级游资 · 3 知名游资（接口 YouZiIcon）
    pub level: i64,
    /// 关联席位（接口 AssocIcon）
    pub assoc: bool,
    /// 昨日上榜买 / 卖次数（接口 ytdbusin）
    pub yday_buy: i64,
    pub yday_sell: i64,
}

/// 一只票当日可能因多个上榜理由各有一组买卖席位。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LhbReasonBlock {
    pub reasons: Vec<String>,
    pub buy_total: f64,
    pub sell_total: f64,
    pub buy: Vec<LhbSeat>,
    pub sell: Vec<LhbSeat>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LhbDetail {
    pub code: String,
    pub name: String,
    /// YYYYMMDD
    pub date: String,
    pub pct: f64,
    pub turnover_rate: f64,
    /// 流通市值（亿元）
    pub circulation: f64,
    pub net_buy: f64,
    pub seat_count: i64,
    /// 近期上榜日期，新 → 旧，YYYYMMDD
    pub on_time: Vec<String>,
    pub blocks: Vec<LhbReasonBlock>,
    pub source: String,
    pub fetched_at: i64,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LhbStock {
    pub code: String,
    pub name: String,
    pub pct: f64,
    pub net_buy: f64,
    pub seats: i64,
    pub turnover: f64,
    pub turnover_rate: f64,
    pub float_cap: f64,
    pub market_cap: f64,
    /// “5板” / “3天2板” / “首板” / ""（东财涨停池补充，失败为空）
    pub board: String,
    pub sector: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LhbBoard {
    /// 前端请求的日期，YYYYMMDD
    pub requested_date: String,
    /// 实际有数据的日期，YYYYMMDD；无数据回退时与 requestedDate 不同
    pub date: String,
    pub fallback: bool,
    pub rows: Vec<LhbStock>,
    pub source: String,
    pub fetched_at: i64,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LhbAgency {
    pub id: String,
    pub name: String,
    pub buy: f64,
    pub sell: f64,
    pub net: f64,
    /// 关联个股数（接口 JoinNum）
    pub join_count: i64,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LhbHotSeat {
    pub id: String,
    pub name: String,
    pub buy: f64,
    pub sell: f64,
    pub net: f64,
}

/// 按游资名号聚合的席位榜（同一席位命中多个名号时分别计入）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LhbHotMoneyTag {
    pub tag: String,
    pub buy: f64,
    pub sell: f64,
    pub net: f64,
    pub seats: Vec<LhbHotSeat>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LhbAgencies {
    pub date: String,
    pub rows: Vec<LhbAgency>,
    pub hot: Vec<LhbHotMoneyTag>,
    pub source: String,
    pub fetched_at: i64,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LhbInstitution {
    pub code: String,
    pub name: String,
    pub pct: f64,
    pub net_buy: f64,
    /// 上榜机构数（接口 JoinNum）
    pub org_count: i64,
    pub turnover: f64,
    pub turnover_rate: f64,
    pub board: String,
    pub sector: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LhbInstitutions {
    pub date: String,
    pub rows: Vec<LhbInstitution>,
    pub source: String,
    pub fetched_at: i64,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LhbSeatTrade {
    /// YYYYMMDD
    pub date: String,
    pub code: String,
    pub name: String,
    pub pct: f64,
    pub buy: f64,
    pub sell: f64,
    pub net: f64,
    /// 三日榜记录（接口 D3="1"），与当日榜金额口径不同
    pub three_day: bool,
}

/// 单个营业部最近 N 天的上榜个股记录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LhbSeatLog {
    pub seat_id: String,
    pub rows: Vec<LhbSeatTrade>,
    pub days: i64,
    /// 上游返回的原始记录数（可能大于 rows.len()）
    pub total: usize,
    /// rows 是否被截断（超过 SEAT_LOG_LIMIT）
    pub truncated: bool,
    pub source: String,
    pub fetched_at: i64,
    pub warning: Option<String>,
}

/* ————————————————— 通用解析工具 ————————————————— */

/// 金额 / 比例字段在接口里可能是字符串，统一转 f64。
fn num(v: &Value) -> f64 {
    if let Some(n) = v.as_f64() {
        if n.is_finite() {
            return n;
        }
    }
    if let Some(s) = v.as_str() {
        if let Ok(n) = s.trim().parse::<f64>() {
            if n.is_finite() {
                return n;
            }
        }
    }
    0.0
}

/// 计数字段（席位家数 / JoinNum / YouZiIcon 等）统一转 i64。
fn int(v: &Value) -> i64 {
    if let Some(n) = v.as_i64() {
        return n;
    }
    if let Some(n) = v.as_f64() {
        return n as i64;
    }
    if let Some(s) = v.as_str() {
        let s = s.trim();
        if let Ok(n) = s.parse::<i64>() {
            return n;
        }
        if let Ok(n) = s.parse::<f64>() {
            return n as i64;
        }
    }
    0
}

/// 文本字段统一 trim；数字（如机构榜的 ID）转成字符串。
fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 股票代码：字符串原样保留（保住 000530 的前导零），数字补足 6 位。
fn stock_code(v: &Value) -> String {
    match v {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => {
            let base = n.as_i64().unwrap_or(0);
            if base > 0 {
                format!("{base:06}")
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

/// 百分比字段：`"10.01%"` → 10.01。
fn pct(v: &Value) -> f64 {
    match v {
        Value::String(s) => s
            .trim()
            .trim_end_matches('%')
            .trim()
            .parse::<f64>()
            .unwrap_or(0.0),
        _ => num(v),
    }
}

/// 取日期里的 8 位数字（`2026-11-23` → `20261123`）；不足 8 位返回空串。
fn ymd(raw: &str) -> String {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 8 {
        digits[..8].to_string()
    } else {
        String::new()
    }
}

/// 请求日期归一化到 YYYYMMDD；空 / 非法时退回今天（东八区）。
fn compact_date(raw: &str) -> String {
    let compact = ymd(raw);
    if compact.is_empty() {
        db::today_ymd()
    } else {
        compact
    }
}

/// `20261123` → `2026-11-23`（个股明细接口要求横杠日期）。
fn dash_date(compact: &str) -> String {
    if compact.len() == 8 {
        format!("{}-{}-{}", &compact[0..4], &compact[4..6], &compact[6..8])
    } else {
        compact.to_string()
    }
}

/// 前一个交易日（跳过周六 / 周日）。
fn previous_trade_day(compact: &str) -> Option<String> {
    let mut day = NaiveDate::parse_from_str(compact, "%Y%m%d").ok()? - Duration::days(1);
    for _ in 0..7 {
        if !matches!(day.weekday(), chrono::Weekday::Sat | chrono::Weekday::Sun) {
            return Some(day.format("%Y%m%d").to_string());
        }
        day -= Duration::days(1);
    }
    None
}

/// 取数组字段；缺失或类型不对时返回空切片。
fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match value.get(key).and_then(Value::as_array) {
        Some(items) => items.as_slice(),
        None => &[],
    }
}

/// 大小写不一致的数组字段（例如机构榜的 `List`）逐个尝试。
fn first_array<'a>(value: &'a Value, keys: &[&str]) -> &'a [Value] {
    for key in keys {
        let items = array(value, key);
        if !items.is_empty() {
            return items;
        }
    }
    &[]
}

/// 上游限流 / 异常时常返回 `{"errcode":"9999","errmsg":"..."}`。
/// `errmsg` 非空时直接返回；只有非 0 `errcode` 时退回错误码文案；正常响应返回 None。
fn upstream_error(body: &Value) -> Option<String> {
    let errmsg = text(&body["errmsg"]);
    if !errmsg.is_empty() {
        return Some(errmsg);
    }
    let errcode = text(&body["errcode"]);
    if !errcode.is_empty() && errcode != "0" && body.get("errmsg").is_some() {
        return Some(format!("上游错误码 {errcode}"));
    }
    None
}

/// 空数据时的 warning：有上游错误文案就用 `{prefix}{errmsg}`，否则用兜底文案。
fn empty_warning(prefix: &str, upstream: Option<String>, fallback: &str) -> Option<String> {
    Some(match upstream {
        Some(errmsg) => format!("{prefix}{errmsg}"),
        None => fallback.to_string(),
    })
}

/* ————————————————— 解析（纯函数，便于单测） ————————————————— */

fn parse_board_row(item: &Value) -> LhbStock {
    LhbStock {
        code: stock_code(&item["ID"]),
        name: text(&item["Name"]),
        pct: pct(&item["IncreaseAmount"]),
        net_buy: num(&item["BuyIn"]),
        seats: int(&item["JoinNum"]),
        turnover: num(&item["Turnover"]),
        turnover_rate: num(&item["TurnoverRatio"]),
        float_cap: num(&item["CircPrice"]),
        market_cap: num(&item["Capitalization"]),
        board: String::new(),
        sector: String::new(),
    }
}

/// 解析 `GetStockList` 的 `list`；空响应（无 `list` 键）返回空数组。
fn parse_board(body: &Value) -> Vec<LhbStock> {
    array(body, "list").iter().map(parse_board_row).collect()
}

/// 解析东财涨停池：股票代码 -> (连板文案, 板块)。
fn parse_zt_pool(body: &Value) -> HashMap<String, (String, String)> {
    let mut meta = HashMap::new();
    let pool = body
        .get("data")
        .and_then(|data| data.get("pool"))
        .and_then(Value::as_array);
    for item in pool.into_iter().flatten() {
        let code = stock_code(&item["c"]);
        if code.is_empty() {
            continue;
        }
        meta.insert(code, (board_text(item), text(&item["hybk"])));
    }
    meta
}

/// 连板文案：`9天2板` / `5板` / `首板` / 空。
fn board_text(item: &Value) -> String {
    let lbc = int(&item["lbc"]);
    let ct = item.get("zttj").map(|zttj| int(&zttj["ct"])).unwrap_or(0);
    if lbc >= 2 && ct > lbc {
        format!("{ct}天{lbc}板")
    } else if lbc >= 2 {
        format!("{lbc}板")
    } else if lbc == 1 {
        "首板".to_string()
    } else {
        String::new()
    }
}

fn parse_agencies(body: &Value) -> Vec<LhbAgency> {
    first_array(body, &["list", "List"])
        .iter()
        .map(|item| {
            let name = text(&item["Name"]);
            let buy = num(&item["Buy"]);
            let sell = num(&item["Sell"]);
            LhbAgency {
                id: text(&item["ID"]),
                tags: yyz_tags::tags_for(&name)
                    .into_iter()
                    .map(|tag| tag.to_string())
                    .collect(),
                net: buy - sell,
                join_count: int(&item["JoinNum"]),
                name,
                buy,
                sell,
            }
        })
        .collect()
}

/// 按游资名号汇总席位榜。同一席位命中多个名号时分别计入。
fn build_hot(rows: &[LhbAgency]) -> Vec<LhbHotMoneyTag> {
    let mut buckets: HashMap<String, LhbHotMoneyTag> = HashMap::new();
    for row in rows {
        for tag in &row.tags {
            // 「机构专用」不是游资名号：它在明细里照常打标，但不进游资净买入榜。
            if tag == "机构专用" {
                continue;
            }
            let bucket = buckets
                .entry(tag.clone())
                .or_insert_with(|| LhbHotMoneyTag {
                    tag: tag.clone(),
                    buy: 0.0,
                    sell: 0.0,
                    net: 0.0,
                    seats: Vec::new(),
                });
            bucket.buy += row.buy;
            bucket.sell += row.sell;
            bucket.net += row.net;
            bucket.seats.push(LhbHotSeat {
                id: row.id.clone(),
                name: row.name.clone(),
                buy: row.buy,
                sell: row.sell,
                net: row.net,
            });
        }
    }
    let mut hot: Vec<LhbHotMoneyTag> = buckets.into_values().collect();
    for tag in &mut hot {
        tag.seats.sort_by(|a, b| {
            b.net
                .partial_cmp(&a.net)
                .unwrap_or(Ordering::Equal)
                .then(a.id.cmp(&b.id))
        });
    }
    hot.sort_by(|a, b| {
        b.net
            .partial_cmp(&a.net)
            .unwrap_or(Ordering::Equal)
            .then(a.tag.cmp(&b.tag))
    });
    hot
}

fn parse_institutions(body: &Value) -> Vec<LhbInstitution> {
    first_array(body, &["List", "list"])
        .iter()
        .map(|item| LhbInstitution {
            code: stock_code(&item["ID"]),
            name: text(&item["Name"]),
            pct: pct(&item["IncreaseAmount"]),
            net_buy: num(&item["BuyIn"]),
            org_count: int(&item["JoinNum"]),
            turnover: num(&item["Turnover"]),
            turnover_rate: num(&item["TurnoverRatio"]),
            board: String::new(),
            sector: String::new(),
        })
        .collect()
}

fn parse_seats(value: &Value, ytd_buy: Option<&Value>, ytd_sell: Option<&Value>) -> Vec<LhbSeat> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| {
            let id = text(&item["ID"]);
            let name = text(&item["Name"]);
            let buy = num(&item["Buy"]);
            let sell = num(&item["Sell"]);
            let yday_buy = ytd_buy.and_then(|map| map.get(&id)).map(int).unwrap_or(0);
            let yday_sell = ytd_sell.and_then(|map| map.get(&id)).map(int).unwrap_or(0);
            LhbSeat {
                tags: yyz_tags::tags_for(&name)
                    .into_iter()
                    .map(|tag| tag.to_string())
                    .collect(),
                net: buy - sell,
                level: int(&item["YouZiIcon"]),
                assoc: int(&item["AssocIcon"]) == 1,
                yday_buy,
                yday_sell,
                id,
                name,
                buy,
                sell,
            }
        })
        .collect()
}

fn parse_detail(body: &Value, code: &str, date: &str) -> LhbDetail {
    let ytd_buy = body.get("ytdbusin").and_then(|root| root.get("buy"));
    let ytd_sell = body.get("ytdbusin").and_then(|root| root.get("sell"));
    let blocks: Vec<LhbReasonBlock> = first_array(body, &["List", "list"])
        .iter()
        .map(|block| LhbReasonBlock {
            reasons: array(block, "UpReason")
                .iter()
                .map(text)
                .filter(|reason| !reason.is_empty())
                .collect(),
            buy_total: num(&block["BuyTotal"]),
            sell_total: num(&block["SellTotal"]),
            buy: parse_seats(&block["BuyList"], ytd_buy, ytd_sell),
            sell: parse_seats(&block["SellList"], ytd_buy, ytd_sell),
        })
        .collect();
    let warning = if blocks.is_empty() {
        Some("该日期暂无该股上榜明细".to_string())
    } else {
        None
    };
    LhbDetail {
        code: code.to_string(),
        name: text(&body["Name"]),
        date: date.to_string(),
        pct: pct(&body["QuoteChange"]),
        turnover_rate: num(&body["TurnoverRatio"]),
        circulation: num(&body["Circulation"]),
        net_buy: num(&body["BuyIn"]),
        seat_count: int(&body["ToBusinessCount"]),
        on_time: first_array(body, &["OnTimeList"])
            .iter()
            .map(text)
            .map(|raw| ymd(&raw))
            .filter(|day| !day.is_empty())
            .collect(),
        blocks,
        source: "network".to_string(),
        fetched_at: 0,
        warning,
    }
}

fn parse_seat_log(body: &Value, seat_id: &str, days: i64) -> LhbSeatLog {
    let raw = first_array(body, &["list", "List"]);
    let total = raw.len();
    let rows: Vec<LhbSeatTrade> = raw
        .iter()
        .take(SEAT_LOG_LIMIT)
        .map(|item| {
            let buy = num(&item["Buy"]);
            let sell = num(&item["Sell"]);
            LhbSeatTrade {
                date: ymd(&text(&item["Time"])),
                code: stock_code(&item["StockID"]),
                name: text(&item["Name"]),
                pct: pct(&item["IncreaseAmount"]),
                buy,
                sell,
                net: buy - sell,
                three_day: text(&item["D3"]) == "1",
            }
        })
        .collect();
    LhbSeatLog {
        seat_id: seat_id.to_string(),
        truncated: total > rows.len(),
        total,
        warning: if rows.is_empty() {
            Some("该席位近期无上榜记录".to_string())
        } else {
            None
        },
        rows,
        days,
        source: "network".to_string(),
        fetched_at: 0,
    }
}

/// 把东财涨停池的连板 / 板块 join 到行情行。
fn join_board_meta(rows: &mut [LhbStock], meta: &HashMap<String, (String, String)>) {
    for row in rows {
        if let Some((board, sector)) = meta.get(&row.code) {
            row.board = board.clone();
            row.sector = sector.clone();
        }
    }
}

/// 把东财涨停池的连板 / 板块 join 到机构行。
fn join_institution_meta(rows: &mut [LhbInstitution], meta: &HashMap<String, (String, String)>) {
    for row in rows {
        if let Some((board, sector)) = meta.get(&row.code) {
            row.board = board.clone();
            row.sector = sector.clone();
        }
    }
}

/* ————————————————— HTTP 抓取 ————————————————— */

fn now_ts() -> i64 {
    Utc::now().timestamp()
}

async fn fetch_json(client: &Client, url: &str, referer: &str) -> Result<Value> {
    let res = client
        .get(url)
        .header(reqwest::header::USER_AGENT, UA)
        .header(reqwest::header::REFERER, referer)
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .send()
        .await
        .with_context(|| format!("request lhb api · {}", &url[..url.len().min(120)]))?;
    let status = res.status();
    let bytes = res.bytes().await.context("read lhb response")?;
    if !status.is_success() {
        return Err(anyhow!("HTTP {} · lhb api", status.as_u16()));
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    serde_json::from_slice(body)
        .with_context(|| format!("parse lhb json · {}", &url[..url.len().min(120)]))
}

async fn fetch_board_page(
    client: &Client,
    compact: &str,
) -> Result<(Vec<LhbStock>, Option<String>)> {
    let url = format!(
        "{LHB_BASE}st=500&a=GetStockList&c=LongHuBang&Index=0&apiv=w34&Type=2&Time={compact}"
    );
    let body = fetch_json(client, &url, LHB_REFERER).await?;
    Ok((parse_board(&body), upstream_error(&body)))
}

async fn fetch_detail_body(client: &Client, code: &str, compact: &str) -> Result<Value> {
    let url = format!(
        "{LHB_BASE}apiv=w31&c=Stock&a=GetNewOneStockInfo&Type=0&Time={}&StockID={code}",
        dash_date(compact)
    );
    fetch_json(client, &url, LHB_REFERER).await
}

async fn fetch_agency_page(
    client: &Client,
    compact: &str,
    index: u8,
) -> Result<(Vec<LhbAgency>, Option<String>)> {
    let url = format!("{LHB_BASE}a=GetBusinessList&st=500&c=LongHuBang&Index={index}&apiv=w34&Type=0&Time={compact}");
    let body = fetch_json(client, &url, LHB_REFERER).await?;
    Ok((parse_agencies(&body), upstream_error(&body)))
}

async fn fetch_institution_page(
    client: &Client,
    compact: &str,
) -> Result<(Vec<LhbInstitution>, Option<String>)> {
    let url =
        format!("{LHB_BASE}a=GetAgencyListV2&st=500&apiv=w34&c=LongHuBang&Index=0&Time={compact}");
    let body = fetch_json(client, &url, LHB_REFERER).await?;
    Ok((parse_institutions(&body), upstream_error(&body)))
}

async fn fetch_seat_log_body(client: &Client, seat_id: &str, days: i64) -> Result<Value> {
    let url = format!(
        "{LHB_BASE}apiv=w31&c=Business&BusinessID={seat_id}&Time=12&st=500&a=GetNewDoStockLog&Index=0&Day={days}&Money=0&Order=2"
    );
    fetch_json(client, &url, LHB_REFERER).await
}

async fn fetch_zt_pool(
    client: &Client,
    compact: &str,
) -> Result<HashMap<String, (String, String)>> {
    let url = format!(
        "{EM_POOL_BASE}&date={compact}&_={}",
        Utc::now().timestamp_millis()
    );
    let body = fetch_json(client, &url, EM_REFERER).await?;
    Ok(parse_zt_pool(&body))
}

/// 东财涨停池补充数据（连板文案 + 板块），board / institutions 共用短缓存。
async fn zt_pool(
    client: &Client,
    compact: &str,
    refresh: bool,
) -> Result<HashMap<String, (String, String)>> {
    if !refresh {
        if let Some(meta) = cache_read(&ZT_CACHE, compact, META_TTL) {
            return Ok(meta);
        }
    }
    let meta = fetch_zt_pool(client, compact).await?;
    cache_write(&ZT_CACHE, compact.to_string(), &meta);
    Ok(meta)
}

/* ————————————————— 进程内缓存 ————————————————— */

type Cache<T> = OnceLock<Mutex<HashMap<String, (i64, T)>>>;

static BOARD_CACHE: Cache<LhbBoard> = OnceLock::new();
static DETAIL_CACHE: Cache<LhbDetail> = OnceLock::new();
static AGENCY_CACHE: Cache<LhbAgencies> = OnceLock::new();
static INSTITUTION_CACHE: Cache<LhbInstitutions> = OnceLock::new();
static SEAT_CACHE: Cache<LhbSeatLog> = OnceLock::new();
static ZT_CACHE: Cache<HashMap<String, (String, String)>> = OnceLock::new();

fn cache_read<T: Clone>(cell: &'static Cache<T>, key: &str, ttl: i64) -> Option<T> {
    let mut map = cell
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?;
    let expired = match map.get(key) {
        Some((stored_at, _)) => now_ts() - *stored_at > ttl,
        None => return None,
    };
    if expired {
        map.remove(key);
        return None;
    }
    map.get(key).map(|(_, value)| value.clone())
}

fn cache_write<T: Clone>(cell: &'static Cache<T>, key: String, value: &T) {
    let Ok(mut map) = cell.get_or_init(|| Mutex::new(HashMap::new())).lock() else {
        return;
    };
    // 简单上限：超过 64 条时丢掉一小时前的旧值，长时间运行也不会无限增长。
    if map.len() > 64 {
        let cutoff = now_ts() - 3600;
        map.retain(|_, (stored_at, _)| *stored_at >= cutoff);
    }
    map.insert(key, (now_ts(), value.clone()));
}

/* ————————————————— 对外入口（commands 调用） ————————————————— */

/// 行情列表。请求日无数据时向前逐日探测（跳过周末，最多 10 次），
/// 命中后返回 `date=命中日` + `fallback=true`。
pub async fn board(client: &Client, date: &str, refresh: bool) -> Result<LhbBoard> {
    let requested = compact_date(date);
    if !refresh {
        if let Some(mut cached) = cache_read(&BOARD_CACHE, &requested, BOARD_TTL) {
            cached.source = "cache".to_string();
            return Ok(cached);
        }
    }
    let mut day = requested.clone();
    let mut rows = Vec::new();
    let mut last_error = None;
    for _ in 0..BOARD_PROBE_LIMIT {
        let (page, error) = fetch_board_page(client, &day).await?;
        rows = page;
        last_error = error;
        if !rows.is_empty() {
            break;
        }
        match previous_trade_day(&day) {
            Some(prev) => day = prev,
            None => break,
        }
    }
    let fetched_at = now_ts();
    if rows.is_empty() {
        return Ok(LhbBoard {
            requested_date: requested.clone(),
            date: requested,
            fallback: false,
            rows,
            source: "network".to_string(),
            fetched_at,
            warning: empty_warning(
                "该日期暂无龙虎榜数据 · ",
                last_error,
                "该日期暂无龙虎榜数据",
            ),
        });
    }
    let fallback = day != requested;
    match zt_pool(client, &day, refresh).await {
        Ok(meta) => join_board_meta(&mut rows, &meta),
        Err(e) => eprintln!("lhb zt pool join skipped: {e:#}"),
    }
    let result = LhbBoard {
        requested_date: requested.clone(),
        date: day,
        fallback,
        rows,
        source: "network".to_string(),
        fetched_at,
        warning: None,
    };
    cache_write(&BOARD_CACHE, requested, &result);
    Ok(result)
}

/// 个股上榜明细。日期为空时直接给 warning，不自行回退（回退由前端处理）。
pub async fn detail(client: &Client, code: &str, date: &str, refresh: bool) -> Result<LhbDetail> {
    let code = code.trim().to_string();
    if code.is_empty() {
        return Err(anyhow!("股票代码不能为空"));
    }
    let date = compact_date(date);
    let key = format!("{code}:{date}");
    if !refresh {
        if let Some(mut cached) = cache_read(&DETAIL_CACHE, &key, DETAIL_TTL) {
            cached.source = "cache".to_string();
            return Ok(cached);
        }
    }
    let body = fetch_detail_body(client, &code, &date).await?;
    let mut result = parse_detail(&body, &code, &date);
    result.fetched_at = now_ts();
    if !result.blocks.is_empty() {
        cache_write(&DETAIL_CACHE, key, &result);
    }
    Ok(result)
}

/// 席位榜（按净额降序）+ 按游资名号聚合的 hot 榜。
pub async fn agencies(client: &Client, date: &str, refresh: bool) -> Result<LhbAgencies> {
    let date = compact_date(date);
    if !refresh {
        if let Some(mut cached) = cache_read(&AGENCY_CACHE, &date, AGENCY_TTL) {
            cached.source = "cache".to_string();
            return Ok(cached);
        }
    }
    let (mut rows, first_error) = fetch_agency_page(client, &date, 0).await?;
    if rows.len() >= 500 {
        match fetch_agency_page(client, &date, 1).await {
            Ok((more, _)) => {
                let mut seen: HashSet<String> = rows.iter().map(|row| row.id.clone()).collect();
                for row in more {
                    if seen.insert(row.id.clone()) {
                        rows.push(row);
                    }
                }
            }
            Err(e) => eprintln!("lhb agencies page 2 skipped: {e:#}"),
        }
    }
    rows.sort_by(|a, b| {
        b.net
            .partial_cmp(&a.net)
            .unwrap_or(Ordering::Equal)
            .then(a.id.cmp(&b.id))
    });
    let hot = build_hot(&rows);
    let warning = if rows.is_empty() {
        empty_warning("席位榜：", first_error, "该日期暂无席位数据")
    } else {
        None
    };
    let result = LhbAgencies {
        date: date.clone(),
        rows,
        hot,
        source: "network".to_string(),
        fetched_at: now_ts(),
        warning,
    };
    if !result.rows.is_empty() {
        cache_write(&AGENCY_CACHE, date, &result);
    }
    Ok(result)
}

/// 机构榜（按净买入降序），连板 / 板块用东财涨停池补充。
pub async fn institutions(client: &Client, date: &str, refresh: bool) -> Result<LhbInstitutions> {
    let date = compact_date(date);
    if !refresh {
        if let Some(mut cached) = cache_read(&INSTITUTION_CACHE, &date, INSTITUTION_TTL) {
            cached.source = "cache".to_string();
            return Ok(cached);
        }
    }
    let (mut rows, upstream) = fetch_institution_page(client, &date).await?;
    match zt_pool(client, &date, refresh).await {
        Ok(meta) => join_institution_meta(&mut rows, &meta),
        Err(e) => eprintln!("lhb zt pool join skipped: {e:#}"),
    }
    rows.sort_by(|a, b| {
        b.net_buy
            .partial_cmp(&a.net_buy)
            .unwrap_or(Ordering::Equal)
            .then(a.code.cmp(&b.code))
    });
    let warning = if rows.is_empty() {
        empty_warning("机构榜：", upstream, "该日期暂无机构数据")
    } else {
        None
    };
    let result = LhbInstitutions {
        date: date.clone(),
        rows,
        source: "network".to_string(),
        fetched_at: now_ts(),
        warning,
    };
    if !result.rows.is_empty() {
        cache_write(&INSTITUTION_CACHE, date, &result);
    }
    Ok(result)
}

/// 单个席位最近 N 天（默认 30 / 上限 90）的上榜记录，最多 200 条。
pub async fn seat_log(client: &Client, seat_id: &str, days: i64) -> Result<LhbSeatLog> {
    let seat_id = seat_id.trim().to_string();
    if seat_id.is_empty() {
        return Err(anyhow!("席位 ID 不能为空"));
    }
    let days = if days <= 0 { 30 } else { days.min(90) };
    let key = format!("{seat_id}:{days}");
    if let Some(mut cached) = cache_read(&SEAT_CACHE, &key, SEAT_TTL) {
        cached.source = "cache".to_string();
        return Ok(cached);
    }
    let body = fetch_seat_log_body(client, &seat_id, days).await?;
    let upstream = upstream_error(&body);
    let mut result = parse_seat_log(&body, &seat_id, days);
    result.fetched_at = now_ts();
    if result.rows.is_empty() {
        result.warning = empty_warning("席位记录：", upstream, "该席位近期无上榜记录");
    }
    if !result.rows.is_empty() {
        cache_write(&SEAT_CACHE, key, &result);
    }
    Ok(result)
}

/* ————————————————— 测试 ————————————————— */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 真实 `GetStockList` 响应截断（2026-11-23）。
    const BOARD_FIXTURE: &str = r#"{"Time":"2026-11-23","UserType":0,"list":[
{"ID":"000530","Name":"冰山冷热","IncreaseAmount":"10.01%","D3":"1","BuyIn":"-138783382","JoinNum":7,"Turnover":"2888876890","CircPrice":8113578122,"Amplitude":"12.37","TurnoverRatio":"37.31","Capitalization":11400233094.64},
{"ID":"002148","Name":"北纬科技","IncreaseAmount":"10.04%","D3":"0","BuyIn":"11935942","JoinNum":2,"Turnover":"1951307679","CircPrice":4992864583.77,"Amplitude":"9.54","TurnoverRatio":"40.5","Capitalization":6185377223.1}]}"#;

    /// 真实东财涨停池响应截断（2026-11-23，字段保留连板 / 板块 / zttj）。
    const EM_FIXTURE: &str = r#"{"rc":0,"rt":110,"data":{"tc":3,"qdate":20261124,"pool":[
{"c":"002086","m":0,"n":"东方海洋","lbc":2,"hybk":"农产品加","zttj":{"days":18,"ct":9}},
{"c":"002771","m":0,"n":"真视通","lbc":5,"hybk":"IT服务Ⅱ","zttj":{"days":5,"ct":5}},
{"c":"002036","m":0,"n":"联创电子","lbc":1,"hybk":"光学光电","zttj":{"days":1,"ct":1}}]}}"#;

    /// 真实个股明细响应截断（000530 冰山冷热 / 2026-11-23，席位字段保留前端用到的部分）。
    const DETAIL_FIXTURE: &str = r#"{"Name":"冰山冷热","Time":"2026-11-23","KlineDay":{"S":"2026-11-19","E":"2026-11-23"},"OnTimeList":["2026-11-23","2026-11-20","2026-11-19"],"ToBusinessCount":"7","QuoteChange":"10.01%","TurnoverRatio":"37.31","Circulation":"81.14","BuyIn":-138783382,"ytdbusin":{"sell":{"7710":4,"17276":1},"buy":{"7710":1,"20071":4}},"List":[{"BuyList":[
{"ID":"896","Name":"机构专用","Buy":"157797709","Sell":"49815977","PX":"1","YouZiIcon":0,"AssocIcon":0},
{"ID":"17276","Name":"国信证券浙江互联网分公司","Buy":"45766908","Sell":"31398060","PX":"2","YouZiIcon":1,"AssocIcon":0}],"SellList":[
{"ID":"7710","Name":"东莞证券南京分公司","Buy":"2242661","Sell":"130942203","PX":"1","YouZiIcon":0,"AssocIcon":1},
{"ID":"1162","Name":"东方证券杭州龙井路","Buy":"14518660","Sell":"74905085","PX":"2","YouZiIcon":2,"AssocIcon":0}],"UpReason":["日涨幅偏离值达7%","日换手率达20%"],"BuyTotal":330359653,"SellTotal":469143035}]}"#;

    /// 真实 `GetBusinessList` 响应截断（2026-11-23）。
    const AGENCIES_FIXTURE: &str = r#"{"list":[
{"ID":"20855","Name":"国泰海通证券总部","Buy":"570100205.6700001","Sell":"387252557.42","JoinNum":29},
{"ID":"18776","Name":"高盛(中国)证券上海浦东新区世纪大道","Buy":"347246533.63","Sell":"319926023.28","JoinNum":16},
{"ID":"1162","Name":"东方证券杭州龙井路","Buy":"14518660","Sell":"74905085","JoinNum":6},
{"ID":"20071","Name":"国新证券北京分公司","Buy":"320238233.78","Sell":"484941462.13","JoinNum":14}],"Total":4,"Time":"2026-11-23"}"#;

    /// 真实 `GetAgencyListV2` 响应截断（2026-11-23，ID 是数字）。
    const INSTITUTIONS_FIXTURE: &str = r#"{"List":[
{"ID":688836,"CircPrice":"21302105760","Capitalization":"286360752720","Day":"2026-11-23","BuyIn":125479200,"JoinNum":1,"IncreaseAmount":"20.00%","Turnover":"4676979088","TurnoverRatio":"23.99","Name":"宇树科技"},
{"ID":688787,"CircPrice":"6261753684","Capitalization":"6261753684","Day":"2026-11-23","BuyIn":8072400,"JoinNum":2,"IncreaseAmount":"20.00%","Turnover":"892103525","TurnoverRatio":"15.56","Name":"海天瑞声"}],"Day":"2026-11-23"}"#;

    /// 真实 `GetNewDoStockLog` 响应截断（BID 20855 / 2026-11-23）。
    const SEAT_LOG_FIXTURE: &str = r#"{"list":[
{"LogID":"2026112360557712120855","StockID":605577,"IncreaseAmount":"10.01%","D3":"1","Buy":0,"Sell":"57907773.5","Type":"2","Time":"2026-11-23","BID":"20855","Money":57907773.5,"Name":"龙版传媒"},
{"LogID":"2026112360557711220855","StockID":605577,"IncreaseAmount":"10.01%","D3":"1","Buy":"49615096","Sell":0,"Type":"1","Time":"2026-11-23","BID":"20855","Money":49615096,"Name":"龙版传媒"},
{"LogID":"2026112360501812220855","StockID":605018,"IncreaseAmount":"10.04%","D3":"1","Buy":0,"Sell":"13592869","Type":"2","Time":"2026-11-23","BID":"20855","Money":13592869,"Name":"长华集团"}]}"#;

    #[test]
    fn parse_board_rows() {
        let body: Value = serde_json::from_str(BOARD_FIXTURE).unwrap();
        let rows = parse_board(&body);
        assert_eq!(rows.len(), 2);
        let first = &rows[0];
        assert_eq!(first.code, "000530");
        assert_eq!(first.name, "冰山冷热");
        assert!((first.pct - 10.01).abs() < 1e-9);
        assert_eq!(first.net_buy, -138_783_382.0);
        assert_eq!(first.seats, 7);
        assert_eq!(first.turnover, 2_888_876_890.0);
        assert!((first.turnover_rate - 37.31).abs() < 1e-9);
        assert_eq!(first.float_cap, 8_113_578_122.0);
        assert!((first.market_cap - 11_400_233_094.64).abs() < 1e-6);
        assert!(first.board.is_empty() && first.sector.is_empty());
        assert_eq!(rows[1].code, "002148");
        assert_eq!(rows[1].seats, 2);
    }

    #[test]
    fn parse_board_empty_and_zt_pool_join() {
        let empty: Value = serde_json::from_str(r#"{"errcode":"0","Status":{}}"#).unwrap();
        assert!(parse_board(&empty).is_empty());

        let pool: Value = serde_json::from_str(EM_FIXTURE).unwrap();
        let meta = parse_zt_pool(&pool);
        assert_eq!(meta.get("002086").map(|(b, _)| b.as_str()), Some("9天2板"));
        assert_eq!(
            meta.get("002086").map(|(_, s)| s.as_str()),
            Some("农产品加")
        );
        assert_eq!(meta.get("002771").map(|(b, _)| b.as_str()), Some("5板"));
        assert_eq!(meta.get("002036").map(|(b, _)| b.as_str()), Some("首板"));
        assert_eq!(meta.get("002771").map(|(_, s)| s.as_str()), Some("IT服务Ⅱ"));

        let body: Value = serde_json::from_str(BOARD_FIXTURE).unwrap();
        let mut rows = parse_board(&body);
        rows.push(parse_board_row(&json!({"ID":"002086","Name":"东方海洋"})));
        join_board_meta(&mut rows, &meta);
        assert_eq!(rows[0].board, "");
        assert_eq!(rows[2].board, "9天2板");
        assert_eq!(rows[2].sector, "农产品加");
    }

    #[test]
    fn parse_detail_with_tags() {
        let body: Value = serde_json::from_str(DETAIL_FIXTURE).unwrap();
        let detail = parse_detail(&body, "000530", "20261123");
        assert_eq!(detail.code, "000530");
        assert_eq!(detail.name, "冰山冷热");
        assert_eq!(detail.date, "20261123");
        assert!((detail.pct - 10.01).abs() < 1e-9);
        assert!((detail.turnover_rate - 37.31).abs() < 1e-9);
        assert!((detail.circulation - 81.14).abs() < 1e-9);
        assert_eq!(detail.net_buy, -138_783_382.0);
        assert_eq!(detail.seat_count, 7);
        assert_eq!(detail.on_time, vec!["20261123", "20261120", "20261119"]);
        assert!(detail.warning.is_none());
        assert_eq!(detail.blocks.len(), 1);

        let block = &detail.blocks[0];
        assert_eq!(block.reasons, vec!["日涨幅偏离值达7%", "日换手率达20%"]);
        assert_eq!(block.buy_total, 330_359_653.0);
        assert_eq!(block.sell_total, 469_143_035.0);
        assert_eq!(block.buy.len(), 2);
        assert_eq!(block.sell.len(), 2);

        // 买席：机构专用精确命中；国信证券浙江互联网分公司命中两个名号。
        assert!(block.buy[0].tags.iter().any(|tag| tag == "机构专用"));
        assert!(block.buy[1].tags.iter().any(|tag| tag == "砸盘王"));
        assert!(block.buy[1].tags.iter().any(|tag| tag == "量化席位"));
        assert_eq!(block.buy[1].level, 1);
        assert!((block.buy[1].net - (45_766_908.0 - 31_398_060.0)).abs() < 1e-6);

        // 卖席：东莞证券南京分公司（玉兰路）+ 昨日买卖次数；东方证券杭州龙井路走归一化命中章盟主。
        assert!(block.sell[0].tags.iter().any(|tag| tag == "玉兰路"));
        assert!(block.sell[0].assoc);
        assert_eq!(block.sell[0].yday_buy, 1);
        assert_eq!(block.sell[0].yday_sell, 4);
        assert!(block.sell[1].tags.iter().any(|tag| tag == "章盟主"));
        assert_eq!(block.sell[1].level, 2);
        assert!((block.sell[1].net - (14_518_660.0 - 74_905_085.0)).abs() < 1e-6);
    }

    #[test]
    fn parse_detail_empty_gets_warning() {
        let body: Value = serde_json::from_str(r#"{"tag":"lv2","errcode":"0"}"#).unwrap();
        let detail = parse_detail(&body, "600519", "20261123");
        assert!(detail.blocks.is_empty());
        assert!(detail.on_time.is_empty());
        assert_eq!(detail.warning.as_deref(), Some("该日期暂无该股上榜明细"));
    }

    #[test]
    fn parse_agencies_and_hot() {
        let body: Value = serde_json::from_str(AGENCIES_FIXTURE).unwrap();
        let mut rows = parse_agencies(&body);
        assert_eq!(rows.len(), 4);
        assert!(rows[0].tags.iter().any(|tag| tag == "超级小号"));
        assert!(rows[0].tags.iter().any(|tag| tag == "量化席位"));
        assert_eq!(rows[0].join_count, 29);
        // 接口给的简称与库里的全名只差公司后缀 / 括号，归一化后仍要命中。
        assert!(rows[1].tags.iter().any(|tag| tag == "外资游资"));
        assert!(rows[2].tags.iter().any(|tag| tag == "章盟主"));
        assert!(rows[3].tags.iter().any(|tag| tag == "砸盘王"));

        rows.sort_by(|a, b| {
            b.net
                .partial_cmp(&a.net)
                .unwrap_or(Ordering::Equal)
                .then(a.id.cmp(&b.id))
        });
        assert_eq!(rows[0].id, "20855");
        assert!(rows[0].net > 0.0);

        let hot = build_hot(&rows);
        assert_eq!(hot.len(), 5);
        let tags: Vec<&str> = hot.iter().map(|item| item.tag.as_str()).collect();
        assert_eq!(
            tags,
            vec!["量化席位", "超级小号", "外资游资", "章盟主", "砸盘王"]
        );
        let quant = &hot[0];
        assert_eq!(quant.seats.len(), 2);
        assert_eq!(quant.seats[0].id, "20855");
        assert!(quant.seats[0].net >= quant.seats[1].net);
        assert!((quant.net - (quant.seats[0].net + quant.seats[1].net)).abs() < 1e-6);
        assert!((quant.buy - (570_100_205.670_000_1 + 347_246_533.63)).abs() < 1e-6);

        let empty: Value = serde_json::from_str(r#"{"list":[],"Total":0}"#).unwrap();
        assert!(build_hot(&parse_agencies(&empty)).is_empty());
    }

    #[test]
    fn parse_institutions_rows() {
        let body: Value = serde_json::from_str(INSTITUTIONS_FIXTURE).unwrap();
        let rows = parse_institutions(&body);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].code, "688836");
        assert_eq!(rows[0].name, "宇树科技");
        assert!((rows[0].pct - 20.0).abs() < 1e-9);
        assert_eq!(rows[0].net_buy, 125_479_200.0);
        assert_eq!(rows[0].org_count, 1);
        assert_eq!(rows[0].turnover, 4_676_979_088.0);
        assert!((rows[0].turnover_rate - 23.99).abs() < 1e-9);
        assert!(rows[0].board.is_empty() && rows[0].sector.is_empty());
        assert_eq!(rows[1].code, "688787");
    }

    #[test]
    fn parse_seat_log_rows() {
        let body: Value = serde_json::from_str(SEAT_LOG_FIXTURE).unwrap();
        let log = parse_seat_log(&body, "20855", 30);
        assert_eq!(log.seat_id, "20855");
        assert_eq!(log.days, 30);
        assert!(log.warning.is_none());
        assert_eq!(log.rows.len(), 3);
        let first = &log.rows[0];
        assert_eq!(first.date, "20261123");
        assert_eq!(first.code, "605577");
        assert_eq!(first.name, "龙版传媒");
        assert!((first.pct - 10.01).abs() < 1e-9);
        assert_eq!(first.net, -57_907_773.5);
        assert_eq!(log.rows[1].net, 49_615_096.0);
        assert_eq!(log.rows[2].code, "605018");

        let empty: Value = serde_json::from_str(
            r#"{"errcode":"9999","errmsg":"营业部上榜数据暂不可用，请稍后重试"}"#,
        )
        .unwrap();
        let empty_log = parse_seat_log(&empty, "999999", 30);
        assert!(empty_log.rows.is_empty());
        assert_eq!(empty_log.warning.as_deref(), Some("该席位近期无上榜记录"));
    }

    #[test]
    fn parse_seat_log_caps_at_200() {
        let list: Vec<Value> = (0..205)
            .map(|i| {
                json!({
                    "StockID": 600000 + i,
                    "IncreaseAmount": "1.00%",
                    "Buy": "100",
                    "Sell": "50",
                    "Time": "2026-11-23",
                    "Name": "测试",
                })
            })
            .collect();
        let body = json!({"list": list});
        let log = parse_seat_log(&body, "1", 30);
        assert_eq!(log.rows.len(), 200);
    }

    #[test]
    fn date_helpers() {
        assert_eq!(compact_date("2026-11-23"), "20261123");
        assert_eq!(compact_date("20261123"), "20261123");
        assert_eq!(dash_date("20261123"), "2026-11-23");
        assert_eq!(previous_trade_day("20261123").as_deref(), Some("20261120"));
        assert_eq!(previous_trade_day("20261122").as_deref(), Some("20261120"));
        assert_eq!(previous_trade_day("20261121").as_deref(), Some("20261120"));
        assert_eq!(ymd("2026-11-23"), "20261123");
        assert_eq!(ymd("bad"), "");
        assert_eq!(stock_code(&json!(530)), "000530");
        assert_eq!(stock_code(&json!("000530")), "000530");
    }

    #[test]
    fn upstream_error_extraction() {
        // 上游限流 / 异常时的裸 body。
        let rate_limited: Value = serde_json::from_str(
            r#"{"errcode":"9999","errmsg":"营业部上榜数据暂不可用，请稍后重试"}"#,
        )
        .unwrap();
        assert_eq!(
            upstream_error(&rate_limited).as_deref(),
            Some("营业部上榜数据暂不可用，请稍后重试")
        );
        // 正常响应（明细空态也长这样）。
        let ok: Value = serde_json::from_str(r#"{"tag":"lv2","errcode":"0","t":0.05}"#).unwrap();
        assert!(upstream_error(&ok).is_none());
        // 只有错误码、没有文案：不冒充上游文案，交给兜底 warning。
        let code_only: Value = serde_json::from_str(r#"{"errcode":"9999"}"#).unwrap();
        assert!(upstream_error(&code_only).is_none());
        // 错误码 + 空 errmsg：至少把错误码带出去。
        let empty_msg: Value = serde_json::from_str(r#"{"errcode":"9999","errmsg":""}"#).unwrap();
        assert_eq!(
            upstream_error(&empty_msg).as_deref(),
            Some("上游错误码 9999")
        );
    }

    #[test]
    fn empty_warning_keeps_upstream_message() {
        let err = Some("营业部上榜数据暂不可用，请稍后重试".to_string());
        assert_eq!(
            empty_warning("席位榜：", err.clone(), "该日期暂无席位数据").as_deref(),
            Some("席位榜：营业部上榜数据暂不可用，请稍后重试")
        );
        assert_eq!(
            empty_warning("该日期暂无龙虎榜数据 · ", err, "该日期暂无龙虎榜数据").as_deref(),
            Some("该日期暂无龙虎榜数据 · 营业部上榜数据暂不可用，请稍后重试")
        );
        // 没有 errmsg 时保持原兜底文案。
        assert_eq!(
            empty_warning("机构榜：", None, "该日期暂无机构数据").as_deref(),
            Some("该日期暂无机构数据")
        );
        assert_eq!(
            empty_warning("席位记录：", Some("x".to_string()), "该席位近期无上榜记录").as_deref(),
            Some("席位记录：x")
        );
    }

    #[test]
    fn cache_round_trip_and_ttl() {
        let key = "cache-round-trip:20261123".to_string();
        assert!(cache_read(&BOARD_CACHE, &key, 300).is_none());
        let value = LhbBoard {
            requested_date: "20261123".to_string(),
            date: "20261123".to_string(),
            fallback: false,
            rows: Vec::new(),
            source: "network".to_string(),
            fetched_at: 1,
            warning: None,
        };
        cache_write(&BOARD_CACHE, key.clone(), &value);
        let hit = cache_read(&BOARD_CACHE, &key, 300).expect("cache hit");
        assert_eq!(hit.requested_date, "20261123");
        assert!(cache_read(&BOARD_CACHE, &key, -1).is_none());
    }

    /// 真实网络探针：`cargo test --lib -- --ignored probe_live_lhb --nocapture`。
    /// 默认忽略，不影响常规测试与离线构建。
    #[test]
    #[ignore = "需要外网：真实请求 5 个龙虎榜接口"]
    fn probe_live_lhb() {
        tauri::async_runtime::block_on(async {
            let client = crate::source::client().expect("http client");
            let today = db::today_ymd();

            let board = board(&client, &today, true).await.expect("board");
            assert!(!board.rows.is_empty(), "board rows empty");
            let sample = &board.rows[0];
            println!(
                "[probe] board OK requested={} date={} fallback={} rows={} sample={} {} pct={} netBuy={} seats={}",
                board.requested_date,
                board.date,
                board.fallback,
                board.rows.len(),
                sample.code,
                sample.name,
                sample.pct,
                sample.net_buy,
                sample.seats
            );

            let mut detail_hit = None;
            for row in board.rows.iter().take(3) {
                let candidate = detail(&client, &row.code, &board.date, true)
                    .await
                    .expect("detail");
                let tagged_count = candidate
                    .blocks
                    .iter()
                    .flat_map(|block| block.buy.iter().chain(block.sell.iter()))
                    .filter(|seat| !seat.tags.is_empty())
                    .count();
                if tagged_count >= 2 {
                    detail_hit = Some(candidate);
                    break;
                }
            }
            let detail = detail_hit.expect("no detail with >= 2 tagged seats");
            let tagged: Vec<&LhbSeat> = detail
                .blocks
                .iter()
                .flat_map(|block| block.buy.iter().chain(block.sell.iter()))
                .filter(|seat| !seat.tags.is_empty())
                .collect();
            let seat_total: usize = detail
                .blocks
                .iter()
                .map(|block| block.buy.len() + block.sell.len())
                .sum();
            println!(
                "[probe] detail OK code={} name={} date={} blocks={} onTime={} seats={} taggedSeats={}",
                detail.code,
                detail.name,
                detail.date,
                detail.blocks.len(),
                detail.on_time.len(),
                seat_total,
                tagged.len()
            );
            for seat in tagged.iter().take(3) {
                println!(
                    "[probe] detail seat {} {} level={} net={} tags={:?} yday={}/{}",
                    seat.id,
                    seat.name,
                    seat.level,
                    seat.net,
                    seat.tags,
                    seat.yday_buy,
                    seat.yday_sell
                );
            }

            let agencies = agencies(&client, &board.date, true)
                .await
                .expect("agencies");
            assert!(!agencies.rows.is_empty(), "agencies rows empty");
            let first_tagged = agencies
                .rows
                .iter()
                .find(|row| !row.tags.is_empty())
                .expect("no tagged agency");
            println!(
                "[probe] agencies OK date={} rows={} hot={} sample={} {} net={} tags={:?}",
                agencies.date,
                agencies.rows.len(),
                agencies.hot.len(),
                first_tagged.id,
                first_tagged.name,
                first_tagged.net,
                first_tagged.tags
            );

            let institutions = institutions(&client, &board.date, true)
                .await
                .expect("institutions");
            assert!(!institutions.rows.is_empty(), "institution rows empty");
            let inst = &institutions.rows[0];
            println!(
                "[probe] institutions OK date={} rows={} sample={} {} netBuy={} orgCount={} board={} sector={}",
                institutions.date,
                institutions.rows.len(),
                inst.code,
                inst.name,
                inst.net_buy,
                inst.org_count,
                inst.board,
                inst.sector
            );

            let log = seat_log(&client, &first_tagged.id, 30)
                .await
                .expect("seat log");
            assert!(!log.rows.is_empty(), "seat log rows empty");
            let trade = &log.rows[0];
            println!(
                "[probe] seatlog OK seatId={} days={} rows={} sample={} {} {} pct={} buy={} sell={} net={}",
                log.seat_id,
                log.days,
                log.rows.len(),
                trade.date,
                trade.code,
                trade.name,
                trade.pct,
                trade.buy,
                trade.sell,
                trade.net
            );

            // 上游错误体（不存在的席位 ID）应把 errmsg 带进 warning，而不是只回空数组。
            let missing = seat_log(&client, "999999", 30)
                .await
                .expect("seat log missing seat");
            println!(
                "[probe] seatlog empty OK rows={} warning={:?}",
                missing.rows.len(),
                missing.warning
            );
        });
    }
}
