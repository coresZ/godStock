use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use chrono::{FixedOffset, Timelike, Utc};
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

        CREATE TABLE IF NOT EXISTS intraday_bars (
            code TEXT NOT NULL,
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
            volume REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0,
            pct REAL NOT NULL DEFAULT 0, turnover REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (code, date, time)
        );
        CREATE INDEX IF NOT EXISTS idx_intraday_code_date ON intraday_bars(code, date);

        CREATE TABLE IF NOT EXISTS index_daily (
            code TEXT NOT NULL,
            date TEXT NOT NULL,
            close REAL NOT NULL,
            pct REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (code, date)
        );

        CREATE TABLE IF NOT EXISTS limit_up_history (
            date TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            board INTEGER NOT NULL DEFAULT 0,
            days INTEGER NOT NULL DEFAULT 0,
            streak INTEGER NOT NULL DEFAULT 0,
            high_days TEXT NOT NULL DEFAULT '',
            price REAL NOT NULL DEFAULT 0,
            change_rate REAL NOT NULL DEFAULT 0,
            turnover_rate REAL NOT NULL DEFAULT 0,
            seal_amount REAL NOT NULL DEFAULT 0,
            amount_est REAL NOT NULL DEFAULT 0,
            first_seal INTEGER NOT NULL DEFAULT 0,
            open_num INTEGER NOT NULL DEFAULT 0,
            limit_type TEXT NOT NULL DEFAULT '',
            float_cap REAL NOT NULL DEFAULT 0,
            market TEXT NOT NULL DEFAULT '',
            is_new INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date, code)
        );

        CREATE TABLE IF NOT EXISTS stock_stats (
            code TEXT PRIMARY KEY,
            as_of TEXT NOT NULL,
            limit_up_120d INTEGER NOT NULL DEFAULT 0,
            max_streak_250d INTEGER NOT NULL DEFAULT 0,
            max_gain_20d REAL NOT NULL DEFAULT 0,
            max_gain_250d REAL NOT NULL DEFAULT 0,
            prev_day_amount REAL NOT NULL DEFAULT 0,
            last_limit_date TEXT NOT NULL DEFAULT '',
            computed_at INTEGER NOT NULL DEFAULT 0
        );

        -- Per trade day kline aggregates: keeps a past date's screening from
        -- re-fetching candles. Derived cache only, never the day snapshot.
        CREATE TABLE IF NOT EXISTS stock_stats_day (
            code TEXT NOT NULL,
            as_of TEXT NOT NULL,
            max_gain_20d REAL NOT NULL DEFAULT 0,
            max_gain_250d REAL NOT NULL DEFAULT 0,
            prev_day_amount REAL NOT NULL DEFAULT 0,
            computed_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (code, as_of)
        );
        CREATE INDEX IF NOT EXISTS idx_stock_stats_day_asof ON stock_stats_day(as_of);

        CREATE TABLE IF NOT EXISTS auction_snapshot (
            date TEXT NOT NULL,
            code TEXT NOT NULL,
            price REAL NOT NULL DEFAULT 0,
            prev_close REAL NOT NULL DEFAULT 0,
            volume REAL NOT NULL DEFAULT 0,
            amount REAL NOT NULL DEFAULT 0,
            turnover REAL NOT NULL DEFAULT 0,
            captured_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date, code)
        );

        CREATE TABLE IF NOT EXISTS strategy_profile (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            max_price REAL NOT NULL,
            max_float_cap REAL NOT NULL,
            min_limit_count INTEGER NOT NULL,
            limit_window_days INTEGER NOT NULL,
            max_streak INTEGER NOT NULL,
            max_gain_20d REAL NOT NULL,
            min_sector_limit_ups INTEGER NOT NULL,
            min_sector_continuous INTEGER NOT NULL,
            min_seal_ratio REAL NOT NULL,
            max_open_num INTEGER NOT NULL,
            latest_first_seal_minute INTEGER NOT NULL,
            min_turnover REAL NOT NULL,
            top_n INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_limit_up_streak ON limit_up (date, streak);
        CREATE INDEX IF NOT EXISTS idx_tick_date ON limit_up_tick (date, code);
        CREATE INDEX IF NOT EXISTS idx_sectors_date ON sectors (date, limit_up_num);
        CREATE INDEX IF NOT EXISTS idx_limit_hist_code_date ON limit_up_history (code, date);
        CREATE INDEX IF NOT EXISTS idx_stock_stats_asof ON stock_stats (as_of);
        "#,
    )?;
    conn.execute(
        "INSERT INTO settings(key, value) VALUES ('theme', 'dark') ON CONFLICT(key) DO NOTHING",
        [],
    )?;
    migrate(&conn)?;
    ensure_default_watch_group(&conn)?;
    ensure_default_profile(&conn)?;
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
    // `stock_stats_day` is a pure derived cache (kline aggregates per trade day);
    // bump `stats_day_v` whenever the aggregate definition changes. v2 drops the
    // rows written by the look-ahead / uncovered-series era in one go.
    let stats_day_version: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key='stats_day_v'", [], |r| r.get(0))
        .optional()?;
    if stats_day_version.as_deref() != Some("2") {
        conn.execute("DELETE FROM stock_stats_day", [])?;
        conn.execute(
            "INSERT INTO settings(key,value) VALUES ('stats_day_v','2')
             ON CONFLICT(key) DO UPDATE SET value='2'",
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

/// Single-row strategy config. Seeded once so `load_profile` can always read a
/// concrete row; `updated_at == 0` marks "never saved by the user".
fn ensure_default_profile(conn: &Connection) -> Result<()> {
    let def = StrategyProfile::default();
    conn.execute(
        r#"INSERT OR IGNORE INTO strategy_profile
           (id, max_price, max_float_cap, min_limit_count, limit_window_days, max_streak,
            max_gain_20d, min_sector_limit_ups, min_sector_continuous, min_seal_ratio,
            max_open_num, latest_first_seal_minute, min_turnover, top_n, updated_at)
           VALUES (1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)"#,
        params![
            def.max_price,
            def.max_float_cap,
            def.min_limit_count,
            def.limit_window_days,
            def.max_streak,
            def.max_gain_20d,
            def.min_sector_limit_ups,
            def.min_sector_continuous,
            def.min_seal_ratio,
            def.max_open_num,
            def.latest_first_seal_minute,
            def.min_turnover,
            def.top_n,
            def.updated_at,
        ],
    )?;
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

/// Rebuild one stock-day of 1-minute bars. `KlineCandle.date` is split into the
/// `date` / `time` columns on write and joined back on read, so the payload the
/// frontend sees keeps the same `"YYYY-MM-DD HH:MM"` shape as the K-line.
pub fn load_intraday(conn: &Connection, code: &str, date: &str) -> Result<Vec<KlineCandle>> {
    let mut out = Vec::new();
    {
        let mut st = conn.prepare(
            "SELECT time,open,high,low,close,volume,amount,pct,turnover FROM intraday_bars
             WHERE code=?1 AND date=?2 ORDER BY time ASC",
        )?;
        let iter = st.query_map(params![code, date], |r| {
            Ok(KlineCandle {
                date: format!("{} {}", date, r.get::<_, String>(0)?),
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
    Ok(out)
}

/// Replace every bar of `(code, date)`. An empty slice is a no-op on purpose:
/// a failed/empty refetch must never wipe a good cache.
pub fn save_intraday(conn: &mut Connection, code: &str, date: &str, candles: &[KlineCandle]) -> Result<()> {
    if candles.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM intraday_bars WHERE code=?1 AND date=?2", params![code, date])?;
    {
        let mut st = tx.prepare(
            r#"INSERT OR REPLACE INTO intraday_bars
               (code,date,time,open,high,low,close,volume,amount,pct,turnover)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)"#,
        )?;
        for c in candles {
            let Some(time) = c.date.split_whitespace().nth(1) else { continue };
            if time.is_empty() {
                continue;
            }
            st.execute(params![
                code, date, time, c.open, c.high, c.low, c.close, c.volume, c.amount, c.pct,
                c.turnover
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn upsert_index_point(conn: &Connection, code: &str, date: &str, close: f64, pct: f64) -> Result<()> {
    if date.trim().is_empty() || close <= 0.0 {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO index_daily(code,date,close,pct) VALUES (?1,?2,?3,?4)
         ON CONFLICT(code,date) DO UPDATE SET close=excluded.close,pct=excluded.pct",
        params![code, date, close, pct],
    )?;
    Ok(())
}

#[allow(dead_code)]
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
        "intraday_bars",
        "index_daily",
        "stock_stats_day",
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

/* ————————————————— limit_up_history ————————————————— */

/// One parsed `limit_up_pool` row stored in `limit_up_history`. The history
/// endpoint has no sector payload, so `streak` mirrors `board` (see the
/// strategy contract: consecutive boards are rebuilt from the date series).
#[derive(Clone, Debug, Default)]
pub struct LimitHistoryRow {
    pub code: String,
    pub name: String,
    pub board: i64,
    pub days: i64,
    pub streak: i64,
    pub high_days: String,
    pub price: f64,
    pub change_rate: f64,
    pub turnover_rate: f64,
    pub seal_amount: f64,
    pub amount_est: f64,
    pub first_seal: i64,
    pub open_num: i64,
    pub limit_type: String,
    pub float_cap: f64,
    pub market: String,
    pub is_new: bool,
}

/// Replace every row for `date`. Kept separate from `save_day` on purpose: the
/// backfill must never touch the day snapshot (`limit_up` / `day_snapshot`).
pub fn save_limit_history(conn: &mut Connection, date: &str, rows: &[LimitHistoryRow]) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM limit_up_history WHERE date = ?1", params![date])?;
    {
        let mut st = tx.prepare(
            r#"INSERT OR REPLACE INTO limit_up_history
            (date, code, name, board, days, streak, high_days, price, change_rate, turnover_rate,
             seal_amount, amount_est, first_seal, open_num, limit_type, float_cap, market, is_new)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)"#,
        )?;
        for r in rows {
            st.execute(params![
                date,
                r.code,
                r.name,
                r.board,
                r.days,
                r.streak,
                r.high_days,
                r.price,
                r.change_rate,
                r.turnover_rate,
                r.seal_amount,
                r.amount_est,
                r.first_seal,
                r.open_num,
                r.limit_type,
                r.float_cap,
                r.market,
                if r.is_new { 1 } else { 0 },
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// `(first_date, last_date, distinct_days)` of the backfilled history.
pub fn history_coverage(conn: &Connection) -> Result<(String, String, i64)> {
    let row = conn.query_row(
        "SELECT COALESCE(MIN(date),''), COALESCE(MAX(date),''), COUNT(DISTINCT date) FROM limit_up_history",
        [],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)),
    )?;
    Ok(row)
}

pub fn history_status(conn: &Connection, syncing: bool) -> Result<HistoryStatus> {
    let (first_date, last_date, days) = history_coverage(conn)?;
    let today = today_ymd();
    let calendar_days: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM trade_days WHERE is_trade=1 AND date<=?1",
            params![today],
            |r| r.get(0),
        )
        .unwrap_or(0);
    // Before the close, today's limit-up pool may legitimately be empty (or not
    // ready yet); do not demand a coverage day the market cannot provide.
    let today_is_trade: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM trade_days WHERE date=?1 AND is_trade=1",
            params![today],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let today_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM limit_up_history WHERE date=?1",
            params![today],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let before_close = {
        let tz = FixedOffset::east_opt(8 * 3600).unwrap();
        let now = Utc::now().with_timezone(&tz);
        now.hour() * 60 + now.minute() < 15 * 60 + 5
    };
    let mut expected = calendar_days.min(250);
    if today_is_trade > 0 && today_rows == 0 && before_close {
        expected = expected.saturating_sub(1).max(days);
    }
    let updated_at: i64 = conn
        .query_row("SELECT value FROM app_meta WHERE key='limit_history_at'", [], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    Ok(HistoryStatus {
        first_date,
        last_date,
        days,
        expected_days: expected.max(days),
        syncing,
        updated_at,
    })
}

/// Distinct dates that already carry history rows (used to skip a re-fetch).
pub fn history_dates(conn: &Connection) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut st = conn.prepare("SELECT DISTINCT date FROM limit_up_history ORDER BY date ASC")?;
    let iter = st.query_map([], |r| r.get::<_, String>(0))?;
    for row in iter {
        out.push(row?);
    }
    Ok(out)
}

/// Trade days up to and including `date`, ascending, capped at `limit`. Falls
/// back to the dates already present in `limit_up_history` when the calendar
/// was never fetched, so screening still works on a cold install.
pub fn trade_days_upto(conn: &Connection, date: &str, limit: usize) -> Result<Vec<String>> {
    let mut days: Vec<String> = Vec::new();
    {
        let mut st = conn.prepare(
            "SELECT date FROM trade_days WHERE is_trade=1 AND date<=?1 ORDER BY date DESC LIMIT ?2",
        )?;
        let iter = st.query_map(params![date, limit as i64], |r| r.get::<_, String>(0))?;
        for row in iter {
            days.push(row?);
        }
    }
    if days.is_empty() {
        let mut st = conn.prepare(
            "SELECT DISTINCT date FROM limit_up_history WHERE date<=?1 ORDER BY date DESC LIMIT ?2",
        )?;
        let iter = st.query_map(params![date, limit as i64], |r| r.get::<_, String>(0))?;
        for row in iter {
            days.push(row?);
        }
    }
    days.reverse();
    Ok(days)
}

/// Codes that hit the limit on `date`. An empty set means "no history for that
/// day", which the screen treats as insufficient data rather than "nobody".
pub fn history_codes_for_date(conn: &Connection, date: &str) -> Result<HashSet<String>> {
    let mut out = HashSet::new();
    let mut st = conn.prepare("SELECT code FROM limit_up_history WHERE date=?1")?;
    let iter = st.query_map(params![date], |r| r.get::<_, String>(0))?;
    for row in iter {
        out.insert(row?);
    }
    Ok(out)
}

/// `code -> dates (ascending)` inside `[start, end]`.
pub fn history_occurrences(conn: &Connection, start: &str, end: &str) -> Result<HashMap<String, Vec<String>>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    let mut st = conn.prepare(
        "SELECT code, date FROM limit_up_history WHERE date>=?1 AND date<=?2 ORDER BY code ASC, date ASC",
    )?;
    let iter = st.query_map(params![start, end], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in iter {
        let (code, date) = row?;
        out.entry(code).or_default().push(date);
    }
    Ok(out)
}

pub fn history_last_dates(conn: &Connection) -> Result<HashMap<String, String>> {
    let mut out = HashMap::new();
    let mut st = conn.prepare("SELECT code, MAX(date) FROM limit_up_history GROUP BY code")?;
    let iter = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in iter {
        let (code, date) = row?;
        out.insert(code, date);
    }
    Ok(out)
}

/* ————————————————— stock_stats ————————————————— */

#[derive(Clone, Debug, Default)]
pub struct StockStatsRow {
    pub code: String,
    pub as_of: String,
    pub limit_up_120d: i64,
    pub max_streak_250d: i64,
    pub max_gain_20d: f64,
    pub max_gain_250d: f64,
    pub prev_day_amount: f64,
    pub last_limit_date: String,
    pub computed_at: i64,
}

pub fn save_stock_stats(conn: &Connection, row: &StockStatsRow) -> Result<()> {
    conn.execute(
        r#"INSERT INTO stock_stats
           (code, as_of, limit_up_120d, max_streak_250d, max_gain_20d, max_gain_250d,
            prev_day_amount, last_limit_date, computed_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
           ON CONFLICT(code) DO UPDATE SET
             as_of=excluded.as_of,
             limit_up_120d=excluded.limit_up_120d,
             max_streak_250d=excluded.max_streak_250d,
             max_gain_20d=excluded.max_gain_20d,
             max_gain_250d=excluded.max_gain_250d,
             prev_day_amount=excluded.prev_day_amount,
             last_limit_date=excluded.last_limit_date,
             computed_at=excluded.computed_at"#,
        params![
            row.code,
            row.as_of,
            row.limit_up_120d,
            row.max_streak_250d,
            row.max_gain_20d,
            row.max_gain_250d,
            row.prev_day_amount,
            row.last_limit_date,
            row.computed_at,
        ],
    )?;
    Ok(())
}

/// Read side of the legacy `stock_stats` table. `ensure_stats` now keys its
/// kline reuse on `stock_stats_day`; this stays as the table's accessor (tests
/// and any future consumer) and must keep its "latest row per code" semantics.
#[allow(dead_code)]
pub fn load_stock_stats(conn: &Connection, code: &str) -> Result<Option<StockStatsRow>> {
    Ok(conn
        .query_row(
            r#"SELECT code, as_of, limit_up_120d, max_streak_250d, max_gain_20d, max_gain_250d,
               prev_day_amount, last_limit_date, computed_at
               FROM stock_stats WHERE code=?1"#,
            params![code],
            |r| {
                Ok(StockStatsRow {
                    code: r.get(0)?,
                    as_of: r.get(1)?,
                    limit_up_120d: r.get(2)?,
                    max_streak_250d: r.get(3)?,
                    max_gain_20d: r.get(4)?,
                    max_gain_250d: r.get(5)?,
                    prev_day_amount: r.get(6)?,
                    last_limit_date: r.get(7)?,
                    computed_at: r.get(8)?,
                })
            },
        )
        .optional()?)
}

/// `code -> prev_day_amount`, for the auction `amount_ratio` column.
pub fn prev_day_amounts(conn: &Connection) -> Result<HashMap<String, f64>> {
    let mut out = HashMap::new();
    let mut st = conn.prepare("SELECT code, prev_day_amount FROM stock_stats WHERE prev_day_amount > 0")?;
    let iter = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))?;
    for row in iter {
        let (code, amount) = row?;
        out.insert(code, amount);
    }
    Ok(out)
}

/* ————————————————— stock_stats_day (per trade day kline aggregates) ————————————————— */

/// Kline aggregates pinned to one trade day. `stock_stats` keeps the "latest"
/// value per code (the auction tab reads it), while this table lets a past
/// date replay its screening without recomputing or re-fetching candles.
#[derive(Debug, Clone, Default)]
pub struct StockStatsDayRow {
    pub code: String,
    pub as_of: String,
    pub max_gain_20d: f64,
    pub max_gain_250d: f64,
    pub prev_day_amount: f64,
    pub computed_at: i64,
}

pub fn save_stock_stats_day(conn: &Connection, row: &StockStatsDayRow) -> Result<()> {
    conn.execute(
        r#"INSERT INTO stock_stats_day
           (code, as_of, max_gain_20d, max_gain_250d, prev_day_amount, computed_at)
           VALUES (?1,?2,?3,?4,?5,?6)
           ON CONFLICT(code,as_of) DO UPDATE SET
             max_gain_20d=excluded.max_gain_20d,
             max_gain_250d=excluded.max_gain_250d,
             prev_day_amount=excluded.prev_day_amount,
             computed_at=excluded.computed_at"#,
        params![
            row.code,
            row.as_of,
            row.max_gain_20d,
            row.max_gain_250d,
            row.prev_day_amount,
            row.computed_at,
        ],
    )?;
    Ok(())
}

pub fn load_stock_stats_day(conn: &Connection, code: &str, as_of: &str) -> Result<Option<StockStatsDayRow>> {
    Ok(conn
        .query_row(
            r#"SELECT code, as_of, max_gain_20d, max_gain_250d, prev_day_amount, computed_at
               FROM stock_stats_day WHERE code=?1 AND as_of=?2"#,
            params![code, as_of],
            |r| {
                Ok(StockStatsDayRow {
                    code: r.get(0)?,
                    as_of: r.get(1)?,
                    max_gain_20d: r.get(2)?,
                    max_gain_250d: r.get(3)?,
                    prev_day_amount: r.get(4)?,
                    computed_at: r.get(5)?,
                })
            },
        )
        .optional()?)
}

/* ————————————————— auction_snapshot ————————————————— */

pub fn save_auction(conn: &mut Connection, date: &str, rows: &[AuctionRow]) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM auction_snapshot WHERE date=?1", params![date])?;
    {
        let mut st = tx.prepare(
            r#"INSERT OR REPLACE INTO auction_snapshot
               (date, code, price, prev_close, volume, amount, turnover, captured_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"#,
        )?;
        for r in rows {
            st.execute(params![
                date,
                r.code,
                r.price,
                r.prev_close,
                r.volume,
                r.amount,
                r.turnover,
                r.captured_at,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Rebuild auction rows from disk. `name` comes from the day snapshot (`open`
/// has no column in the contract DDL and therefore reads back as 0).
pub fn load_auction(conn: &Connection, date: &str) -> Result<Vec<AuctionRow>> {
    let prev = prev_day_amounts(conn).unwrap_or_default();
    let mut names: HashMap<String, String> = HashMap::new();
    {
        let mut st = conn.prepare("SELECT code, name FROM limit_up WHERE date=?1")?;
        let iter = st.query_map(params![date], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in iter {
            let (code, name) = row?;
            names.insert(code, name);
        }
    }
    let mut out = Vec::new();
    let mut st = conn.prepare(
        r#"SELECT code, price, prev_close, volume, amount, turnover, captured_at
           FROM auction_snapshot WHERE date=?1 ORDER BY code ASC"#,
    )?;
    let iter = st.query_map(params![date], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, f64>(1)?,
            r.get::<_, f64>(2)?,
            r.get::<_, f64>(3)?,
            r.get::<_, f64>(4)?,
            r.get::<_, f64>(5)?,
            r.get::<_, i64>(6)?,
        ))
    })?;
    for row in iter {
        let (code, price, prev_close, volume, amount, turnover, captured_at) = row?;
        let pct = if prev_close > 0.0 { (price / prev_close - 1.0) * 100.0 } else { 0.0 };
        let amount_ratio = prev.get(&code).copied().filter(|v| *v > 0.0).map(|v| amount / v);
        let name = names.get(&code).cloned().unwrap_or_default();
        out.push(AuctionRow {
            code,
            name,
            price,
            prev_close,
            open: 0.0,
            volume,
            amount,
            turnover,
            auction_pct: pct,
            amount_ratio,
            captured_at,
        });
    }
    Ok(out)
}

/// First-board stocks of a stored day snapshot (`limit_up.streak <= 1`).
/// Previous trading day strictly before `date` (None when the calendar is missing).
pub fn prev_trade_day(conn: &Connection, date: &str) -> Result<Option<String>> {
    let row: Option<String> = conn
        .query_row(
            "SELECT date FROM trade_days WHERE is_trade=1 AND date<?1 ORDER BY date DESC LIMIT 1",
            params![date],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    Ok(row)
}

pub fn limit_up_first_board(conn: &Connection, date: &str) -> Result<Vec<(String, String)>> {    let mut out = Vec::new();
    let mut st = conn.prepare(
        "SELECT code, name FROM limit_up WHERE date=?1 AND streak<=1 ORDER BY seal_amount DESC, code ASC",
    )?;
    let iter = st.query_map(params![date], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in iter {
        out.push(row?);
    }
    Ok(out)
}

/* ————————————————— strategy_profile ————————————————— */

pub fn load_profile(conn: &Connection) -> Result<StrategyProfile> {
    let row: Option<StrategyProfile> = conn
        .query_row(
            r#"SELECT max_price, max_float_cap, min_limit_count, limit_window_days, max_streak,
               max_gain_20d, min_sector_limit_ups, min_sector_continuous, min_seal_ratio,
               max_open_num, latest_first_seal_minute, min_turnover, top_n, updated_at
               FROM strategy_profile WHERE id=1"#,
            [],
            |r| {
                Ok(StrategyProfile {
                    max_price: r.get(0)?,
                    max_float_cap: r.get(1)?,
                    min_limit_count: r.get(2)?,
                    limit_window_days: r.get(3)?,
                    max_streak: r.get(4)?,
                    max_gain_20d: r.get(5)?,
                    min_sector_limit_ups: r.get(6)?,
                    min_sector_continuous: r.get(7)?,
                    min_seal_ratio: r.get(8)?,
                    max_open_num: r.get(9)?,
                    latest_first_seal_minute: r.get(10)?,
                    min_turnover: r.get(11)?,
                    top_n: r.get(12)?,
                    updated_at: r.get(13)?,
                })
            },
        )
        .optional()?;
    Ok(row.unwrap_or_default())
}

pub fn save_profile(conn: &Connection, p: &StrategyProfile) -> Result<()> {
    conn.execute(
        r#"INSERT INTO strategy_profile
           (id, max_price, max_float_cap, min_limit_count, limit_window_days, max_streak,
            max_gain_20d, min_sector_limit_ups, min_sector_continuous, min_seal_ratio,
            max_open_num, latest_first_seal_minute, min_turnover, top_n, updated_at)
           VALUES (1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
           ON CONFLICT(id) DO UPDATE SET
             max_price=excluded.max_price,
             max_float_cap=excluded.max_float_cap,
             min_limit_count=excluded.min_limit_count,
             limit_window_days=excluded.limit_window_days,
             max_streak=excluded.max_streak,
             max_gain_20d=excluded.max_gain_20d,
             min_sector_limit_ups=excluded.min_sector_limit_ups,
             min_sector_continuous=excluded.min_sector_continuous,
             min_seal_ratio=excluded.min_seal_ratio,
             max_open_num=excluded.max_open_num,
             latest_first_seal_minute=excluded.latest_first_seal_minute,
             min_turnover=excluded.min_turnover,
             top_n=excluded.top_n,
             updated_at=excluded.updated_at"#,
        params![
            p.max_price,
            p.max_float_cap,
            p.min_limit_count,
            p.limit_window_days,
            p.max_streak,
            p.max_gain_20d,
            p.min_sector_limit_ups,
            p.min_sector_continuous,
            p.min_seal_ratio,
            p.max_open_num,
            p.latest_first_seal_minute,
            p.min_turnover,
            p.top_n,
            p.updated_at,
        ],
    )?;
    Ok(())
}
