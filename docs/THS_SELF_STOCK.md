# 其他 · 同花顺自选 · 实现契约

> 本文件记录「登录同花顺 / 问财 → 只读同步自选板块与自选股」的实现边界。
> 登录态不落库；同步结果落 SQLite；前端只通过 `src/lib/api.ts` 调命令。

## 1. 命令

| command | 入参 | 返回 | 说明 |
|---|---|---|---|
| `iwc_auth_status` | — | `IwcAuthStatus` | 读两个域的 Cookie，返回是否登录 + 脱敏账号；读失败按未登录处理，不抛错 |
| `iwc_open_login` | — | `()` | 打开应用内 WebView2 登录窗口（`iwc-login`），已存在则聚焦 |
| `iwc_close_login` | — | `()` | 关闭登录窗口及其 popup |
| `iwc_login_window_open` | — | `bool` | 登录窗口是否仍打开（前端轮询用，避免用户关窗后一直等待） |
| `iwc_logout` | — | `()` | 删除两域 Cookie + 清空 4 张镜像表 |
| `iwc_sync` | — | `IwcSnapshot` | 读 Cookie → 拉问财板块 + 同花顺自选股 → 覆盖写库 → 返回快照 |
| `iwc_get_snapshot` | — | `IwcSnapshot \| null` | 只读本地镜像 |

类型（Rust/TS 均 camelCase）：

```ts
IwcAuthStatus { iwcLoggedIn: boolean; thsLoggedIn: boolean; userId: string }
IwcStock { code: string; market: string; name: string }   // market: "1"=沪 "0"=深
IwcPlate { sn: string; name: string; condition: string; sort: number; members: IwcStock[] }
IwcSnapshot { plates: IwcPlate[]; selfStocks: IwcStock[]; syncedAt: number; userId: string; warnings: string[] }
```

## 2. 登录与 Cookie

- 登录窗口：`WebviewWindowBuilder` 打开 `https://www.iwencai.com/`，尺寸约 560×780；popup 优先 `NewWindowResponse::Create`（同 profile），失败才 `Deny + navigate`，不允许跳系统浏览器。
- Cookie：`main` 窗口 `cookies_for_url`（`https://www.iwencai.com/` 与 `https://t.10jqka.com.cn/`），包含 HttpOnly；只在 async command 内调用（Windows 同步调用会死锁）。
- **不持久化 Cookie**：登录态由 WebView2 profile（`%LOCALAPPDATA%\com.godstock.tianti`）承载；SQLite 只存脱敏 `user_id` 与同步时间。
- 退出：先 bump 会话 epoch、关闭登录窗；用 `main.cookies()` 取全量，按登录域后缀筛选后，通过 WebView2 `ICoreWebView2CookieManager::DeleteCookiesWithDomainAndPath` 按 `(name, domain, path)` 精确删除（domain cookie 带前导点、host-only 用裸域名各试一次；wry 的 `delete_cookie` 会丢前导点，不可用），再复验登录域 cookie 数为 0；失败返回 Err（本地 4 表仍清空）。不调用 `clear_all_browsing_data`（避免清掉整个 profile）。
- 日志：只允许打印 Cookie 名称/数量，绝不打印值。

## 3. 上游接口

- 问财自选板块：`GET https://www.iwencai.com/gateway/userstore/iwc/userinfo/self-stock/plate/list?stocks=1&ths=0` 与 `stocks=0`，`Cookie` 全量透传 + `X-User-Id` + `Referer`。按 `sn`（缺失用 `ln`）合并；仍缺成分股时走 legacy `POST /unifiedwap/self-stock/plate/list`。响应包装兼容 `result / data / data.plate_list / data.list / result.plate_list`。
- 同花顺自选股：`GET https://t.10jqka.com.cn/newcircle/group/getSelfStockWithMarket`，`{errorCode,errorMsg,result:[{marketid,code}]}`；marketid 17/20/22→沪、33/36/32→深，其余忽略。
- 保留 6 位 A 股与场内基金/ETF（沪 `5xxxxx`、深 `15/16/18`）；过滤同花顺/中证指数（`88xxxx`、`399xxx`、`93xxxx`、`99xxxx`）、债券（`11x/12x`）、B 股（`900/200`）。`sn/ln/xn` 原样保存（`xn` 为动态板块条件）；列表顺序即 `sort`。
- ETF / 场内基金：板块成分与自选股都会保留（沪 `5xxxxx`、深 `15/16/18`）。日 / 周 / 月 K 线先试东财（`1.510300` / `0.159915`），东财不可用时回退腾讯**不复权** `kline/kline`；1 分钟 K 线视图仍只认东财（取不到会明确报错），分时视图会回退腾讯分钟点位。页面页脚仍写「前复权」，ETF 走腾讯兜底时实际为不复权数据。
- 名称：同步后对空名称按 ≤60 只/批调用本地行情接口补齐（单批失败只 warning，单次上限 1200 只），仍为空则前端显示代码；补到的名称写入本地 `stocks` 搜索缓存表（副作用：这些股票会出现在本地搜索里）。

## 4. 表结构

```sql
CREATE TABLE IF NOT EXISTS iwc_plate (
  sn TEXT PRIMARY KEY, name TEXT NOT NULL, condition TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS iwc_plate_member (
  sn TEXT NOT NULL, code TEXT NOT NULL, market TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sn, code)
);
CREATE TABLE IF NOT EXISTS iwc_self_stock (
  code TEXT NOT NULL, market TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (code, market)
);
CREATE TABLE IF NOT EXISTS iwc_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1), user_id TEXT NOT NULL DEFAULT '',
  synced_at INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT ''
);
```

- 同步采用事务内 DELETE + INSERT（覆盖式）；板块失败**不写库**，旧镜像保留。
- `clear_cache` 一并清这 4 张表；不需要迁移版本键（`CREATE TABLE IF NOT EXISTS` 自动补表）。

## 5. 前端

- K线右侧栏：新增第三个页签「同花顺」（`state.chartDock = "watch" | "insight" | "iwc"`），只读列出已同步板块；点板块就地展开成分股，点股票直接换 K 线；「自选」页底部另有「同花顺自选」入口直达该页签。
- 涨幅：成分股/自选股用现有批量行情命令（`get_stock_quotes`，80 只/批）补最新价与涨幅，前端缓存 60 秒；「其他」表格有独立涨幅列，K 线侧栏行内直接显示。排序按钮循环「默认 → 涨幅↓ → 涨幅↑」，无行情的股票排在最后。当前 K 线对应的股票在侧栏/表格中高亮。

- 位置：「其他」页模块切换 → 同花顺自选；`OtherModule = "lhb" | "iwc"`，状态字段 `otherModule / iwcAuth / iwcSnapshot / iwcLoading / iwcSyncing / iwcLoginPending / iwcError / iwcTab / iwcPlateSn`。
- 首次进入：读登录态 + 本地镜像；已登录且镜像为空/超过 10 分钟 → 静默同步一次。
- 登录：点登录 → 打开窗口 → 每 2 秒轮询 `iwc_auth_status` + `iwc_login_window_open`；登录成功自动关窗并同步；窗口被关闭且未登录 → 提示重试；5 分钟超时兜底。
- 导入：`data-iwc-import="plate:<sn>" / "self"` → 复用统一自选分组弹层（`openWatchAddDialog`），只写入本地 `watch_groups`，不触碰问财。
- 数据属性：`data-other-module`、`data-iwc-login`、`data-iwc-sync`、`data-iwc-logout`、`data-iwc-tab`、`data-iwc-plate`、`data-iwc-import`、`data-iwc-stock`（+ `data-iwc-name` / `data-iwc-market`）。

## 6. 未验证 / 风险

- 已实测：登录窗口能加载问财真实页面（`https://www.iwencai.com/screener`），真实账号可完成登录并同步（开发机实测拉回 71 个板块、1740 只成分股、69 只自选股（其中「ETF」板块 106 只），指数/债券/B 股已过滤、ETF 与场内基金保留，脱敏 userId 正常）；popup 登录分支、登录态复用是否触发风控仍需更多样本。
- 已实测「main 窗口能读到登录窗口 Cookie」：两个窗口共享同一 WebView2 profile，登录后主窗口 `cookies_for_url` 能读到问财/同花顺 Cookie。
- 已实测退出登录：真实 profile 的 30 条登录域 Cookie 退出后为 0，`iwc_auth_status` 立即返回未登录；随后从备份恢复 profile 与登录态、重新同步取回数据（仅测试用）。
- 问财 `userstore/iwc/...` 属新版内部路径，可能漂移；已做 legacy 与多形态容错。
- 动态板块的 `xn` 只展示条件文本，不执行问财动态选股（那需要 `hexin-v` 与冷却，风险更高）。
- 登录态过期后需重新登录；`v` token 约 120 分钟（脚本证据），Rust 复用可能触发风控。
