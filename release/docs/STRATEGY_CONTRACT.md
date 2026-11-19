# 策略面板 · 实现契约

> 本文件是跨写域契约，主代理制定；子代理不得改字段名/命令名/返回结构。
> 类型定义已在 `src/lib/types.ts` 与 `src-tauri/src/models.rs` 写好，以那里为准。

## 1. 命令

| command | 入参 | 返回 | 说明 |
|---|---|---|---|
| `get_history_status` | — | `HistoryStatus` | 历史覆盖范围与是否同步中 |
| `sync_limit_history` | `{ days: number, refresh: boolean }` | `HistoryStatus` | 回填/增量；同步中触发 `history:progress` |
| `get_strategy_profile` | — | `StrategyProfile` | 单行配置 |
| `save_strategy_profile` | `{ profile: StrategyProfile }` | `StrategyProfile` | 校验并落库 |
| `run_first_to_second` | `{ date: string, refresh?: boolean }` | `ScreenResult` | 只读筛选，不写当日快照；`refresh=true` 强制重算日K统计 |
| `capture_auction` | `{ date: string }` | `AuctionResult` | 09:25–09:30 采样；非窗口也允许但 `inWindow=false` |
| `get_auction` | `{ date: string }` | `AuctionResult` | 读已存快照；没有则 `captured=false` |

事件：`history:progress`，payload `{ done: number, total: number, current: string }`。

## 2. 表结构

```sql
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
CREATE INDEX IF NOT EXISTS idx_limit_hist_code_date ON limit_up_history(code, date);

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
```

## 3. 计算口径

- 首板：今日在 `limit_up_history`，上一交易日在 `limit_up_history` 不存在；历史不足时回退 `Stock.streak <= 1` 并写 warning。
- `limit_up_120d`：最近 120 个交易日（以 `trade_days` 为准），含当日，`COUNT(*)`。
- `max_streak_250d`：最近 250 个交易日 `MAX(streak)`。
- `max_gain_20d`：日 K 收盘价的 20 日滚动涨幅最大值（最近 250 根内），百分比。
- 成交额：`Stock.amount > 0` 用实际值（腾讯报价补齐）；否则 `turnover_rate/100*float_cap` 估算，`amountEstimated=true`。
- 封单比：`seal_amount / 成交额`；成交额 <=0 时为 `null`。
- 首封分钟：`(first_seal 北京时间当天 0 点起的分钟) - 570`；09:30=0，09:25=-5。
- 板块：取 `limit_up_num` 最大、再按 `continuous_num` 最大的板块。
- 规则通过：`passed=true`；数据不足：`passed=null`，不得当通过；最终候选只收 `passed=true`。

## 4. 前端 state

```ts
strategyTab: "firstToSecond" | "auction" | "library";
screen: ScreenResult | null;
screenLoading: boolean;
screenError: string | null;
history: HistoryStatus | null;
historyProgress: { done: number; total: number; current: string } | null;
profile: StrategyProfile | null;
profileOpen: boolean;
profileSaving: boolean;
auction: AuctionResult | null;
auctionLoading: boolean;
strategyDetailCode: string | null;
strategyShowExcluded: boolean;
```

路由：`#/strategy`；`ViewName` 已含 `"strategy"`。

## 5. 视图数据属性（main.ts 事件委托依赖）

| 属性 | 用途 |
|---|---|
| `data-strategy-tab="firstToSecond\|auction\|library"` | 切换页签 |
| `data-strategy-run` | 运行筛选 |
| `data-history-sync` | 回填历史 |
| `data-open-profile` | 打开参数面板 |
| `data-profile-save` | 保存参数 |
| `data-profile-close` | 关闭参数面板 |
| `data-strategy-refresh` | 刷新（清缓存重跑） |
| `data-strategy-show-excluded` | 展开/收起被剔除 |
| `data-candidate-code` + `data-candidate-name` | 打开 K 线 |
| `data-candidate-detail` | 打开规则详情抽屉 |
| `data-candidate-watch` | 加入自选 |
| `data-auction-capture` | 采集竞价 |
| `data-strategy-export` | 导出候选 TXT |

## 6. 视觉约束

- 只用 `src/styles.css` 语义 token（`--bg/--surface/--line/--brass-*/--text/--mono/--serif`），双主题都成立。
- 复用 `.view`、`.chip`、`.seg`、`.pool-table` 的节奏；不新增高饱和色、不用大阴影。
- 动效只做淡入/1px 位移，遵循 `prefers-reduced-motion`。
- 1080×720 不横向溢出；表格次要列在该断点隐藏或缩写。
- 免责声明固定、低调，不抢主视觉。
