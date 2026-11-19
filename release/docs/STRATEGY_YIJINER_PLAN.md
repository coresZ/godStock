# 「首板一进二」筛选方案（先方案，后接入）

> 状态：方案已落地（P1–P3，P4 竞价采样已实现；P5 回测待定）。
> 目标：把「一进二」战法拆成可解释、可验证的规则，在 TianTi 里做**盘后筛选 + 次日竞价观察**。
> 边界：只做规则筛选与数据陈列，**不输出买卖建议、不保证收益**；视频里的收益表述未经证实，不应写进产品文案。

## 1. 结论先说

1. 战法可以拆成：**1 个首板池 + 5 个硬过滤 + 3 个强度检查 + 1 个规则分排序 + T+1 竞价清单**。
2. 现有数据能覆盖大部分硬指标：股价、流通市值、封单额、首封时间、开板次数、连板/天数、板块涨停/连板家数都有。
3. 真正缺三块：
   - **成交额**：同花顺涨停池接口不返回该字段，本地 `limit_up.amount` 76/76 全是 0；
   - **近 6–12 个月涨停历史**：本地只缓存用户看过的日期（样本库只有 2 天）；
   - **09:15–09:25 集合竞价**：代码、表、四个行情源里都没有。
4. 三块都能补：
   - 成交额：用现有腾讯批量报价补齐，精确到元（单次一条 HTTP 可拿 40–80 只）；
   - 历史：回填同花顺 `limit_up_pool` 按日接口，实测可回溯到 2025-11-19（约 250 个交易日），250 次请求约 1–2 分钟；
   - 竞价：只能在 09:25–09:30 用现有报价**实时采样**并落表；没有免费历史竞价，不能假装有。
5. **入口（已定）**：独立第 5 个一级入口「策略」，内部页签「一进二 / 竞价观察 / 策略库」，**不新增涨停池第 4 段**。这样后续策略共用同一套「规则 → 候选 → 证据 → 免责声明」结构，不用每次改涨停池的分段与表格。
6. 以 2026-11-18 缓存样本做漏斗：40 只涨停 → 32 只首板 → 25 只股价 ≤30 → 24 只流通 ≤200 亿 → **11 只当日开板 0 次**；历史与成交额补齐后，才会收敛到 3–5 只。

## 2. 战法拆解

### 2.1 时间线

| 时点 | 动作 | 是否可由程序完成 |
|---|---|---|
| T 日收盘后 | 取当日首板，五步过滤，三招强弱，取前 3 | ✅ 可完全自动化 |
| T+1 09:15–09:25 | 看竞价量、竞价涨幅、竞价换手 | ⚠️ 只能实时采样，无历史 |
| T+1 09:30–10:00 | 看高开后的承接、量能是否持续 | ⚠️ 盘中提示，不自动交易 |
| 封板瞬间 | 打板买入，用高价换确定性 | ❌ 只做清单与提醒，不接交易 |
| 封板失败 | 小单砸可等回封；大单出货且不回封，次日止损 | ❌ 人工执行 |
| 仓位 | 单票 ≤30%，盈利才加仓，亏损不补 | ❌ 只展示风控提示 |

### 2.2 规则表（默认参数来自视频，全部可调）

| 步骤 | 条件 | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| U0 首板池 | 今日涨停且上一交易日未涨停 | 硬过滤 | — | 用历史表判定；无历史时回退 `streak == 1` 并标记 |
| U1 排除项 | ST / *ST / 退市整理 / 上市首日新股 | 硬过滤 | 排除 | 视频未讲，但 5% 涨停与无涨跌幅限制会污染规则 |
| F1 股价 | `price <= 30` | 硬过滤 | 30.00 | 「小资金做大，高价弹性差」 |
| F2 流通市值 | `float_cap <= 200 亿` | 硬过滤 | 20,000,000,000 元 | 池接口 `currency_value` 单位就是元 |
| F3 涨停基因 | 近 120 个交易日涨停次数 `>= 3` | 硬过滤 | 3 次（含当日） | 回填历史后按 `limit_up_history` 计数 |
| F4 透支剔除 | 近 250 个交易日最大连板 `< 4` 且最大 20 日涨幅 `< 60%` | 硬过滤 | 4 板 / 60% | 「一年内四连板或大涨过」的量化；大涨阈值待拍板 |
| F5 板块效应 | 主板块涨停家数 `>= 3` 且连板家数 `>= 1` | 硬过滤 | 3 / 1 | 用 `sectors.limit_up_num` / `continuous_num` |
| S1 首封质量 | 非一字板；首封时间不晚于 10:00；换手率 `>= 5%` | 强度 | 10:00 / 5% | 「开盘后快速上冲 + 明显放量」 |
| S2 封板决心 | `open_num == 0` | 强度 | 0 次 | 「反复炸板」直接删；可放宽到 ≤1 做对比 |
| S3 封单强度 | `seal_amount / amount >= 10%` | 强度 | 10% | 需要补成交额；缺失时标记 unknown，不静默通过 |
| R 排序 | 首封 40% + 封单比 30% + 板块 20% + 换手 10% | 排序 | 取前 3 | 只叫「规则分」，不叫「推荐度」 |

### 2.3 首板判定

- 推荐：`今日在 limit_up_history` 且 `上一交易日在 limit_up_history 中不存在`。
- 回退：`streak == 1`（现有字段），但 `streak` 有已知坑：板块接口失败时会回退成 `board`，把「4天3板」误算成 3 板。
- **不要**在首版直接用 `board == 1`：`board` 是窗口内涨停次数，像「4天3板」不是今天首板，但「4天3板后隔两天再来首板」又可能 `streak == 1`，必须看历史。

### 2.4 评分（0–100）

| 因子 | 权重 | 归一化 |
|---|---|---|
| 首封时间 | 40% | 09:30 → 1.0，10:00 → 0，线性 |
| 封单比 | 30% | 10% → 0，50% → 1.0，线性 |
| 板块强度 | 20% | 涨停家数 3→0、15→1；连板家数额外加分 |
| 换手/成交 | 10% | 5%–20% 区间内越接近 10% 越高 |

同分依次按：首封更早 → 封单比更高 → 成交额更大。
评分只用于排序展示，不构成收益预测。

### 2.5 视频里没量化、必须先拍板的地方

1. **「大涨」怎么定义**：一年内最大 20 日涨幅 ≥60%？还是区间涨幅 ≥100%？还是只看「四连板」？
2. **竞价 10%–15% 的口径**：竞价成交额 / 昨日成交额，还是竞价成交量 / 昨日成交量？（两者接近但不等价）
3. **首板是否包含 20cm**：创业板/科创板 20% 涨停的「一进二」风险与 10cm 不同，建议单独开关。
4. **一字板是否直接排除**：视频说真正龙头首板不会顶一字，但一字板也可能是强逻辑；建议默认排除、可开关。
5. **板块效应的阈值**：涨停 ≥3 且连板 ≥1 只是起点，是否要求板块排名前 5？
6. **F3 的「三次」是否含当日**：含当日 = 今天算一次；不含 = 之前已有三次。建议含当日并可调。

## 3. 现有数据盘点

### 3.1 已具备

| 数据 | 字段/表 | 单位/格式 | 备注 |
|---|---|---|---|
| 股价 | `Stock.price` / `limit_up.price` | 元 | 涨停池 76/76 有值 |
| 涨跌幅 | `change_rate` | % | 实测 9.79–10.03（10cm） |
| 换手率 | `turnover_rate` | % | 76/76 有值 |
| 流通市值 | `float_cap` | 元 | 15.7 亿–1549.7 亿 |
| 封单额 | `seal_amount` | 元 | 涨停池 76/76 有值 |
| 首封/末封 | `first_seal` / `last_seal` | epoch 秒 | 一字板 09:25，换手板 09:30 后 |
| 开板次数 | `open_num` | 次 | 约一半为 0 |
| 涨停类型 | `limit_type` | 「一字板 / 换手板」 | 实测无 T 字样本 |
| 板数/天数/连板 | `board` / `days` / `streak` | 整数 | `high_days_value` 高 16 位=板、低 16 位=天 |
| 高度文本 | `high_days` | 「4天3板」 | 空时兜底「N板」 |
| 封板成功率 | `success_rate` | % | 源为 0–1 小数 ×100 |
| 板块 | `sectors` | 涨停家数、连板家数、高度、涨幅 | 20 个板块/日 |
| 板块成分 | `sector_members` | 只含**当日涨停股** | 不是全板块成分股 |

### 3.2 缺什么

| 缺口 | 影响 | 证据 |
|---|---|---|
| **成交额恒 0** | S3 封单比、流动性判断、竞价量比都无法算 | `limit_up` 76/76、`pool_aux` 150/150 全为 0；THS 原始响应只有 `order_amount` / `order_volume`，没有 amount 键 |
| **历史涨停只有 2 天** | F3 近 6 月涨停次数、F4 近 1 年最大连板都算不了 | 样本库 `limit_up` 只有 20261117、20261118 |
| **竞价数据完全没有** | T+1 竞价规则无法回看 | 表/代码/四源均无 09:15–09:25 数据；腾讯分时显式过滤 09:15–09:29，东财 1m 首根 09:31 |
| 封单量未解析 | 少一个封单强度维度 | THS 返回 `order_volume`（如 780600 股），代码没读 |
| 报价换手率恒 0 | 竞价换手只能近似 | `parse_tencent_line` 写死 `turnover: 0.0`，腾讯字段串里有 5.42% |
| `streak` 回退风险 | 首板池可能漏股/误判 | 板块接口缺失时 `streak = board` |
| 板块成分只含涨停股 | 无法算板块涨停占比 | `sector_members` 仅涨停股 |
| 日 K 缓存无 TTL | 「大涨」统计可能用旧数据 | 缓存非空直接返回，实测停在 2026-11-17 |

### 3.3 成交额：不是「再找接口」，而是「用报价补齐」

- THS 涨停池返回字段：`order_volume`（封单量）、`order_amount`（封单额）、`currency_value`（流通市值）、`turnover_rate`，**没有成交额**。
- 腾讯批量报价 `https://qt.gtimg.cn/q=sz002463` 的字段 35 是 `现价/成交量/成交额`，成交额单位元；现有 `parse_tencent_line` 已经解析成 `StockQuote.amount`（实测 002463 = 8,186,049,499 元）。
- 一次 HTTP 可传 40–80 个代码，现有 `get_stock_quotes` 上限 80。
- 结论：当日涨停池抓完后，用一批报价回填 `limit_up.amount`；失败时保留 0，S3 标记 unknown。

### 3.4 历史：回填涨停池，不从 K 线硬推

- 实测 `limit_up_pool?date=20251119` 仍返回 54 只，`20251105` 返回 66 只；`20241202` 与更早返回空。可回溯约 1 年 ≈ 250 个交易日，正好覆盖 F3（120 日）与 F4（250 日）。
- 每个交易日 1 页请求（`limit=100` 足够，实测 40–118 只/日），250 天 ≈ 250 次，约 1–2 分钟；支持并发 4–6。
- 直接得到 `streak/board/days/high_days`，不用处理前复权、涨停价四舍五入、ST 5%/20cm/30cm 判定。
- **不要复用 `save_day`**：它会重写 `day_snapshot/sectors/sector_members/pool_aux` 等 7 张表，污染当日快照。新增独立表 `limit_up_history`。

### 3.5 竞价：只能实时采样

- A 股 09:25 开盘价 = 集合竞价撮合价；09:25–09:30 之间报价的 `open` 即竞价成交价，`volume/amount` 即竞价量额（**P0 需在实盘 09:25 抓一次确认 `open == price` 且 volume 就是竞价量**）。
- 现有 `StockQuote` 字段够用（open/volume/amount/prev_close），`get_stock_quotes` 支持批量；`marketSessionOpen()` 从 09:15 就为 true。
- 缺的是：① 09:25 定时采样；② 落表；③ 报价换手率解析。
- **没有历史竞价**：不要从 1 分钟首根反推，也不要用 09:15–09:25 虚拟撮合数据（四源都没有）。

### 3.6 现有数据能筛到哪一步（2026-11-18 样本，仅计数）

| 步骤 | 剩余数量 |
|---|---|
| 当日涨停 | 40 |
| 首板（`streak <= 1`） | 32 |
| 股价 ≤30 | 25 |
| 流通 ≤200 亿 | 24 |
| 当日开板 0 次 | 11 |
| 历史 6 月 ≥3 次、1 年无 4 板、封单比 ≥10% | **待补数据后才能算** |

说明：这只是缓存样本的漏斗演示，不是选股结果。

## 4. 数据补全方案

### 4.1 新表

```sql
-- 历史涨停序列（只存涨停池，不写当日快照）
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
  first_seal INTEGER NOT NULL DEFAULT 0,
  open_num INTEGER NOT NULL DEFAULT 0,
  limit_type TEXT NOT NULL DEFAULT '',
  float_cap REAL NOT NULL DEFAULT 0,
  market TEXT NOT NULL DEFAULT '',
  is_new INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, code)
);
CREATE INDEX IF NOT EXISTS idx_limit_hist_code_date ON limit_up_history(code, date);

-- 派生统计缓存（按 code + as_of）
CREATE TABLE IF NOT EXISTS stock_stats (
  code TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  limit_up_120d INTEGER NOT NULL DEFAULT 0,
  max_streak_250d INTEGER NOT NULL DEFAULT 0,
  max_gain_20d REAL NOT NULL DEFAULT 0,
  max_gain_250d REAL NOT NULL DEFAULT 0,
  last_limit_date TEXT NOT NULL DEFAULT '',
  computed_at INTEGER NOT NULL DEFAULT 0
);

-- 竞价快照（只存 09:25–09:30 采到的值）
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

-- 策略参数（单行）
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

### 4.2 同步策略

1. **历史回填**：`sync_limit_history(250)`，从 `trade_days` 取最近 250 个交易日，逐日请求 `limit_up_pool`，只写 `limit_up_history`；失败重试 2 次，记录缺口；每 10 天发一次进度事件。
2. **增量更新**：每天收盘后补齐当日；已存在日期跳过（可强制刷新）。
3. **当日成交额**：`fetch_day` 完成后，对涨停池代码做一次腾讯批量报价，回填 `amount`/`turnover`/`seal_volume`。
4. **大涨统计**：只对候选（首板 + 通过 F1/F2/F3/F5）逐只拉日 K（`refresh=true`），计算近 250 日最大 20 日涨幅，写 `stock_stats`；当天缓存命中则跳过。
5. **竞价快照**：09:25–09:30 前端定时调用 `capture_auction(date)`，后端批量报价并落表；已有记录不覆盖。

### 4.3 新增 command

| command | 作用 | 备注 |
|---|---|---|
| `sync_limit_history(days, refresh)` | 回填/增量历史 | 后台任务 + `history:progress` 事件 |
| `get_history_status()` | 已覆盖日期范围、缺口、更新时间 | 用于 UI 显示「历史 250 天已就绪」 |
| `run_first_to_second(date)` | 执行筛选，返回候选 + 每条规则证据 | 只读，不写快照 |
| `get_strategy_profile()` / `save_strategy_profile(profile)` | 参数读写 | 单行表 |
| `capture_auction(date)` / `get_auction(date)` | 竞价采样/读取 | 09:25–09:30 有效 |
| `export_screen(date)` | 导出候选 TXT/CSV | 可复用现有 `export_text` |

### 4.4 计算口径

- `limit_up_120d`：以最近 120 个**交易日**为窗口，`COUNT(*) FROM limit_up_history WHERE code=? AND date > 窗口起点`，含当日。
- `max_streak_250d`：同窗口 `MAX(streak)`；若历史缺口，返回 `null` 而不是 0。
- `max_gain_20d`：日 K 收盘价的 20 日滚动涨幅最大值，前复权口径；除权日误差在 Phase 0 用样本校验。
- `is_first_board`：今日有记录且上一交易日无记录；历史不足时回退 `streak == 1` 并写 warning。
- 板块主板块：取 `limit_up_num` 最大、再按 `continuous_num` 最大的板块；网络路径与缓存路径统一同一规则。

## 5. 筛选引擎

### 5.1 流程

```
当日 DayPayload
  → U0/U1 首板池（历史判定，回退 streak）
  → F1 股价 → F2 流通市值 → F3 涨停次数 → F4 透支 → F5 板块
  → S1 首封质量 → S2 开板次数 → S3 封单比
  → 评分 → Top N
  → 输出：候选、被剔除项、数据不足项、warning
```

每一步都返回 `passed: true / false / null`、实际值、阈值、证据文本；`null` 表示数据不足，不能当成通过。

### 5.2 输出结构（示意）

```ts
interface RuleCheck {
  key: string;          // price / floatCap / limitCount / overheat / sector / firstSeal / openNum / sealRatio
  label: string;
  passed: boolean | null;
  value: string;        // "7.13 元" / "31.3 亿" / "5 次"
  threshold: string;    // "≤ 30" / "≤ 200 亿"
  note?: string;        // "历史缺口 3 天" / "成交额未取到"
}

interface ScreenCandidate {
  code: string;
  name: string;
  rank: number | null;
  score: number;
  checks: RuleCheck[];
  stats: {
    price: number;
    floatCap: number;
    amount: number;
    sealAmount: number;
    sealRatio: number | null;
    firstSealMinute: number;
    openNum: number;
    limitUp120d: number | null;
    maxStreak250d: number | null;
    maxGain20d: number | null;
    sectorName: string;
    sectorLimitUps: number;
    sectorContinuous: number;
  };
  missing: string[];
}

interface ScreenResult {
  date: string;
  universe: number;
  hardPassed: number;
  candidates: ScreenCandidate[];
  excluded: Array<{ code: string; name: string; failed: string[] }>;
  warnings: string[];
  history: { firstDate: string; lastDate: string; days: number };
}
```

### 5.3 性能

- 历史回填：250 次请求，4–6 并发，约 1–2 分钟；写 1–1.5 万行。
- 单次筛选：SQL 聚合 1–1.5 万行 + 候选 30–40 只的 K 线（缓存命中）→ <2 秒；首次拉 K 线 10–30 秒。
- 禁止在筛选过程中串行拉 40 只 K 线而不给进度；要么后台预取，要么分批 + 进度条。

## 6. 界面方案

### 6.1 入口：第 5 个一级导航「策略」

- **已定**：不新增涨停池第 4 段，改为独立「策略」入口，内部三页签「一进二 / 竞价观察 / 策略库」。
- 理由：一进二只是第一条策略；独立入口能为「竞价观察、连板接力、未来策略」提供统一接入口，避免把涨停池分段越加越长；表格/抽屉/参数/免责声明也只需维护一套。
- 代价：导航从四入口变五入口，需要同步 `parseHash`、`renderMain`、导航高亮与 DESIGN 信息架构；这些已落地。

### 6.2 列表

默认只显示通过硬过滤的候选，按规则分排序，前三名带 `1/2/3` 名次徽标；提供「显示被剔除」开关，展开后显示每只票失败的规则，避免黑箱。

| 列 | 内容 |
|---|---|
| 股票 | 名称 + 代码 |
| 首封 | 09:33 / 一字标记 |
| 封单比 | 封单额 ÷ 成交额，缺失显示 `—` |
| 开板 | 0 次 / N 次 |
| 换手 | 5.4% |
| 流通 | 31.3 亿 |
| 近 6 月涨停 | 5 次 |
| 近 1 年最高 | 3 板 |
| 规则分 | 82 |

点击行 → 现有 K 线；行尾「观察」→ 加入自选分组（复用现有 command）。

### 6.3 规则详情

点行展开或右侧抽屉，逐条显示：

```
股价 7.13 ≤ 30          ✅
流通 31.3 亿 ≤ 200 亿   ✅
近 6 月涨停 5 次 ≥ 3    ✅
近 1 年最高 3 板 < 4    ✅
一年最大 20 日涨幅 38% < 60% ✅
板块 芯片概念 · 13 家涨停 / 5 家连板 ✅
首封 09:33 ≤ 10:00      ✅
开板 0 次 = 0           ✅
封单比 18.4% ≥ 10%      ✅
```

数据不足显示 `⚠ 待补`，不显示 `✅`。

### 6.4 参数面板

数字输入 + 恢复默认；保存到 `strategy_profile`；下次进入沿用。参数变化只重算，不重写历史。

### 6.5 竞价面板

- 仅当日期 = 今天、时间在 09:25–09:30 时显示「采集竞价」；也可自动采集一次。
- 展示：竞价涨幅、竞价额 / 昨日成交额、竞价换手（近似）、是否达到 10%–15%。
- 未采集显示「未采集（需 09:25 前打开应用）」，不要用 09:30 后的数据冒充。
- T+1 的其他判断（高开、承接、打板、止损）只做文字清单，不做自动交易。

### 6.6 免责声明

列表底部固定一行：

> 以上仅为按固定规则筛出的复盘候选，不构成投资建议；策略未经过收益验证，请自行判断风险。

## 7. 分期与验收

| 阶段 | 内容 | 工作量 | 验收 |
|---|---|---|---|
| P0 数据验证 | 09:25 报价实测、历史回溯深度、成交额补齐、`streak` 口径 | 0.5–1 天 | 一份验证记录；确认三块数据可行 |
| P1 数据层 | `limit_up_history` 回填、`stock_stats`、成交额/封单量/换手补齐、`streak` 回退修复 | 2–3 天 | 250 天历史可查；当日成交额覆盖 ≥95%；`pnpm build` / `cargo check` 通过 |
| P2 规则引擎 | 5 硬过滤 + 3 强度 + 评分 + unknown + 导出 | 1–2 天 | 2026-11-17/18 能产出候选与逐条证据 |
| P3 界面 | 涨停池第 4 段、列表、规则详情、参数面板、免责声明 | 2 天 | 深/浅主题、1080×720、三档字号 |
| P4 竞价 | 09:25 采样、落表、竞价面板 | 1–2 天 | 实盘 09:25 采到快照；比率与手工核对一致 |
| P5 回测（可选） | 过去 20–30 个交易日回放，统计次日封板率/溢价/回撤 | 2–3 天 | 有样本数、胜率、平均收益、最差样本；不夸大 |

推荐顺序：P0 → P1 → P2 → P3；P4/P5 看你要不要做 T+1 实盘流程与验证。

## 8. 验证与回测

### 8.1 数据校验

- 历史回填后，挑 3 只票人工比对「近 6 月涨停次数」「近 1 年最高连板」。
- 成交额：同一天用腾讯报价与 `turnover_rate × float_cap` 估算对比，误差应 <5%。
- 首板：用历史表判定与 `streak == 1` 对比，列出差异并解释。
- 除权日：挑 2 只除权样本，检查 20 日涨幅是否异常。

### 8.2 规则校验

- 构造边界样本：ST、20cm、一字板、开板 1 次、封单比 9.9%、历史缺口。
- 所有 unknown 必须出现在结果里，不能静默通过。
- 参数改到极端值（如股价 0、封单比 0）不应崩溃。

### 8.3 历史回放

- 用 2026-11-13 / 11-17 / 11-18 三个交易日跑筛选，人工检查候选与剔除理由。
- 不把 T+1 数据泄漏进 T 日筛选。

### 8.4 回测指标（若做 P5）

- 次日封板率、次日开盘溢价、按涨停价买入的 T+1 收益、最大回撤、样本数。
- 明确写「样本有限，不代表未来」。

## 9. 风险

1. **策略本身未验证**：视频的收益承诺没有样本支撑；产品不能写「放心大胆入」。
2. **数据源不稳定**：同花顺历史接口可能限流/改版；250 次回填需要失败重试与缺口提示。
3. **竞价无历史**：只能实时采集；用户 09:25 没开应用就没有数据。
4. **前复权误差**：日 K 是前复权，除权日的涨停/涨幅判定可能有偏差。
5. **产品边界（已处理）**：`docs/DESIGN.md` 已改为「提供固定规则筛选与观察清单，不构成投资建议；不交易、不预测」；页面固定免责声明。
6. **性能**：首次回填与首次 K 线拉取较慢，必须给进度，不能卡 UI。
7. **口径争议**：大涨、竞价换手、板块效应都要参数化，否则无法解释结果。

## 10. 需要你拍板

1. **入口（已定）**：第 5 个一级导航「策略」，内部页签「一进二 / 竞价观察 / 策略库」；不再新增涨停池第 4 段。
2. **定位（已定）**：按「规则筛选器 + 观察清单，不构成投资建议」落地；`docs/DESIGN.md` 边界已同步，页面固定免责声明。
3. **参数**：按视频默认值（30 元 / 200 亿 / 6 月 3 次 / 1 年 4 板 / 封单 10% / 开板 0 次 / 首封 10:00）并可调？
4. **历史回填**：是否同意首次联网回填 250 个交易日（约 1–2 分钟、1–1.5 万行）？
5. **竞价**：是否要做 T+1 09:25 实时采集（应用需在 09:25 前运行），还是先只做盘后筛选？
6. **「大涨」定义**：一年内最大 20 日涨幅 ≥60%（推荐、可调），还是别的口径？
7. **回测**：是否现在就做 20–30 个交易日的回放验证，还是先出筛选结果？
8. **范围**：默认排除 ST / 一字板、20cm 单独开关、北交所暂不支持（池接口本来就没有），是否可以？

## 11. 建议下一步

先做 **P0 + P1**：把成交额、封单量、250 天历史三块补齐，用 2026-11-17 / 11-18 跑出「能算的部分」；确认口径后再做 P2 引擎和 P3 界面。这样不会在数据没到位时先做一个看起来能选股、实际缺一半判据的页面。
