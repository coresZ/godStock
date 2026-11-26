//! 同花顺 / 问财 登录态（应用内 WebView2 登录窗口 + 只读 Cookie 转发）。
//!
//! 登录窗口 label = `iwc-login`，与主窗口共享同一个 WebView2 profile（默认
//! `app_local_data_dir()`，见 tauri manager/webview.rs），所以登录完成后主窗口的
//! `cookies_for_url` 就能读到 HttpOnly cookie；cookie 只在内存里拼成 `Cookie:` 头转发给
//! iwencai / 10jqka 接口，**不落盘、不打印**。同步结果落 SQLite（`iwc_*` 四张表）。
//!
//! 硬约束（tauri 2.12.5 文档 + wry#583）：`cookies_for_url` 在 Windows 上于同步 command
//! 或事件回调里调用会死锁，所以本模块所有入口都是从 async command 调用的 async fn。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use anyhow::{anyhow, Context, Result};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::db;
use crate::models::*;
use crate::source;

/// 登录窗口 label（前端约定，用来开 / 关窗口）。
pub const LOGIN_LABEL: &str = "iwc-login";
const LOGIN_TITLE: &str = "登录同花顺 / 同花顺问财";
/// 问财与同花顺自选股各自的 origin，cookie 必须按域分别读取。
const IWC_ORIGIN: &str = "https://www.iwencai.com/";
const THS_ORIGIN: &str = "https://t.10jqka.com.cn/";
/// 登录相关域名。既用于登录 popup 白名单，也用于退出登录时筛选要删的 Cookie
/// （`cookies()` 是全量 store，能看到 upass / stat 这类 host-only Cookie）。
const LOGIN_HOSTS: [&str; 5] = ["iwencai.com", "10jqka.com.cn", "10jqka.com", "hexin.cn", "hexin.com"];
/// 10jqka 域里明确代表「已登录」的 Cookie 名（脚本证据只提到 userid / ticket，
/// escapename / usercookie 是登录后才下发的会话名）。不做模糊匹配。
const THS_SESSION_COOKIES: [&str; 4] = ["userid", "ticket", "escapename", "usercookie"];
/// 名称补全：行情接口每批最多 60 只（腾讯 / 新浪 URL 长度与限流都安全）。
const NAME_BATCH: usize = 60;
/// 名称补全总量上限：动态板块可能有几千只成分股，避免一次同步打出上百个请求。
const NAME_LOOKUP_LIMIT: usize = 1200;

/// popup 窗口 label 序号：`iwc-login-popup-1`、`iwc-login-popup-2` …
static POPUP_SEQ: AtomicUsize = AtomicUsize::new(0);

/// 登录会话世代：`logout` 时 +1；正在跑的 `sync` 写库前比对，避免「退出登录后
/// 旧同步又把数据写回来」。
static SESSION_EPOCH: AtomicU64 = AtomicU64::new(0);

fn session_epoch() -> u64 {
    SESSION_EPOCH.load(Ordering::SeqCst)
}

fn bump_session_epoch() {
    SESSION_EPOCH.fetch_add(1, Ordering::SeqCst);
}

/* ————————————————— cookie 读取 ————————————————— */

/// 读某个 origin 的全部 cookie（含 HttpOnly / Secure），只返回名字与值。
/// `main` 窗口与登录窗口共享 profile，因此这里固定从 `main` 读。
async fn read_cookies(app: &AppHandle, origin: &str) -> Vec<(String, String)> {
    let Some(window) = app.get_webview_window("main") else {
        return Vec::new();
    };
    let Ok(url) = origin.parse::<Url>() else {
        return Vec::new();
    };
    match window.cookies_for_url(url) {
        Ok(list) => list
            .into_iter()
            .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()))
            .collect(),
        Err(error) => {
            // 只打印错误本身：错误串里不含 cookie 值，绝不打印 cookie。
            eprintln!("cookies_for_url failed: {error}");
            Vec::new()
        }
    }
}

/// 把 cookie 列表拼成 `name=value; name2=value2`。空名 / 空值跳过；同名只保留第一条
/// （同一 origin 下同名 cookie 只可能来自不同 path，接口按第一条解析即可）。
fn join_cookie_header(list: &[(String, String)]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (name, value) in list {
        let name = name.trim();
        let value = value.trim();
        if name.is_empty() || value.is_empty() {
            continue;
        }
        if parts.iter().any(|part| part.starts_with(&format!("{name}="))) {
            continue;
        }
        parts.push(format!("{name}={value}"));
    }
    parts.join("; ")
}

/// 按 cookie 名精确取值（大小写不敏感）。**不做**「名字里含片段」的模糊匹配 ——
/// 会话判定 / 退出登录都必须只认明确的 cookie 名。
fn cookie_value<'a>(list: &'a [(String, String)], names: &[&str]) -> Option<&'a str> {
    for name in names {
        if let Some((_, value)) = list
            .iter()
            .find(|(key, value)| key.eq_ignore_ascii_case(name) && !value.trim().is_empty())
        {
            return Some(value);
        }
    }
    None
}

/// 用户 id 脱敏：`1234567890` → `123****90`；太短时只留首字符。
fn mask_user_id(raw: &str) -> String {
    let raw = raw.trim();
    let count = raw.chars().count();
    if count == 0 {
        return String::new();
    }
    if count <= 4 {
        return format!("{}****", raw.chars().next().unwrap_or('*'));
    }
    let head: String = raw.chars().take(3).collect();
    let tail: String = raw.chars().skip(count - 2).collect();
    format!("{head}****{tail}")
}

/// 登录态：问财看 `userid`；同花顺只认明确的会话 Cookie 名（`THS_SESSION_COOKIES`），
/// 不再「有任何非空 cookie 就算已登录」。
pub async fn auth_status(app: &AppHandle) -> IwcAuthStatus {
    let iwc = read_cookies(app, IWC_ORIGIN).await;
    let ths = read_cookies(app, THS_ORIGIN).await;
    let user_id_cookie = cookie_value(&iwc, &["userid"]);
    IwcAuthStatus {
        iwc_logged_in: user_id_cookie.is_some(),
        ths_logged_in: cookie_value(&ths, &THS_SESSION_COOKIES).is_some(),
        user_id: user_id_cookie.map(mask_user_id).unwrap_or_default(),
    }
}

/* ————————————————— 登录窗口 ————————————————— */

fn login_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(LOGIN_LABEL)
}

/// 登录窗口是否还开着。前端在「等待登录」轮询里用它判断用户是否已手动关窗
/// （否则要等满 5 分钟超时）。
pub async fn login_window_open(app: &AppHandle) -> bool {
    login_window(app).is_some()
}

fn popup_label() -> String {
    let seq = POPUP_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    format!("{LOGIN_LABEL}-popup-{seq}")
}

/// 是否登录相关域：带前导点的 domain cookie、host-only 子域（upass / stat …）都算。
fn is_login_domain(domain: &str) -> bool {
    let host = domain.trim().trim_start_matches('.').to_ascii_lowercase();
    !host.is_empty()
        && LOGIN_HOSTS
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

/// popup 目标是否允许留在应用内。`about:blank` 是常见的「先开空白窗再跳转」写法。
fn host_allowed(url: &Url) -> bool {
    match url.host_str() {
        Some(host) => is_login_domain(host),
        None => url.scheme() == "about",
    }
}

/// 打开（或聚焦）应用内登录窗口。已存在则不再新建。
pub async fn open_login(app: &AppHandle) -> Result<()> {
    if let Some(window) = login_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    let url = WebviewUrl::External(IWC_ORIGIN.parse::<Url>().context("parse iwc origin")?);
    let app_for_popup = app.clone();
    let window = WebviewWindowBuilder::new(app, LOGIN_LABEL, url)
        .title(LOGIN_TITLE)
        // 560×780 能完整放下问财的扫码 / 账号登录表单，比主窗口小一圈。
        .inner_size(560.0, 780.0)
        .min_inner_size(420.0, 560.0)
        .center()
        .on_new_window(move |target, features| {
            // 优先：在同一个 WebView2 profile 里新建窗口（`window_features` 在 Windows 上
            // 会把 opener 的 environment 带过去，这是 WebView2 `SetNewWindow` 的硬要求）。
            if host_allowed(&target) {
                let label = popup_label();
                let created = WebviewWindowBuilder::new(
                    &app_for_popup,
                    label,
                    WebviewUrl::External(target.clone()),
                )
                .title(LOGIN_TITLE)
                .window_features(features)
                .build();
                if let Ok(window) = created {
                    let _ = window.set_focus();
                    return NewWindowResponse::Create { window };
                }
            }
            // 兜底：拒绝弹窗（不交给系统浏览器，否则 cookie 进不了应用），
            // 把登录窗口自己导航到目标页 —— 仍然留在同一 profile 内完成登录。
            if host_allowed(&target) {
                if let Some(window) = app_for_popup.get_webview_window(LOGIN_LABEL) {
                    let _ = window.navigate(target);
                    let _ = window.set_focus();
                }
            }
            NewWindowResponse::Deny
        })
        .build()?;
    let _ = window.set_focus();
    Ok(())
}

/// 关闭登录窗口（含 popup 子窗口）。主窗口不受影响。
pub async fn close_login(app: &AppHandle) -> Result<()> {
    let prefix = format!("{LOGIN_LABEL}-popup-");
    for window in app.webview_windows().values() {
        let label = window.label();
        if label == LOGIN_LABEL || label.starts_with(&prefix) {
            let _ = window.close();
        }
    }
    Ok(())
}

/* ————————————————— 退出登录 ————————————————— */

/// 从「全量 Cookie 列表」筛出要删的登录域 Cookie：`(name, 裸域名, path)`。
/// 输入是 `(name, domain, path)` 三元组（domain 可能带前导点，path 可能为空）。
/// domain cookie（`.iwencai.com`）与 host-only cookie（`upass.10jqka.com.cn`）都会命中；
/// 删除时两种 domain 写法都会试，所以这里统一去掉前导点、path 缺失按 "/"。
fn login_cookie_targets(
    cookies: &[(String, Option<String>, Option<String>)],
) -> Vec<(String, String, String)> {
    let mut targets: Vec<(String, String, String)> = Vec::new();
    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    for (name, domain, path) in cookies {
        let Some(domain) = domain.as_deref() else { continue };
        if name.trim().is_empty() || !is_login_domain(domain) {
            continue;
        }
        let bare = domain.trim().trim_start_matches('.').to_ascii_lowercase();
        let path = path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .unwrap_or("/")
            .to_string();
        let target = (name.trim().to_string(), bare, path);
        if seen.insert(target.clone()) {
            targets.push(target);
        }
    }
    targets
}

/// 用 WebView2 原生 `DeleteCookiesWithDomainAndPath` 删除登录域 Cookie。
///
/// 为什么不能走 tauri `delete_cookie`：wry 会先把 Cookie 经 `CreateCookie` 往返再
/// `DeleteCookie`，往返过程会丢掉 domain 的前导点；而 `DeleteCookie` 按 (name, domain,
/// path) **精确匹配**，于是 `.iwencai.com` / `.10jqka.com.cn` 这类 domain cookie 一条
/// 都删不掉（只有 host-only 能删）。原生接口不经过 `Cookie` 对象，能把带点的 domain
/// 原样传下去，所以每一条都先试 `.{bare}`（domain cookie），再试 `{bare}`（host-only）。
///
/// `with_webview` 会阻塞到主线程执行完闭包，所以：
/// - 只能在 async command（非主线程）里调用，否则 Windows 上死锁；
/// - 闭包要求 `Send + 'static`，这里只捕获 `Vec<targets>` 与 `Sender`。
#[cfg(windows)]
fn delete_login_cookies_native(
    window: &tauri::WebviewWindow,
    targets: Vec<(String, String, String)>,
) -> Result<Vec<String>> {
    use std::sync::mpsc;
    use std::time::Duration;

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2CookieManager, ICoreWebView2_2,
    };
    use windows_core::{Interface, HSTRING};

    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let (tx, rx) = mpsc::channel::<Vec<String>>();
    window.with_webview(move |platform| {
        let mut failures: Vec<String> = Vec::new();
        let setup = (|| -> windows_core::Result<ICoreWebView2CookieManager> {
            let controller = platform.controller();
            let core = unsafe { controller.CoreWebView2() }?;
            let core2: ICoreWebView2_2 = core.cast()?;
            unsafe { core2.CookieManager() }
        })();
        match setup {
            Ok(manager) => {
                for (name, bare, path) in &targets {
                    let name_h = HSTRING::from(name.as_str());
                    let path_h = HSTRING::from(path.as_str());
                    // domain cookie 用带点的写法，host-only 用裸域名；两者互不影响。
                    // 只有两种写法都报错才算这条删除失败（单边报错很可能是该写法不适用）。
                    let mut last_error: Option<String> = None;
                    let mut succeeded = false;
                    for domain in [format!(".{bare}"), bare.clone()] {
                        let domain_h = HSTRING::from(domain.as_str());
                        match unsafe {
                            manager.DeleteCookiesWithDomainAndPath(&name_h, &domain_h, &path_h)
                        } {
                            Ok(()) => succeeded = true,
                            // 只记名字 / 域 / path，绝不记 value。
                            Err(error) => last_error = Some(format!("{name}@{domain}{path}: {error}")),
                        }
                    }
                    if !succeeded {
                        if let Some(error) = last_error {
                            failures.push(error);
                        }
                    }
                }
            }
            Err(error) => failures.push(format!("获取 WebView2 CookieManager 失败：{error}")),
        }
        let _ = tx.send(failures);
    })?;
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(failures) => Ok(failures),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err(anyhow!("删除 Cookie 超时（WebView2 未在 5 秒内响应）"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(anyhow!("删除 Cookie 失败（WebView2 回调未返回）"))
        }
    }
}

/// 非 Windows 目标只做占位（本项目只发布 Windows 版）。
#[cfg(not(windows))]
fn delete_login_cookies_native(
    _window: &tauri::WebviewWindow,
    _targets: Vec<(String, String, String)>,
) -> Result<Vec<String>> {
    Err(anyhow!("仅 Windows 支持退出登录"))
}

/// 退出登录：bump 会话世代（在跑的 sync 放弃写库）→ 关登录窗口 → 用 WebView2 原生接口
/// 删除**所有**登录域 Cookie（含 domain cookie / host-only / HttpOnly）→ 清空镜像表 →
/// 复验 Cookie 是否清空。
///
/// 读 Cookie 用 `main` 的 `cookies()`（整个 profile 的 store），不是 `cookies_for_url` ——
/// 后者看不到 `upass.10jqka.com.cn`、`stat.10jqka.com.cn` 这类 host-only Cookie。
pub async fn logout(app: &AppHandle, db_path: &Path) -> Result<()> {
    bump_session_epoch();
    close_login(app).await?;

    let mut errors: Vec<String> = Vec::new();
    let window = app.get_webview_window("main");
    if window.is_none() {
        errors.push("主窗口不存在，无法读取浏览器 Cookie".to_string());
    }
    if let Some(window) = &window {
        match window.cookies() {
            Ok(cookies) => {
                let triples: Vec<(String, Option<String>, Option<String>)> = cookies
                    .iter()
                    .map(|cookie| {
                        (
                            cookie.name().to_string(),
                            cookie.domain().map(str::to_string),
                            cookie.path().map(str::to_string),
                        )
                    })
                    .collect();
                let targets = login_cookie_targets(&triples);
                match delete_login_cookies_native(window, targets) {
                    Ok(failures) => errors.extend(failures),
                    Err(error) => errors.push(error.to_string()),
                }
            }
            Err(error) => errors.push(format!("读取浏览器 Cookie 失败：{error}")),
        }
    }

    // 本地镜像无论如何都要清掉（登录态已不可信）。
    let conn = db::connect(db_path)?;
    db::clear_iwc(&conn)?;

    // 复验：登录域 Cookie 必须为 0，否则说明还有会话残留。
    if let Some(window) = &window {
        match window.cookies() {
            Ok(cookies) => {
                let remaining = cookies
                    .iter()
                    .filter(|cookie| is_login_domain(cookie.domain().unwrap_or_default()))
                    .count();
                if remaining > 0 {
                    errors.push(format!("仍有 {remaining} 条登录 Cookie 未清除"));
                }
            }
            Err(error) => errors.push(format!("复验 Cookie 失败：{error}")),
        }
    }

    if !errors.is_empty() {
        // 明细最多列 3 条，避免错误 toast 过长；绝不包含 Cookie 值。
        let mut shown: Vec<&str> = errors.iter().take(3).map(String::as_str).collect();
        if errors.len() > 3 {
            shown.push("等");
        }
        let summary = shown.join("；");
        eprintln!("logout: {} 项未完成（{summary}）", errors.len());
        return Err(anyhow!(
            "已清空本地镜像，但退出登录未完全成功（{} 项）：{summary}",
            errors.len()
        ));
    }
    Ok(())
}

/* ————————————————— 名称补全 ————————————————— */

/// 收集需要补名称的代码：两路数据里 `name` 为空的项，去重保序（自选股在前）。
fn missing_name_codes(plates: &[IwcPlate], self_stocks: &[IwcStock]) -> Vec<String> {
    let mut codes: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for stock in self_stocks
        .iter()
        .chain(plates.iter().flat_map(|plate| plate.members.iter()))
    {
        if stock.code.is_empty() || !stock.name.trim().is_empty() {
            continue;
        }
        if seen.insert(stock.code.clone()) {
            codes.push(stock.code.clone());
        }
    }
    codes
}

/// 行情返回的「代码 → 名称」；空代码 / 空名称跳过。
fn quote_names(quotes: &[StockQuote]) -> HashMap<String, String> {
    let mut names: HashMap<String, String> = HashMap::new();
    for quote in quotes {
        let code = quote.code.trim();
        let name = quote.name.trim();
        if code.is_empty() || name.is_empty() {
            continue;
        }
        names.insert(code.to_string(), name.to_string());
    }
    names
}

/// 把名称回填到板块成分股与自选股（只填空名称，不覆盖接口自带的名称）。
/// 返回回填条数。
fn apply_stock_names(
    plates: &mut [IwcPlate],
    self_stocks: &mut [IwcStock],
    names: &HashMap<String, String>,
) -> usize {
    let mut filled = 0;
    for stock in self_stocks.iter_mut() {
        if fill_stock_name(stock, names) {
            filled += 1;
        }
    }
    for plate in plates.iter_mut() {
        for member in plate.members.iter_mut() {
            if fill_stock_name(member, names) {
                filled += 1;
            }
        }
    }
    filled
}

fn fill_stock_name(stock: &mut IwcStock, names: &HashMap<String, String>) -> bool {
    if !stock.name.trim().is_empty() {
        return false;
    }
    match names.get(&stock.code) {
        Some(name) => {
            stock.name = name.clone();
            true
        }
        None => false,
    }
}

/// 按 ≤60 只/批向行情接口取名。名称是 best-effort：返回「已取到的名称」+「失败批次的
/// 股票数」，由调用方聚合成一条简短 warning —— **不把 reqwest 的完整 URL**
/// （一屏几十个 secid、几千字符）写进界面，否则「同步提示」会横向溢出。
async fn fetch_quote_names(
    client: &reqwest::Client,
    codes: &[String],
) -> (HashMap<String, String>, usize) {
    let mut names: HashMap<String, String> = HashMap::new();
    let mut failed = 0usize;
    for batch in codes.chunks(NAME_BATCH) {
        match source::fetch_stock_quotes(client, batch).await {
            Ok(quotes) => names.extend(quote_names(&quotes)),
            Err(_) => failed += batch.len(),
        }
    }
    (names, failed)
}

/// 名称补全失败的聚合 warning：只报数量，不带 URL / query（保持一行内可读）。
fn quote_name_warning(failed: usize) -> Option<String> {
    (failed > 0).then(|| format!("行情名称补全失败（{failed} 只），下次同步会重试"))
}

/// 自选股合并规则：抓取成功（含「确实为空」）以新数据为准；抓取失败（`None`）
/// 保留上一次落库的旧列表，别让一次失败把自选股清空。
fn merge_self_stocks(fresh: Option<Vec<IwcStock>>, previous: &[IwcStock]) -> Vec<IwcStock> {
    match fresh {
        Some(list) => list,
        None => previous.to_vec(),
    }
}

/// 把「本次新取到名称」的股票整理成落库行（代码 / 名称 / 市场），按代码去重。
/// 只收本次真正补到名称的 code，已有名称的股票不会重复写库。
fn new_name_rows(
    plates: &[IwcPlate],
    self_stocks: &[IwcStock],
    fetched: &HashMap<String, String>,
) -> Vec<(String, String, String)> {
    let mut rows: Vec<(String, String, String)> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for stock in self_stocks
        .iter()
        .chain(plates.iter().flat_map(|plate| plate.members.iter()))
    {
        if stock.name.trim().is_empty()
            || !fetched.contains_key(&stock.code)
            || !seen.insert(stock.code.as_str())
        {
            continue;
        }
        rows.push((stock.code.clone(), stock.name.clone(), stock.market.clone()));
    }
    rows
}

/* ————————————————— 同步 ————————————————— */

/// 读 cookie → 抓同花顺自选股（失败只 warning，且保留旧列表）→ 抓问财自选板块
/// （全失败则 Err 且**不动旧数据**）→ 补名称（先查 DB，再按 ≤60/批问行情，失败只 warning）
/// → 检查会话世代 → 覆盖写库 → 回读快照。
pub async fn sync(app: &AppHandle, client: &reqwest::Client, db_path: &Path) -> Result<IwcSnapshot> {
    // 会话世代：logout 会 bump；写库前比对，退出登录后旧同步不得把数据写回来。
    let epoch = session_epoch();
    let iwc_cookies = read_cookies(app, IWC_ORIGIN).await;
    let ths_cookies = read_cookies(app, THS_ORIGIN).await;
    let user_id_raw = cookie_value(&iwc_cookies, &["userid"])
        .map(str::to_string)
        .unwrap_or_default();
    if user_id_raw.is_empty() {
        return Err(anyhow!("请先登录同花顺/问财"));
    }
    let user_id = mask_user_id(&user_id_raw);
    let iwc_cookie_header = join_cookie_header(&iwc_cookies);
    let ths_cookie_header = join_cookie_header(&ths_cookies);

    let mut conn = db::connect(db_path)?;
    // 旧镜像：自选股部分失败时用它兜底。
    let previous = db::load_iwc_snapshot(&conn)?.unwrap_or_default();
    let mut warnings: Vec<String> = Vec::new();

    // 同花顺自选股与问财板块互不依赖：自选股失败只加 warning + 保留旧列表。
    let fresh_self = if ths_cookie_header.is_empty() {
        warnings.push("未读到同花顺登录 Cookie，自选股保留上次同步结果".to_string());
        None
    } else {
        match source::fetch_ths_self_stocks(client, &ths_cookie_header).await {
            Ok(list) => Some(list),
            Err(error) => {
                warnings.push(format!("同花顺自选股拉取失败，保留上次结果：{error}"));
                None
            }
        }
    };
    let mut self_stocks = merge_self_stocks(fresh_self, &previous.self_stocks);

    let mut plates = match source::fetch_iwc_plates(client, &iwc_cookie_header, &user_id_raw).await {
        Ok(plates) => plates,
        // 板块全失败：返回 Err，且此时还没写库，旧数据原样保留。
        Err(error) => return Err(error),
    };

    // 名称：先查 DB 里已有的（避免每次同步重发同样的行情请求），剩下的才配额取。
    let pending = missing_name_codes(&plates, &self_stocks);
    if !pending.is_empty() {
        let db_names = db::stock_names(&conn, &pending)?;
        apply_stock_names(&mut plates, &mut self_stocks, &db_names);
    }
    let mut name_codes = missing_name_codes(&plates, &self_stocks);
    if name_codes.len() > NAME_LOOKUP_LIMIT {
        warnings.push(format!(
            "自选股 / 成分股过多，本次仅补全前 {} 只的名称",
            NAME_LOOKUP_LIMIT
        ));
        name_codes.truncate(NAME_LOOKUP_LIMIT);
    }
    let mut fetched_names: HashMap<String, String> = HashMap::new();
    if !name_codes.is_empty() {
        let (names, failed) = fetch_quote_names(client, &name_codes).await;
        fetched_names = names;
        apply_stock_names(&mut plates, &mut self_stocks, &fetched_names);
        if let Some(warning) = quote_name_warning(failed) {
            warnings.push(warning);
        }
    }

    // 退出登录竞态：到这一步说明数据都齐了，写库前再确认会话没被 logout 换代。
    if session_epoch() != epoch {
        return Err(anyhow!("已退出登录"));
    }

    // 只把本次新补到的名称写进 `stocks` 表（只补空名、不动 updated_at）。
    let name_rows = new_name_rows(&plates, &self_stocks, &fetched_names);
    if let Err(error) = db::fill_stock_names(&conn, &name_rows) {
        warnings.push(format!("名称写库失败：{error}"));
    }
    let snapshot = IwcSnapshot {
        plates,
        self_stocks,
        synced_at: db::now_ts(),
        user_id,
        warnings: warnings.clone(),
    };
    db::save_iwc_snapshot(&mut conn, &snapshot)?;
    // 回读：名称补齐走 DB（limit_up_history 优先，其次 stocks 表），保证「看到的就是库里的」。
    let mut saved = db::load_iwc_snapshot(&conn)?.ok_or_else(|| anyhow!("同步结果回读失败"))?;
    saved.warnings = warnings;
    Ok(saved)
}

/* ————————————————— 测试 ————————————————— */

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(name: &str, value: &str) -> (String, String) {
        (name.to_string(), value.to_string())
    }

    #[test]
    fn cookie_header_join_skips_empty_and_duplicates() {
        let list = vec![
            cookie("userid", "12345"),
            cookie("v", "abc"),
            cookie("empty", ""),
            cookie("", "orphan"),
            cookie("userid", "99999"),
            cookie("  spaced  ", " 1 "),
        ];
        assert_eq!(join_cookie_header(&list), "userid=12345; v=abc; spaced=1");
        assert_eq!(join_cookie_header(&[]), "");
    }

    #[test]
    fn user_id_masking_keeps_edges() {
        assert_eq!(mask_user_id("1234567890"), "123****90");
        assert_eq!(mask_user_id("abc"), "a****");
        assert_eq!(mask_user_id(""), "");
        assert_eq!(mask_user_id("   "), "");
        // 原始值绝不原样返回
        assert!(!mask_user_id("abcdefgh").contains("def"));
    }

    #[test]
    fn login_state_reads_expected_cookie_names() {
        let iwc = vec![cookie("userid", "888888"), cookie("v", "token")];
        assert_eq!(cookie_value(&iwc, &["userid"]), Some("888888"));
        // 精确匹配：匿名访问者的常见 cookie 不能算登录。
        let anonymous = vec![
            cookie("searchGuide", "1"),
            cookie("Hm_lvt_1234", "1700000000"),
            cookie("v", "token"),
        ];
        assert!(cookie_value(&anonymous, &["userid"]).is_none());
        // 名字里「含 userid」但并不是 userid 的，也不再算登录（不做模糊匹配）。
        let variant = vec![cookie("userid_ths", "42")];
        assert!(cookie_value(&variant, &["userid"]).is_none());
        // 同花顺只看明确的会话 cookie 名。
        assert!(cookie_value(&vec![cookie("ticket", "x")], &THS_SESSION_COOKIES).is_some());
        assert!(cookie_value(&vec![cookie("escapename", "u")], &THS_SESSION_COOKIES).is_some());
        assert!(cookie_value(&vec![cookie("userid", "9")], &THS_SESSION_COOKIES).is_some());
        assert!(cookie_value(&anonymous, &THS_SESSION_COOKIES).is_none());
    }

    #[test]
    fn popup_hosts_stay_inside_app() {
        assert!(host_allowed(&"https://passport.10jqka.com.cn/".parse().unwrap()));
        assert!(host_allowed(&"https://www.iwencai.com/unifiedwap/".parse().unwrap()));
        // 「先开空白窗再跳转」的写法
        assert!(host_allowed(&Url::parse("about:blank").unwrap()));
        assert!(!host_allowed(&"https://example.com/login".parse().unwrap()));
        assert!(!host_allowed(&"https://evil-10jqka.com.cn/".parse().unwrap()));
    }

    /// 退出登录的域名筛选：带前导点的 domain cookie 与 host-only 子域都要命中。
    #[test]
    fn logout_domain_filter_covers_host_only_cookies() {
        for domain in [
            ".10jqka.com.cn",
            "10jqka.com.cn",
            "upass.10jqka.com.cn",
            "stat.10jqka.com.cn",
            "t.10jqka.com.cn",
            ".iwencai.com",
            "www.iwencai.com",
            "hexin.cn",
            "uc.hexin.com",
        ] {
            assert!(is_login_domain(domain), "{domain} 应该被识别为登录域");
        }
        for domain in ["", " ", ".example.com", "evil-10jqka.com.cn", "10jqka.com.cn.evil.com"] {
            assert!(!is_login_domain(domain), "{domain} 不应该被识别为登录域");
        }
    }

    /// 自选股：抓取失败保留旧列表；成功（含确实为空）以新数据为准。
    #[test]
    fn self_stocks_survive_partial_failure() {
        let previous = vec![named_stock("000001", "0", "平安银行")];
        assert_eq!(merge_self_stocks(None, &previous), previous);
        assert!(merge_self_stocks(Some(Vec::new()), &previous).is_empty());
        let fresh = vec![named_stock("600000", "1", "浦发银行")];
        assert_eq!(merge_self_stocks(Some(fresh.clone()), &previous), fresh);
        assert!(merge_self_stocks(None, &[]).is_empty());
    }

    fn plate_with(members: Vec<IwcStock>) -> IwcPlate {
        IwcPlate {
            sn: "sn-1".to_string(),
            name: "板块".to_string(),
            condition: String::new(),
            sort: 0,
            members,
        }
    }

    fn named_stock(code: &str, market: &str, name: &str) -> IwcStock {
        IwcStock {
            code: code.to_string(),
            market: market.to_string(),
            name: name.to_string(),
        }
    }

    /// 待补名称的代码：只收空名称、去重、自选股在前。
    #[test]
    fn missing_name_codes_dedupes_and_skips_named() {
        let plates = vec![
            plate_with(vec![
                named_stock("600000", "1", ""),
                named_stock("600519", "1", "贵州茅台"),
            ]),
            plate_with(vec![named_stock("600000", "1", "")]),
        ];
        let self_stocks = vec![
            named_stock("000001", "0", ""),
            named_stock("600000", "1", ""),
        ];
        assert_eq!(missing_name_codes(&plates, &self_stocks), vec!["000001", "600000"]);
        assert!(missing_name_codes(&[], &[]).is_empty());
    }

    /// 名称回填：只填空名称、不覆盖接口自带名称；假行情列表即可（不联网）。
    #[test]
    fn stock_names_backfill_from_quotes() {
        let mut plates = vec![plate_with(vec![
            named_stock("600000", "1", ""),
            named_stock("600519", "1", "贵州茅台"),
            named_stock("300750", "0", ""),
        ])];
        let mut self_stocks = vec![named_stock("000001", "0", "")];

        let quotes = vec![
            StockQuote { code: "600000".into(), name: "浦发银行".into(), ..Default::default() },
            StockQuote { code: "000001".into(), name: "平安银行".into(), ..Default::default() },
            // 行情里没有 300750（停牌 / 接口缺行）→ 名称保持空串
            StockQuote { code: "600000".into(), name: "  ".into(), ..Default::default() },
        ];
        let fetched = quote_names(&quotes);
        let filled = apply_stock_names(&mut plates, &mut self_stocks, &fetched);
        assert_eq!(filled, 2);
        assert_eq!(plates[0].members[0].name, "浦发银行");
        assert_eq!(plates[0].members[1].name, "贵州茅台");
        assert_eq!(plates[0].members[2].name, "");
        assert_eq!(self_stocks[0].name, "平安银行");

        // 只有「本次新补到名称」的 code 才落库；已有名称的 600519 不重复写。
        let rows = new_name_rows(&plates, &self_stocks, &fetched);
        assert_eq!(
            rows,
            vec![
                ("000001".to_string(), "平安银行".to_string(), "0".to_string()),
                ("600000".to_string(), "浦发银行".to_string(), "1".to_string()),
            ]
        );
        assert!(new_name_rows(&plates, &self_stocks, &HashMap::new()).is_empty());

        // 空行情 / 空名称不进 map，也不制造脏名称。
        assert!(quote_names(&[]).is_empty());
        assert!(quote_names(&[StockQuote { code: "600000".into(), ..Default::default() }]).is_empty());
    }

    /// 名称补全失败的 warning 只报数量：不含 URL / query，长度可控（界面一行内可读）。
    #[test]
    fn quote_name_warning_is_short_aggregate() {
        assert!(quote_name_warning(0).is_none());
        let warning = quote_name_warning(60).unwrap();
        assert!(warning.contains("行情名称补全失败"), "{warning}");
        assert!(warning.contains("60 只"), "{warning}");
        assert!(!warning.contains("http"), "{warning}");
        assert!(!warning.contains("secid"), "{warning}");
        assert!(!warning.contains('?'), "{warning}");
        assert!(warning.chars().count() < 60, "{warning}");
        // 多批失败也只聚合成一条。
        assert!(quote_name_warning(300).unwrap().contains("300 只"));
    }

    /// 会话世代：logout bump 后，旧 sync 的 epoch 判定应失效。
    #[test]
    fn session_epoch_changes_on_logout() {
        let epoch = session_epoch();
        assert_eq!(session_epoch(), epoch);
        bump_session_epoch();
        assert_ne!(session_epoch(), epoch);
    }

    /// 退出登录的删除目标：domain cookie 去点 + host-only 原样 + path 默认 "/"，
    /// 非登录域 / 空名字 / 无 domain 的跳过，重复项去重。
    #[test]
    fn login_cookie_targets_cover_domain_and_host_only() {
        let cookies = vec![
            ("userid".to_string(), Some(".iwencai.com".to_string()), Some("/".to_string())),
            ("v".to_string(), Some(".iwencai.com".to_string()), None),
            (
                "PHPSESSID".to_string(),
                Some("upass.10jqka.com.cn".to_string()),
                Some("/".to_string()),
            ),
            ("uid".to_string(), Some("stat.10jqka.com.cn".to_string()), Some("/".to_string())),
            ("ticket".to_string(), Some(".10jqka.com.cn".to_string()), Some("/".to_string())),
            ("other".to_string(), Some(".example.com".to_string()), Some("/".to_string())),
            (String::new(), Some(".iwencai.com".to_string()), Some("/".to_string())),
            ("nodomain".to_string(), None, Some("/".to_string())),
            // 同一条重复出现只删一次
            ("userid".to_string(), Some(".iwencai.com".to_string()), Some("/".to_string())),
        ];
        let targets = login_cookie_targets(&cookies);
        assert_eq!(targets.len(), 5);
        assert!(targets.contains(&("userid".into(), "iwencai.com".into(), "/".into())));
        assert!(targets.contains(&("v".into(), "iwencai.com".into(), "/".into())));
        assert!(targets
            .contains(&("PHPSESSID".into(), "upass.10jqka.com.cn".into(), "/".into())));
        assert!(targets.contains(&("uid".into(), "stat.10jqka.com.cn".into(), "/".into())));
        assert!(targets.contains(&("ticket".into(), "10jqka.com.cn".into(), "/".into())));
        // 传给 COM 的 domain 一律是裸域名（带点/不带点两种写法由删除逻辑各自再试）。
        assert!(targets.iter().all(|(_, domain, _)| !domain.starts_with('.')));
        assert!(login_cookie_targets(&[]).is_empty());
    }
}
