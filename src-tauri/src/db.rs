use std::collections::HashMap;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::models::*;

pub fn connect(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path).with_context(|| format!("open db {}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

pub fn init(path: &Path) -> Result<()> {
    let conn = connect(path)?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS trade_days (
            date TEXT PRIMARY KEY,
            is_trade INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS day_snapshot (
            date TEXT PRIMARY KEY,
            fetched_at INTEGER NOT NULL,
            total INTEGER NOT NULL DEFAULT 0,
            consecutive INTEGER NOT NULL DEFAULT 0,
            first_board INTEGER NOT NULL DEFAULT 0,
            max_streak INTEGER NOT NULL DEFAULT 0,
            one_word INTEGER NOT NULL DEFAULT 0,
            early_seal INTEGER NOT NULL DEFAULT 0,
            avg_seal REAL NOT NULL DEFAULT 0,
            avg_success REAL NOT NULL DEFAULT 0,
            open_limit INTEGER NOT NULL DEFAULT 0,
            limit_down INTEGER NOT NULL DEFAULT 0,
            source_total INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS pool_aux (
            date TEXT NOT NULL,
            pool TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            price REAL NOT NULL DEFAULT 0,
            change_rate REAL NOT NULL DEFAULT 0,
            turnover_rate REAL NOT NULL DEFAULT 0,
            amount REAL NOT NULL DEFAULT 0,
            seal_amount REAL NOT NULL DEFAULT 0,
            first_seal INTEGER NOT NULL DEFAULT 0,
            last_seal INTEGER NOT NULL DEFAULT 0,
            open_num INTEGER NOT NULL DEFAULT 0,
            limit_type TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            market TEXT NOT NULL DEFAULT '',
            market_id INTEGER NOT NULL DEFAULT 0,
            success_rate REAL NOT NULL DEFAULT 0,
            float_cap REAL NOT NULL DEFAULT 0,
            is_new INTEGER NOT NULL DEFAULT 0,
            is_again_limit INTEGER NOT NULL DEFAULT 0,
            high_days TEXT NOT NULL DEFAULT '',
            board INTEGER NOT NULL DEFAULT 0,
            days INTEGER NOT NULL DEFAULT 0,
            streak INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date, pool, code)
        );

        CREATE TABLE IF NOT EXISTS pool_aux_tick (
            date TEXT NOT NULL,
            pool TEXT NOT NULL,
            code TEXT NOT NULL,
            seq INTEGER NOT NULL,
            pct REAL NOT NULL,
            PRIMARY KEY (date, pool, code, seq)
        );

        CREATE TABLE IF NOT EXISTS watch_group (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS watch_stock (
            group_id INTEGER NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            market TEXT NOT NULL DEFAULT '',
            added_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (group_id, code),
            FOREIGN KEY (group_id) REFERENCES watch_group(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS limit_up (
            date TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            board INTEGER NOT NULL,
            days INTEGER NOT NULL,
            streak INTEGER NOT NULL,
            high_days TEXT NOT NULL DEFAULT '',
            price REAL NOT NULL DEFAULT 0,
            change_rate REAL NOT NULL DEFAULT 0,
            turnover_rate REAL NOT NULL DEFAULT 0,
            amount REAL NOT NULL DEFAULT 0,
            seal_amount REAL NOT NULL DEFAULT 0,
            first_seal INTEGER NOT NULL DEFAULT 0,
            last_seal INTEGER NOT NULL DEFAULT 0,
            open_num INTEGER NOT NULL DEFAULT 0,
            limit_type TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            market TEXT NOT NULL DEFAULT '',
            market_id INTEGER NOT NULL DEFAULT 0,
            success_rate REAL NOT NULL DEFAULT 0,
            float_cap REAL NOT NULL DEFAULT 0,
            is_new INTEGER NOT NULL DEFAULT 0,
            is_again_limit INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date, code)
        );

        CREATE TABLE IF NOT EXISTS limit_up_tick (
            date TEXT NOT NULL,
            code TEXT NOT NULL,
            seq INTEGER NOT NULL,
            pct REAL NOT NULL,
            PRIMARY KEY (date, code, seq)
        );

        CREATE TABLE IF NOT EXISTS sectors (
            date TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            change REAL NOT NULL DEFAULT 0,
            limit_up_num INTEGER NOT NULL DEFAULT 0,
            continuous_num INTEGER NOT NULL DEFAULT 0,
            high_days TEXT NOT NULL DEFAULT '',
            days INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date, code)
        );

        CREATE TABLE IF NOT EXISTS sector_members (
            date TEXT NOT NULL,
            sector_code TEXT NOT NULL,
            stock_code TEXT NOT NULL,
            PRIMARY KEY (date, sector_code, stock_code)
        );

        CREATE TABLE IF NOT EXISTS stocks (
            code TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            market TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS search_history (
            code TEXT PRIMARY KEY,
            seen_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS klines (
            code TEXT NOT NULL,
            period TEXT NOT NULL,
            date TEXT NOT NULL,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL NOT NULL DEFAULT 0,
            amount REAL NOT NULL DEFAULT 0,
            pct REAL NOT NULL DEFAULT 0,
            turnover REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (code, period, date)
        );

        CREATE TABLE IF NOT EXISTS kline_meta (
            code TEXT NOT NULL,
            period TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            fetched_at INTEGER NOT NULL,
            last_date TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (code, period)
        );

        CREATE TABLE IF NOT EXISTS index_daily (
            code TEXT NOT NULL,
            date TEXT NOT NULL,
            close REAL NOT NULL,
            pct REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (code, date)
        );

        CREATE INDEX IF NOT EXISTS idx_limit_up_streak ON limit_up (date, streak);
        CREATE INDEX IF NOT EXISTS idx_tick_date ON limit_up_tick (date, code);
        CREATE INDEX IF NOT EXISTS idx_sectors_date ON sectors (date, limit_up_num);
        "#,
    )?;
    conn.execute(
        "INSERT INTO settings(key, value) VALUES ('theme', 'dark') ON CONFLICT(key) DO NOTHING",
        [],
    )?;
    migrate(&conn)?;
    ensure_default_watch_group(&conn)?;
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let sql = format!("PRAGMA table_info({})", table);
    let Ok(mut st) = conn.prepare(&sql) else { return false };
    let Ok(rows) = st.query_map([], |r| r.get::<_, String>(1)) else { return false };
    for row in rows.flatten() {
        if row == column {
            return true;
        }
    }
    false
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM index_daily WHERE length(date) <= 10", [])?;
    let series_version: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key='index_series_v'", [], |r| r.get(0))
        .optional()?;
    if series_version.as_deref() != Some("3") {
        conn.execute("DELETE FROM index_daily", [])?;
        conn.execute(
            "INSERT INTO settings(key,value) VALUES ('index_series_v','3')
             ON CONFLICT(key) DO UPDATE SET value='3'",
            [],
        )?;
    }
    if !has_column(conn, "day_snapshot", "open_limit") {
        conn.execute("ALTER TABLE day_snapshot ADD COLUMN open_limit INTEGER NOT NULL DEFAULT 0", [])?;
    }
    if !has_column(conn, "day_snapshot", "limit_down") {
        conn.execute("ALTER TABLE day_snapshot ADD COLUMN limit_down INTEGER NOT NULL DEFAULT 0", [])?;
    }
    Ok(())
}

fn ensure_default_watch_group(conn: &Connection) -> Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM watch_group", [], |r| r.get(0))?;
    if count == 0 {
        conn.execute(
            "INSERT INTO watch_group(name, sort_order, created_at) VALUES ('我的自选', 0, ?1)",
            params![chrono::Utc::now().timestamp()],
        )?;
    }
    Ok(())
}

pub fn save_day(conn: &mut Connection, day: &DayPayload) -> Result<()> {
    let tx = conn.transaction()?;
    let date = &day.date;
    tx.execute("DELETE FROM day_snapshot WHERE date = ?1", params![date])?;
    tx.execute("DELETE FROM limit_up WHERE date = ?1", params![date])?;
    tx.execute("DELETE FROM limit_up_tick WHERE date = ?1", params![date])?;
    tx.execute("DELETE FROM sectors WHERE date = ?1", params![date])?;
    tx.execute("DELETE FROM sector_members WHERE date = ?1", params![date])?;
    tx.execute("DELETE FROM pool_aux WHERE date = ?1", params![date])?;
    tx.execute("DELETE FROM pool_aux_tick WHERE date = ?1", params![date])?;

    let s = &day.stats;
    tx.execute(
        r#"INSERT INTO day_snapshot
        (date, fetched_at, total, consecutive, first_board, max_streak, one_word, early_seal, avg_seal, avg_success, open_limit, limit_down, source_total)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)"#,
        params![
            date,
            day.fetched_at,
            s.total,
            s.consecutive,
            s.first_board,
            s.max_streak,
            s.one_word,
            s.early_seal,
            s.avg_seal,
            s.avg_success,
            s.open_limit,
            s.limit_down,
            day.stocks.len() as i64
        ],
    )?;

    {
        let mut st = tx.prepare(
            r#"INSERT INTO limit_up
            (date, code, name, board, days, streak, high_days, price, change_rate, turnover_rate,
             amount, seal_amount, first_seal, last_seal, open_num, limit_type, reason, market,
             market_id, success_rate, float_cap, is_new, is_again_limit)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)"#,
        )?;
        let mut tick = tx.prepare(
            "INSERT OR REPLACE INTO limit_up_tick (date, code, seq, pct) VALUES (?1,?2,?3,?4)",
        )?;
        let mut stock = tx.prepare(
            "INSERT INTO stocks(code, name, market, updated_at) VALUES (?1,?2,?3,?4)
             ON CONFLICT(code) DO UPDATE SET name=excluded.name, market=excluded.market, updated_at=excluded.updated_at",
        )?;
        for stk in &day.stocks {
            st.execute(params![
                date,
                stk.code,
                stk.name,
                stk.board,
                stk.days,
                stk.streak,
                stk.high_days,
                stk.price,
                stk.change_rate,
                stk.turnover_rate,
                stk.amount,
                stk.seal_amount,
                stk.first_seal,
                stk.last_seal,
                stk.open_num,
                stk.limit_type,
                stk.reason,
                stk.market,
                stk.market_id,
                stk.success_rate,
                stk.float_cap,
                if stk.is_new { 1 } else { 0 },
                if stk.is_again_limit { 1 } else { 0 },
            ])?;
            for (i, v) in stk.spark.iter().enumerate() {
                tick.execute(params![date, stk.code, i as i64, v])?;
            }
            stock.execute(params![stk.code, stk.name, stk.market, day.fetched_at])?;
        }
    }

    {
        let mut sec = tx.prepare(
            r#"INSERT INTO sectors(date, code, name, change, limit_up_num, continuous_num, high_days, days)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"#,
        )?;
        let mut mem = tx.prepare(
            "INSERT OR REPLACE INTO sector_members(date, sector_code, stock_code) VALUES (?1,?2,?3)",
        )?;
        for s in &day.sectors {
            sec.execute(params![
                date,
                s.code,
                s.name,
                s.change,
                s.limit_up_num,
                s.continuous_num,
                s.high_days,
                s.days
            ])?;
            for code in &s.stock_codes {
                mem.execute(params![date, s.code, code])?;
            }
        }
    }

    for (pool, list) in [("open_limit", &day.open_limit), ("limit_down", &day.limit_down)] {
        let mut st = tx.prepare(
            r#"INSERT INTO pool_aux
            (date, pool, code, name, price, change_rate, turnover_rate, amount, seal_amount,
             first_seal, last_seal, open_num, limit_type, reason, market, market_id, success_rate,
             float_cap, is_new, is_again_limit, high_days, board, days, streak)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)"#,
        )?;
        let mut tick = tx.prepare(
            "INSERT OR REPLACE INTO pool_aux_tick(date, pool, code, seq, pct) VALUES (?1,?2,?3,?4,?5)",
        )?;
        for stk in list {
            st.execute(params![
                date,
                pool,
                stk.code,
                stk.name,
                stk.price,
                stk.change_rate,
                stk.turnover_rate,
                stk.amount,
                stk.seal_amount,
                stk.first_seal,
                stk.last_seal,
                stk.open_num,
                stk.limit_type,
                stk.reason,
                stk.market,
                stk.market_id,
                stk.success_rate,
                stk.float_cap,
                if stk.is_new { 1 } else { 0 },
                if stk.is_again_limit { 1 } else { 0 },
                stk.high_days,
                stk.board,
                stk.days,
                stk.streak,
            ])?;
            for (i, v) in stk.spark.iter().enumerate() {
                tick.execute(params![date, pool, stk.code, i as i64, v])?;
            }
        }
    }

    tx.execute(
        "INSERT INTO trade_days(date, is_trade) VALUES (?1, 1) ON CONFLICT(date) DO UPDATE SET is_trade=1",
        params![date],
    )?;
    tx.execute(
        "INSERT INTO app_meta(key, value) VALUES ('last_day', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![date],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn load_day(conn: &Connection, date: &str) -> Result<Option<DayPayload>> {
    let snap: Option<(i64, i64, i64, i64, i64, i64, i64, f64, f64, i64, i64)> = conn
        .query_row(
            "SELECT fetched_at,total,consecutive,first_board,max_streak,one_word,early_seal,avg_seal,avg_success,open_limit,limit_down FROM day_snapshot WHERE date=?1",
            params![date],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?)),
        )
        .optional()?;
    let Some((fetched_at, total, consecutive, first_board, max_streak, one_word, early_seal, avg_seal, avg_success, open_limit_count, limit_down_count)) = snap else {
        return Ok(None);
    };

    let mut sector_rows: Vec<Sector> = Vec::new();
    {
        let mut st = conn.prepare(
            "SELECT code,name,change,limit_up_num,continuous_num,high_days,days FROM sectors WHERE date=?1 ORDER BY limit_up_num DESC, continuous_num DESC, name ASC",
        )?;
        let iter = st.query_map(params![date], |r| {
            Ok(Sector {
                code: r.get(0)?,
                name: r.get(1)?,
                change: r.get(2)?,
                limit_up_num: r.get(3)?,
                continuous_num: r.get(4)?,
                high_days: r.get(5)?,
                days: r.get(6)?,
                stock_codes: Vec::new(),
            })
        })?;
        for row in iter {
            sector_rows.push(row?);
        }
    }

    let mut members: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut st = conn.prepare(
            "SELECT sector_code, stock_code FROM sector_members WHERE date=?1 ORDER BY sector_code, stock_code",
        )?;
        let iter = st.query_map(params![date], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in iter {
            let (sec, code) = row?;
            members.entry(sec).or_default().push(code);
        }
    }
    for sec in &mut sector_rows {
        sec.stock_codes = members.remove(&sec.code).unwrap_or_default();
    }

    let mut stock_sectors: HashMap<String, Vec<String>> = HashMap::new();
    for sec in &sector_rows {
        for code in &sec.stock_codes {
            stock_sectors.entry(code.clone()).or_default().push(sec.name.clone());
        }
    }

    let mut sparks: HashMap<String, Vec<f64>> = HashMap::new();
    {
        let mut st = conn.prepare(
            "SELECT code, pct FROM limit_up_tick WHERE date=?1 ORDER BY code, seq ASC",
        )?;
        let iter = st.query_map(params![date], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))?;
        for row in iter {
            let (code, pct) = row?;
            sparks.entry(code).or_default().push(pct);
        }
    }

    let mut stocks: Vec<Stock> = Vec::new();
    {
        let mut st = conn.prepare(
            r#"SELECT code,name,board,days,streak,high_days,price,change_rate,turnover_rate,amount,
               seal_amount,first_seal,last_seal,open_num,limit_type,reason,market,market_id,
               success_rate,float_cap,is_new,is_again_limit
               FROM limit_up WHERE date=?1 ORDER BY streak DESC, board DESC, seal_amount DESC, first_seal ASC"#,
        )?;
        let iter = st.query_map(params![date], |r| {
            let reason: String = r.get(15)?;
            Ok(Stock {
                code: r.get(0)?,
                name: r.get(1)?,
                board: r.get(2)?,
                days: r.get(3)?,
                streak: r.get(4)?,
                high_days: r.get(5)?,
                price: r.get(6)?,
                change_rate: r.get(7)?,
                turnover_rate: r.get(8)?,
                amount: r.get(9)?,
                seal_amount: r.get(10)?,
                first_seal: r.get(11)?,
                last_seal: r.get(12)?,
                open_num: r.get(13)?,
                limit_type: r.get(14)?,
                reason_tags: split_reason(&reason),
                reason,
                market: r.get(16)?,
                market_id: r.get(17)?,
                success_rate: r.get(18)?,
                float_cap: r.get(19)?,
                is_new: r.get::<_, i64>(20)? != 0,
                is_again_limit: r.get::<_, i64>(21)? != 0,
                spark: Vec::new(),
                sectors: Vec::new(),
                primary_sector: None,
            })
        })?;
        for row in iter {
            stocks.push(row?);
        }
    }

    for stk in &mut stocks {
        stk.spark = sparks.remove(&stk.code).unwrap_or_default();
        if let Some(list) = stock_sectors.get(&stk.code) {
            stk.primary_sector = list.first().cloned();
            stk.sectors = list.clone();
        }
    }

    let open_limit = load_aux_stocks(conn, date, "open_limit")?;
    let limit_down = load_aux_stocks(conn, date, "limit_down")?;

    Ok(Some(DayPayload {
        date: date.to_string(),
        weekday: weekday_cn(date),
        stats: DayStats {
            total,
            consecutive,
            first_board,
            max_streak,
            one_word,
            early_seal,
            avg_seal,
            avg_success,
            open_limit: open_limit_count,
            limit_down: limit_down_count,
        },
        stocks,
        open_limit,
        limit_down,
        sectors: sector_rows,
        fetched_at,
        source: "cache".into(),
        warning: None,
    }))
}

fn load_aux_stocks(conn: &Connection, date: &str, pool: &str) -> Result<Vec<Stock>> {
    let mut sparks: HashMap<String, Vec<f64>> = HashMap::new();
    {
        let mut st = conn.prepare(
            "SELECT code, pct FROM pool_aux_tick WHERE date=?1 AND pool=?2 ORDER BY code, seq ASC",
        )?;
        let iter = st.query_map(params![date, pool], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))?;
        for row in iter {
            let (code, pct) = row?;
            sparks.entry(code).or_default().push(pct);
        }
    }
    let mut out = Vec::new();
    {
        let mut st = conn.prepare(
            r#"SELECT code,name,board,days,streak,high_days,price,change_rate,turnover_rate,amount,
               seal_amount,first_seal,last_seal,open_num,limit_type,reason,market,market_id,
               success_rate,float_cap,is_new,is_again_limit
               FROM pool_aux WHERE date=?1 AND pool=?2
               ORDER BY change_rate DESC, code ASC"#,
        )?;
        let iter = st.query_map(params![date, pool], |r| {
            let reason: String = r.get(15)?;
            Ok(Stock {
                code: r.get(0)?,
                name: r.get(1)?,
                board: r.get(2)?,
                days: r.get(3)?,
                streak: r.get(4)?,
                high_days: r.get(5)?,
                price: r.get(6)?,
                change_rate: r.get(7)?,
                turnover_rate: r.get(8)?,
                amount: r.get(9)?,
                seal_amount: r.get(10)?,
                first_seal: r.get(11)?,
                last_seal: r.get(12)?,
                open_num: r.get(13)?,
                limit_type: r.get(14)?,
                reason_tags: split_reason(&reason),
                reason,
                market: r.get(16)?,
                market_id: r.get(17)?,
                success_rate: r.get(18)?,
                float_cap: r.get(19)?,
                is_new: r.get::<_, i64>(20)? != 0,
                is_again_limit: r.get::<_, i64>(21)? != 0,
                spark: Vec::new(),
                sectors: Vec::new(),
                primary_sector: None,
            })
        })?;
        for row in iter {
            out.push(row?);
        }
    }
    for stk in &mut out {
        stk.spark = sparks.remove(&stk.code).unwrap_or_default();
    }
    Ok(out)
}

pub fn save_calendar(conn: &mut Connection, today: &str, dates: &[String], today_is_trade: bool) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut st = tx.prepare(
            "INSERT INTO trade_days(date, is_trade) VALUES (?1,1) ON CONFLICT(date) DO UPDATE SET is_trade=1",
        )?;
        for d in dates {
            st.execute(params![d])?;
        }
    }
    tx.execute(
        "INSERT INTO trade_days(date, is_trade) VALUES (?1,?2) ON CONFLICT(date) DO UPDATE SET is_trade=?2",
        params![today, if today_is_trade { 1 } else { 0 }],
    )?;
    tx.execute(
        "INSERT INTO app_meta(key,value) VALUES ('calendar_at', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![chrono::Utc::now().timestamp().to_string()],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn load_calendar(conn: &Connection) -> Result<Option<CalendarInfo>> {
    let mut dates: Vec<String> = Vec::new();
    {
        let mut st = conn.prepare("SELECT date FROM trade_days WHERE is_trade=1 ORDER BY date ASC")?;
        let iter = st.query_map([], |r| r.get::<_, String>(0))?;
        for row in iter {
            dates.push(row?);
        }
    }
    if dates.is_empty() {
        let mut st = conn.prepare("SELECT date FROM day_snapshot ORDER BY date ASC")?;
        let iter = st.query_map([], |r| r.get::<_, String>(0))?;
        for row in iter {
            dates.push(row?);
        }
    }
    if dates.is_empty() {
        return Ok(None);
    }
    let today = today_ymd();
    let is_trade_day: bool = conn
        .query_row(
            "SELECT is_trade FROM trade_days WHERE date=?1",
            params![today],
            |r| Ok(r.get::<_, i64>(0)? != 0),
        )
        .optional()?
        .unwrap_or(false);
    let initial_date = dates
        .iter()
        .filter(|d| d.as_str() <= today.as_str())
        .max()
        .cloned()
        .unwrap_or_else(|| dates.last().cloned().unwrap_or_default());
    Ok(Some(CalendarInfo {
        today,
        is_trade_day,
        initial_date,
        dates,
        source: "cache".into(),
        warning: None,
    }))
}

pub fn save_klines(
    conn: &mut Connection,
    code: &str,
    period: &str,
    name: &str,
    candles: &[KlineCandle],
) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM klines WHERE code=?1 AND period=?2", params![code, period])?;
    {
        let mut st = tx.prepare(
            r#"INSERT OR REPLACE INTO klines(code,period,date,open,high,low,close,volume,amount,pct,turnover)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)"#,
        )?;
        for c in candles {
            st.execute(params![
                code, period, c.date, c.open, c.high, c.low, c.close, c.volume, c.amount, c.pct,
                c.turnover
            ])?;
        }
    }
    let last = candles.last().map(|c| c.date.clone()).unwrap_or_default();
    tx.execute(
        r#"INSERT INTO kline_meta(code,period,name,fetched_at,last_date) VALUES (?1,?2,?3,?4,?5)
           ON CONFLICT(code,period) DO UPDATE SET name=excluded.name, fetched_at=excluded.fetched_at, last_date=excluded.last_date"#,
        params![code, period, name, chrono::Utc::now().timestamp(), last],
    )?;
    if !name.is_empty() {
        tx.execute(
            "INSERT INTO stocks(code,name,market,updated_at) VALUES (?1,?2,'',?3)
             ON CONFLICT(code) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at",
            params![code, name, chrono::Utc::now().timestamp()],
        )?;
        tx.execute(
            "INSERT INTO search_history(code,seen_at) VALUES (?1,?2)
             ON CONFLICT(code) DO UPDATE SET seen_at=excluded.seen_at",
            params![code, chrono::Utc::now().timestamp()],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn load_klines(conn: &Connection, code: &str, period: &str) -> Result<(Vec<KlineCandle>, Option<String>, i64)> {
    let mut out = Vec::new();
    {
        let mut st = conn.prepare(
            "SELECT date,open,high,low,close,volume,amount,pct,turnover FROM klines WHERE code=?1 AND period=?2 ORDER BY date ASC",
        )?;
        let iter = st.query_map(params![code, period], |r| {
            Ok(KlineCandle {
                date: r.get(0)?,
                open: r.get(1)?,
                high: r.get(2)?,
                low: r.get(3)?,
                close: r.get(4)?,
                volume: r.get(5)?,
                amount: r.get(6)?,
                pct: r.get(7)?,
                turnover: r.get(8)?,
            })
        })?;
        for row in iter {
            out.push(row?);
        }
    }
    let meta: Option<(String, i64)> = conn
        .query_row(
            "SELECT name, fetched_at FROM kline_meta WHERE code=?1 AND period=?2",
            params![code, period],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok((out, meta.as_ref().map(|m| m.0.clone()), meta.map(|m| m.1).unwrap_or(0)))
}

pub fn save_index_series(conn: &mut Connection, code: &str, series: &[(String, f64, f64)]) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM index_daily WHERE code=?1", params![code])?;
    {
        let mut st = tx.prepare("INSERT INTO index_daily(code,date,close,pct) VALUES (?1,?2,?3,?4)")?;
        for (date, close, pct) in series {
            st.execute(params![code, date, close, pct])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn load_index_series(conn: &Connection, code: &str) -> Result<Vec<(String, f64, f64)>> {
    let mut rows = Vec::new();
    {
        let mut st = conn.prepare(
            "SELECT date,close,pct FROM index_daily WHERE code=?1 ORDER BY date DESC LIMIT 240",
        )?;
        let iter = st.query_map(params![code], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?))
        })?;
        for row in iter {
            rows.push(row?);
        }
    }
    rows.reverse();
    Ok(rows)
}

pub fn upsert_stock(conn: &Connection, code: &str, name: &str, market: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO stocks(code,name,market,updated_at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(code) DO UPDATE SET name=excluded.name, market=excluded.market, updated_at=excluded.updated_at",
        params![code, name, market, chrono::Utc::now().timestamp()],
    )?;
    Ok(())
}

pub fn local_search(conn: &Connection, q: &str, limit: usize) -> Result<Vec<SearchItem>> {
    let like = format!("%{}%", q.replace('%', "").replace('_', ""));
    let mut st = conn.prepare(
        "SELECT code,name,market FROM stocks WHERE code LIKE ?1 OR name LIKE ?1 ORDER BY updated_at DESC LIMIT ?2",
    )?;
    let iter = st.query_map(params![like, limit as i64], |r| {
        Ok(SearchItem {
            code: r.get(0)?,
            name: r.get(1)?,
            market: r.get(2)?,
            security_type: String::new(),
        })
    })?;
    let mut out = Vec::new();
    for row in iter {
        out.push(row?);
    }
    Ok(out)
}

pub fn recent_stocks(conn: &Connection, limit: usize) -> Result<Vec<SearchItem>> {
    let mut st = conn.prepare(
        "SELECT s.code, s.name, s.market FROM search_history h JOIN stocks s ON s.code=h.code
         ORDER BY h.seen_at DESC LIMIT ?1",
    )?;
    let iter = st.query_map(params![limit as i64], |r| {
        Ok(SearchItem {
            code: r.get(0)?,
            name: r.get(1)?,
            market: r.get(2)?,
            security_type: String::new(),
        })
    })?;
    let mut out = Vec::new();
    for row in iter {
        out.push(row?);
    }
    Ok(out)
}

pub fn stock_name(conn: &Connection, code: &str) -> Result<String> {
    Ok(conn
        .query_row("SELECT name FROM stocks WHERE code=?1", params![code], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
        .unwrap_or_default())
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key=?1", params![key], |r| {
            r.get::<_, String>(0)
        })
        .optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn data_info(conn: &Connection, data_dir: &Path, db_path: &Path) -> Result<DataInfo> {
    let db_bytes = fs::metadata(db_path).map(|m| m.len()).unwrap_or(0);
    let day_count: i64 = conn.query_row("SELECT COUNT(*) FROM day_snapshot", [], |r| r.get(0))?;
    let kline_count: i64 = conn.query_row("SELECT COUNT(*) FROM klines", [], |r| r.get(0))?;
    let first_date: String = conn
        .query_row("SELECT COALESCE(MIN(date),'') FROM day_snapshot", [], |r| r.get(0))
        .unwrap_or_default();
    let last_date: String = conn
        .query_row("SELECT COALESCE(MAX(date),'') FROM day_snapshot", [], |r| r.get(0))
        .unwrap_or_default();
    Ok(DataInfo {
        data_dir: data_dir.display().to_string(),
        db_path: db_path.display().to_string(),
        db_bytes,
        day_count,
        kline_count,
        first_date,
        last_date,
    })
}

pub fn list_watch_groups(conn: &Connection) -> Result<Vec<WatchGroup>> {
    let mut groups = Vec::new();
    {
        let mut st = conn.prepare("SELECT id,name FROM watch_group ORDER BY sort_order ASC, id ASC")?;
        let iter = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for row in iter {
            let (id, name) = row?;
            groups.push(WatchGroup { id, name, stocks: Vec::new() });
        }
    }
    {
        let mut st = conn.prepare(
            "SELECT group_id,code,name,market FROM watch_stock ORDER BY added_at DESC, code ASC",
        )?;
        let iter = st.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                WatchStock {
                    code: r.get(1)?,
                    name: r.get(2)?,
                    market: r.get(3)?,
                },
            ))
        })?;
        for row in iter {
            let (gid, stock) = row?;
            if let Some(g) = groups.iter_mut().find(|g| g.id == gid) {
                g.stocks.push(stock);
            }
        }
    }
    Ok(groups)
}

pub fn create_watch_group(conn: &Connection, name: &str) -> Result<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow::anyhow!("分组名称不能为空"));
    }
    if name.chars().count() > 20 {
        return Err(anyhow::anyhow!("分组名称不能超过 20 个字"));
    }
    let exists: i64 = conn.query_row("SELECT COUNT(*) FROM watch_group WHERE name=?1", params![name], |r| r.get(0))?;
    if exists > 0 {
        return Err(anyhow::anyhow!("分组名称已存在"));
    }
    let order: i64 = conn.query_row("SELECT COALESCE(MAX(sort_order),0)+1 FROM watch_group", [], |r| r.get(0)).unwrap_or(1);
    conn.execute(
        "INSERT INTO watch_group(name,sort_order,created_at) VALUES (?1,?2,?3)",
        params![name, order, chrono::Utc::now().timestamp()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_watch_group(conn: &Connection, id: i64, name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow::anyhow!("分组名称不能为空"));
    }
    if name.chars().count() > 20 {
        return Err(anyhow::anyhow!("分组名称不能超过 20 个字"));
    }
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM watch_group WHERE name=?1 AND id<>?2",
        params![name, id],
        |r| r.get(0),
    )?;
    if exists > 0 {
        return Err(anyhow::anyhow!("分组名称已存在"));
    }
    let n = conn.execute("UPDATE watch_group SET name=?1 WHERE id=?2", params![name, id])?;
    if n == 0 {
        return Err(anyhow::anyhow!("分组不存在"));
    }
    Ok(())
}

pub fn delete_watch_group(conn: &Connection, id: i64) -> Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM watch_group", [], |r| r.get(0))?;
    if count <= 1 {
        return Err(anyhow::anyhow!("至少保留一个分组"));
    }
    conn.execute("DELETE FROM watch_group WHERE id=?1", params![id])?;
    Ok(())
}

pub fn add_watch_stocks(conn: &mut Connection, group_id: i64, stocks: &[WatchStock]) -> Result<WatchAddResult> {
    let exists: i64 = conn.query_row("SELECT COUNT(*) FROM watch_group WHERE id=?1", params![group_id], |r| r.get(0))?;
    if exists == 0 {
        return Err(anyhow::anyhow!("分组不存在"));
    }
    let tx = conn.transaction()?;
    let mut added = 0;
    let mut skipped = 0;
    {
        let mut st = tx.prepare(
            "INSERT OR IGNORE INTO watch_stock(group_id,code,name,market,added_at) VALUES (?1,?2,?3,?4,?5)",
        )?;
        let now = chrono::Utc::now().timestamp();
        for s in stocks {
            let code = s.code.trim();
            if code.is_empty() {
                skipped += 1;
                continue;
            }
            let n = st.execute(params![group_id, code, s.name.trim(), s.market, now])?;
            if n > 0 {
                added += 1;
            } else {
                skipped += 1;
            }
        }
    }
    tx.commit()?;
    Ok(WatchAddResult { added, skipped })
}

pub fn remove_watch_stock(conn: &Connection, group_id: i64, code: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM watch_stock WHERE group_id=?1 AND code=?2",
        params![group_id, code],
    )?;
    Ok(())
}

pub fn clear_cache(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction()?;
    for table in [
        "limit_up_tick",
        "limit_up",
        "pool_aux_tick",
        "pool_aux",
        "sector_members",
        "sectors",
        "day_snapshot",
        "klines",
        "kline_meta",
        "index_daily",
    ] {
        tx.execute(&format!("DELETE FROM {}", table), [])?;
    }
    tx.commit()?;
    conn.execute_batch("VACUUM;")?;
    Ok(())
}

pub fn split_reason(reason: &str) -> Vec<String> {
    reason
        .split(['+', '、', '，', ',', '/'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .take(7)
        .collect()
}

pub fn weekday_cn(date: &str) -> String {
    use chrono::{Datelike, NaiveDate};
    if let Ok(d) = NaiveDate::parse_from_str(date, "%Y%m%d") {
        let w = match d.weekday() {
            chrono::Weekday::Mon => "周一",
            chrono::Weekday::Tue => "周二",
            chrono::Weekday::Wed => "周三",
            chrono::Weekday::Thu => "周四",
            chrono::Weekday::Fri => "周五",
            chrono::Weekday::Sat => "周六",
            chrono::Weekday::Sun => "周日",
        };
        w.to_string()
    } else {
        String::new()
    }
}

pub fn today_ymd() -> String {
    use chrono::{FixedOffset, Utc};
    let tz = FixedOffset::east_opt(8 * 3600).unwrap();
    Utc::now().with_timezone(&tz).format("%Y%m%d").to_string()
}

pub fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}
