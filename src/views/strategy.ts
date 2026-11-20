import { state } from "../lib/state";
import type {
  AuctionRow,
  AuctionResult,
  CandidateStats,
  ExcludedStock,
  HistoryStatus,
  RuleCheck,
  ScreenCandidate,
  ScreenResult,
  ScreenStock,
  StrategyProfile,
  StrategyStage,
  StrategyTab,
} from "../lib/types";
import {
  esc,
  fmtClock,
  fmtClockSeconds,
  fmtDotDate,
  fmtMoney,
  fmtPct,
  fmtPrice,
  icon,
  pctToneClass,
  relTime,
} from "../lib/ui";
import { renderViewHead } from "./common";

/* 策略面板：一进二 / 竞价观察 / 策略库。
   只负责渲染与数据属性，所有动作交给 main.ts 的事件委托。 */

/* ————————————————— state access ————————————————— */

/** 契约字段由 ts-state 补进 AppState；这里保持一次收敛读取，state 缺字段也不炸。 */
interface StrategyState {
  strategyTab: StrategyTab;
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
}

type StrategyView = typeof state & Partial<StrategyState>;

function view(): StrategyView {
  return state as StrategyView;
}

/* ————————————————— copy ————————————————— */

const TABS: Array<{ key: StrategyTab; label: string; hint: string }> = [
  { key: "firstToSecond", label: "一进二", hint: "首板次日的观察池" },
  { key: "auction", label: "竞价观察", hint: "T+1 09:25–09:30 实时采样" },
  { key: "library", label: "策略库", hint: "固定规则策略的接入口" },
];

const DISCLAIMER = "以上仅为按固定规则筛出的复盘候选，不构成投资建议；策略未经过收益验证。";

const RULE_LABELS: Record<string, string> = {
  u1: "ST / 新股排除",
  first_board: "首板",
  f1: "股价",
  f2: "流通市值",
  f3: "近期涨停",
  f4: "透支",
  f5: "板块效应",
  s1_one_word: "非一字板",
  s1_seal_minute: "首封时间",
  s1_turnover: "换手率",
  s2: "开板次数",
  s3: "封单比",
  price: "股价",
  maxPrice: "股价",
  floatCap: "流通市值",
  maxFloatCap: "流通市值",
  limitCount: "近期涨停",
  minLimitCount: "近期涨停",
  limitWindowDays: "统计窗口",
  overheat: "透支",
  maxStreak: "连板高度",
  maxGain20d: "20 日涨幅",
  sector: "板块效应",
  minSectorLimitUps: "板块涨停",
  minSectorContinuous: "板块连板",
  firstSeal: "首封时间",
  latestFirstSealMinute: "首封时间",
  openNum: "开板次数",
  maxOpenNum: "开板次数",
  sealRatio: "封单比",
  minSealRatio: "封单比",
  turnover: "换手率",
  minTurnover: "换手率",
  oneWord: "一字板",
  st: "ST 排除",
  newStock: "新股排除",
  topN: "观察上限",
};

function ruleLabel(key: string): string {
  return RULE_LABELS[key] ?? key;
}

/* ————————————————— format helpers ————————————————— */

function trimNum(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "";
  const text = value.toFixed(digits);
  if (!text.includes(".")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

function dash(): string {
  return `<span class="strategy-miss">—</span>`;
}

function sealRatioCell(stats: CandidateStats): string {
  const ratio = stats.sealRatio;
  if (ratio == null || !Number.isFinite(ratio)) {
    return `<span class="strategy-miss" title="成交额缺失，无法计算封单比">—</span>`;
  }
  const strong = ratio >= 0.1;
  return `<span class="strategy-num ${strong ? "is-strong" : ""}">${(ratio * 100).toFixed(1)}%</span>`;
}

/** 换手率由后端直出（%），缺失（0）时显示占位，不在前端重复推算。 */
function turnoverCell(stats: CandidateStats): string {
  const rate = stats.turnoverRate;
  if (!Number.isFinite(rate) || rate <= 0) return dash();
  return `<span class="strategy-num">${rate.toFixed(1)}%</span>`;
}

/* ————————————————— shell ————————————————— */

export function renderStrategy(): string {
  return `<section class="view view-strategy">
    ${renderViewHead()}
    <div id="strategy-stage">${renderStrategyStage()}</div>
  </section>`;
}

export function renderStrategyStage(): string {
  const v = view();
  const tab: StrategyTab = v.strategyTab ?? "firstToSecond";
  let body = "";
  if (tab === "auction") body = renderAuction(v);
  else if (tab === "library") body = renderLibrary(v);
  else body = renderFirstToSecond(v);

  return `<div class="strategy-scroll">
    ${renderTopbar()}
    ${renderTabs(tab, v.history ?? null)}
    <div class="strategy-body">${body}</div>
  </div>
  <div class="strategy-foot"><span>${DISCLAIMER}</span></div>
  ${renderDetail(v)}
  ${renderStrategyProfilePanel()}`;
}

/** 供 main.ts 做局部更新：保留滚动位置，并保留参数弹层里尚未保存的输入。 */
export function updateStrategyStage(): void {
  const old = document.getElementById("strategy-stage");
  if (!old) return;
  const top = old.querySelector<HTMLElement>(".strategy-scroll")?.scrollTop ?? 0;
  const draft = new Map<string, string>();
  old.querySelectorAll<HTMLInputElement>("[data-profile-field]").forEach((input) => {
    const key = input.dataset.profileField;
    if (key) draft.set(key, input.value);
  });
  const activeKey = (document.activeElement as HTMLInputElement | null)?.dataset?.profileField ?? "";

  const stage = document.createElement("div");
  stage.id = "strategy-stage";
  stage.innerHTML = renderStrategyStage();
  old.replaceWith(stage);

  const scroller = stage.querySelector<HTMLElement>(".strategy-scroll");
  if (scroller) scroller.scrollTop = top;
  stage.querySelectorAll<HTMLInputElement>("[data-profile-field]").forEach((input) => {
    const key = input.dataset.profileField;
    const value = key ? draft.get(key) : undefined;
    if (value != null) input.value = value;
    if (key && key === activeKey) input.focus();
  });
}

function renderTopbar(): string {
  return `<div class="strategy-topbar">
    <div class="strategy-head-copy">
      <h2>策略复盘</h2>
      <p>固定规则筛选 · 不构成投资建议</p>
    </div>
    <div class="strategy-actions">
      <button class="chip strategy-action is-primary" data-strategy-run title="按当前参数重新筛选">${icon("activity", 12)}<span>运行筛选</span></button>
      <button class="chip strategy-action" data-open-profile title="调整 13 项规则参数">${icon("sliders", 12)}<span>参数</span></button>
      <button class="chip strategy-action" data-strategy-export title="导出候选清单 TXT">${icon("download", 12)}<span>导出</span></button>
    </div>
  </div>`;
}

function renderTabs(tab: StrategyTab, history: HistoryStatus | null): string {
  const coverage = history
    ? `${history.syncing ? "回填中" : "历史覆盖"} ${history.days}/${history.expectedDays || 250} 天`
    : "历史未回填";
  const updated = history && history.updatedAt ? relTime(history.updatedAt) : "";
  return `<div class="strategy-tabs-row">
    <div class="seg strategy-tabs" role="tablist" aria-label="策略页签">
      ${TABS.map(
        (item) => `<button role="tab" class="${tab === item.key ? "active" : ""}" data-strategy-tab="${item.key}" aria-selected="${tab === item.key}" title="${esc(item.hint)}">${item.label}</button>`,
      ).join("")}
    </div>
    <div class="strategy-tabs-meta">
      <span>${esc(coverage)}</span>
      ${history && !historyReady(history) && !history.syncing ? `<button class="strategy-meta-sync" data-history-sync title="补齐到 250 个交易日">补全历史</button>` : ""}
      ${history?.lastDate ? `<span class="strategy-meta-date">${esc(fmtDotDate(history.lastDate))}</span>` : ""}
      ${updated ? `<span class="strategy-meta-rel">${esc(updated)}</span>` : ""}
    </div>
    <button class="strategy-icon-btn" data-strategy-refresh title="清缓存并重新筛选" aria-label="重新筛选">${icon("refresh", 13)}</button>
  </div>`;
}

/* ————————————————— first board → second board ————————————————— */

function historyReady(history: HistoryStatus | null): boolean {
  if (!history || history.days <= 0) return false;
  const need = history.expectedDays > 0 ? history.expectedDays : 250;
  return history.days >= need - 5;
}

function renderFirstToSecond(v: StrategyView): string {
  const screen = v.screen ?? null;
  const history = v.history ?? screen?.history ?? null;
  const error = v.screenError ?? null;

  if (v.screenLoading === true && !screen) return renderScreenSkeleton();
  if (error && !screen) return renderScreenError(error);

  if (!historyReady(history) && !screen) return renderHistoryCard(v, history);
  if (!screen) return renderScreenIdle(history);

  const warnings = screen.universe > 0 ? [...screen.warnings] : [];
  if (error) warnings.unshift(error);
  if (screen.universe > 0 && !historyReady(screen.history)) {
    warnings.push(`历史仅覆盖 ${screen.history.days} 天，首板判定已回退到 streak，结果可能偏差。`);
  }
  if (screen.universe > 0 && !screen.hasAmount) warnings.push("当日成交额缺失，封单比与换手为估算或缺省。");

  return `${warnings.length ? renderNotes(warnings, Boolean(error)) : ""}
    ${history && !historyReady(history) ? renderHistoryHint(history) : ""}
    ${renderFunnel(screen, v.profile ?? null, v.strategyStage ?? "watch")}
    ${renderStageBlock(screen, v)}`;
}

function renderHistoryHint(history: HistoryStatus): string {
  const need = history.expectedDays || 250;
  const syncing = history.syncing === true;
  return `<div class="strategy-sync-hint">
    ${icon("database", 13)}
    <span>历史覆盖 ${history.days}/${need} 天；补全后首板与连板窗口才完整。</span>
    <button class="chip" data-history-sync ${syncing ? "disabled" : ""}>${syncing ? "回填中…" : "补全历史"}</button>
  </div>`;
}

function renderNotes(list: string[], isError: boolean): string {
  return `<ul class="strategy-notes ${isError ? "is-error" : ""}">
    ${list
      .map((text) => `<li>${icon("info", 11)}<span>${esc(text)}</span></li>`)
      .join("")}
  </ul>`;
}

function renderHistoryCard(v: StrategyView, history: HistoryStatus | null): string {
  const progress = v.historyProgress ?? null;
  const syncing = history?.syncing === true || progress != null;
  const total = progress?.total || history?.expectedDays || 250;
  const need = history?.expectedDays || 250;
  const done = progress?.done ?? history?.days ?? 0;
  const percent = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
  const current = progress?.current
    ? `正在回填 ${progress.current}`
    : syncing
      ? "正在回填…"
      : `已覆盖 ${history?.days ?? 0} 天`;

  return `<div class="strategy-sync">
    <div class="strategy-sync-card">
      <span class="strategy-sync-mark">${icon("database", 20)}</span>
      <div class="strategy-sync-copy">
        <h3>首次使用需回填 ${need} 天涨停历史</h3>
        <p>「一进二」要用逐日涨停记录判断昨日是否首板，并统计近 120 个交易日的涨停次数、近 250 个交易日的最高连板。回填只写入本地 SQLite，约 1–2 分钟。</p>
        <div class="strategy-meter"><span style="width:${percent.toFixed(1)}%"></span></div>
        <div class="strategy-meter-meta"><span>${done} / ${total} 天</span><span>${esc(current)}</span></div>
      </div>
      <button class="chip strategy-action is-primary" data-history-sync ${syncing ? "disabled" : ""}>${syncing ? "同步中" : "回填历史"}</button>
    </div>
    <p class="strategy-sync-foot">${icon("info", 11)}回填在后台进行，期间可以继续浏览其它页面；进度会实时更新。</p>
  </div>`;
}

function renderScreenIdle(history: HistoryStatus | null): string {
  const span = history ? `${history.days} 天历史已就绪` : "历史已就绪";
  return `<div class="strategy-start">
    <span class="strategy-start-mark">${icon("layers", 20)}</span>
    <h3>按固定规则跑一次复盘</h3>
    <p>${esc(span)}，将对 ${esc(fmtDotDate(state.date))} 的首板执行 13 项规则：股价、流通、涨停基因、透支、板块效应、首封、开板、封单比、换手，并按规则分排序。</p>
    <button class="chip strategy-action is-primary" data-strategy-run>运行筛选</button>
  </div>`;
}

function renderScreenError(message: string): string {
  return `<div class="strategy-empty is-error">
    <b>筛选没有完成</b>
    <span>${esc(message)}</span>
    <button class="chip strategy-action" data-strategy-run>${icon("refresh", 12)}重试</button>
  </div>`;
}

function renderScreenSkeleton(): string {
  const row = (widths: string[]) => `<div class="strategy-sk-row">${widths
    .map((width) => `<span class="sk" style="width:${width};height:12px"></span>`)
    .join("")}</div>`;
  return `<div class="strategy-skeleton">
    <div class="sk strategy-sk-funnel"></div>
    ${[["58px", "150px", "70px", "60px"], ["46px", "132px", "62px", "54px"], ["50px", "164px", "66px", "58px"], ["44px", "118px", "70px", "52px"]]
      .map((widths) => row(widths))
      .join("")}
  </div>`;
}

function renderFunnel(screen: ScreenResult, profile: StrategyProfile | null, stage: StrategyStage): string {
  const topN = profile && profile.topN > 0 ? profile.topN : screen.candidates.length;
  const ranked = screen.stocks ? screen.stocks.filter((s) => s.rank != null).length : 0;
  const watch = ranked || Math.min(screen.candidates.length, topN);
  const steps: Array<{ key: StrategyStage; label: string; value: number; note: string }> = [
    { key: "firstBoard", label: "首板", value: screen.universe, note: "当日首封" },
    { key: "hardPassed", label: "硬过滤", value: screen.hardPassed, note: "硬条件全部通过" },
    { key: "candidates", label: "候选", value: screen.candidates.length, note: "全部规则通过" },
    { key: "watch", label: "观察", value: watch, note: `规则分前 ${topN || "—"}` },
  ];
  return `<div class="strategy-funnel" role="tablist" aria-label="筛选漏斗 · 点按查看该阶段个股">
    ${steps
      .map(
        (step, i) => `${i > 0 ? `<span class="strategy-funnel-line" aria-hidden="true"></span>` : ""}<button type="button" role="tab" aria-selected="${stage === step.key}" class="strategy-funnel-step${stage === step.key ? " is-active" : ""}${step.key === "watch" ? " is-target" : ""}" data-strategy-stage="${step.key}" title="查看${step.label}阶段的个股">
        <span class="strategy-funnel-label">${step.label}</span>
        <b class="strategy-funnel-num">${step.value}</b>
        <span class="strategy-funnel-note">${esc(step.note)}</span>
      </button>`,
      )
      .join("")}
  </div>`;
}

function renderStageBlock(screen: ScreenResult, v: StrategyView): string {
  const stage = v.strategyStage ?? "watch";
  if (stage === "candidates" || stage === "watch") return renderCandidateBlock(screen, v, stage);
  return renderStageStocks(screen, stage);
}

function renderCandidateBlock(screen: ScreenResult, v: StrategyView, stage: "candidates" | "watch"): string {
  const profile = v.profile ?? null;
  const topN = profile && profile.topN > 0 ? profile.topN : 0;
  const rows = stage === "watch" && topN > 0 ? screen.candidates.slice(0, topN) : screen.candidates;
  const excludedOn = v.strategyShowExcluded === true;
  const truncated = rows.length < screen.candidates.length;
  const title = stage === "watch" ? "观察" : "候选";

  const head = `<div class="strategy-list-head">
    <h3 class="strategy-list-title">${title}</h3>
    <span class="strategy-list-sub">${stage === "watch" ? "按规则分降序" : "全部规则通过 · 按规则分降序"}${truncated ? ` · 仅显示前 ${rows.length} 只` : ""}</span>
    <button class="chip ${excludedOn ? "active" : ""}" data-strategy-show-excluded aria-pressed="${excludedOn}">
      ${icon(excludedOn ? "eyeOff" : "eye", 12)}<span>${excludedOn ? "隐藏被剔除" : "显示被剔除"}</span><span class="count">${screen.excluded.length}</span>
    </button>
  </div>`;

  const body = rows.length ? renderCandidateTable(rows) : renderNoCandidate(screen);
  const rest = stage === "watch" && rows.length ? screen.candidates.slice(rows.length) : [];
  return `<div class="strategy-list">${head}${body}${renderRest(rest)}${excludedOn ? renderExcluded(screen.excluded) : ""}</div>`;
}

/** 首板 / 硬过滤阶段：整池个股 + 当前结果（观察 / 候选 / 卡在哪条规则）。 */
function renderStageStocks(screen: ScreenResult, stage: "firstBoard" | "hardPassed"): string {
  const rows = (screen.stocks ?? [])
    .filter((s) => (stage === "firstBoard" ? s.firstBoard : s.hardPassed))
    .sort((a, b) => {
      if (stage === "hardPassed") {
        const ar = a.rank ?? 999;
        const br = b.rank ?? 999;
        if (ar !== br) return ar - br;
        if (b.score !== a.score) return b.score - a.score;
      }
      const at = a.firstSeal || Number.MAX_SAFE_INTEGER;
      const bt = b.firstSeal || Number.MAX_SAFE_INTEGER;
      if (at !== bt) return at - bt;
      return a.code.localeCompare(b.code);
    });
  const title = stage === "firstBoard" ? "首板" : "硬过滤";
  const sub =
    stage === "firstBoard"
      ? "当日首封，按首封时间排列 · 点按查看 K 线"
      : "通过全部硬条件，含未过封板质量的票 · 点按查看 K 线";
  return `<div class="strategy-list">
    <div class="strategy-list-head">
      <h3 class="strategy-list-title">${title}</h3>
      <span class="strategy-list-sub">${sub}</span>
      <span class="strategy-stage-count">${rows.length} 只</span>
    </div>
    ${rows.length ? renderStageTable(rows) : renderStageEmpty(stage)}
  </div>`;
}

function renderStageEmpty(stage: "firstBoard" | "hardPassed"): string {
  return `<div class="strategy-empty">
    <b>${stage === "firstBoard" ? "这一天没有首板" : "没有股票通过硬过滤"}</b>
    <span>${stage === "firstBoard" ? "当日涨停池里没有首封的票，换一个交易日或重新运行筛选。" : "可以从「首板」阶段回看，或放宽参数后重新运行。"}</span>
  </div>`;
}

function renderStageTable(rows: ScreenStock[]): string {
  return `<table class="pool-table strategy-table strategy-stage-table">
    <colgroup>
      <col class="c-stock" style="width:26%" />
      <col class="c-pct" style="width:10%" />
      <col class="c-price" style="width:11%" />
      <col class="c-board" style="width:8%" />
      <col class="c-seal-time" style="width:10%" />
      <col class="c-score" style="width:8%" />
      <col class="c-result" style="width:27%" />
    </colgroup>
    <thead>
      <tr>
        <th class="c-stock">股票</th>
        <th class="num c-pct">涨幅</th>
        <th class="num c-price">现价</th>
        <th class="num c-board">连板</th>
        <th class="num c-seal-time">首封</th>
        <th class="num c-score">规则分</th>
        <th class="c-result">结果</th>
      </tr>
    </thead>
    <tbody>${rows.map(stageRow).join("")}</tbody>
  </table>`;
}

function stageRow(stock: ScreenStock): string {
  return `<tr class="strategy-row strategy-stage-row" data-strategy-stock="${esc(stock.code)}" data-strategy-name="${esc(stock.name)}" tabindex="0" aria-label="查看 ${esc(stock.name)} K线">
    <td class="stock-cell c-stock"><div class="pool-stock"><span class="pool-stock-name">${esc(stock.name)}</span><span class="pool-stock-code">${esc(stock.code)}</span></div></td>
    <td class="num c-pct"><span class="strategy-num ${pctToneClass(stock.changeRate)}">${fmtPct(stock.changeRate)}</span></td>
    <td class="num c-price"><span class="strategy-num">${fmtPrice(stock.price)}</span></td>
    <td class="num c-board"><span class="strategy-num">${stock.board}</span><span class="strategy-unit">板</span></td>
    <td class="num c-seal-time"><span class="strategy-num">${stock.firstSeal ? fmtClock(stock.firstSeal) : "—"}</span></td>
    <td class="num c-score"><span class="strategy-num">${stock.score > 0 ? Math.round(stock.score) : "—"}</span></td>
    <td class="c-result">${stageResultCell(stock)}</td>
  </tr>`;
}

function stageResultCell(stock: ScreenStock): string {
  if (stock.pending) return `<span class="strategy-stage-tag is-pending">待补</span>`;
  if (stock.rank != null) return `<span class="strategy-stage-tag is-watch">观察 #${stock.rank}</span>`;
  if (stock.candidate) return `<span class="strategy-stage-tag is-candidate">候选</span>`;
  if (stock.failed.length) {
    const shown = stock.failed.slice(0, 3);
    const extra = stock.failed.length - shown.length;
    return `<span class="strategy-fail-chips">${shown
      .map((key) => `<span>${esc(ruleLabel(key))}</span>`)
      .join("")}${extra > 0 ? `<span class="more">+${extra}</span>` : ""}</span>`;
  }
  return `<span class="strategy-stage-tag">通过</span>`;
}

/** 观察名单之外的候选：低调纸片，点按仍可查看逐条规则。 */
function renderRest(list: ScreenCandidate[]): string {
  if (!list.length) return "";
  return `<div class="strategy-rest">
    <div class="strategy-rest-head">
      <h4>候选池其余 ${list.length} 只</h4>
      <span>未进入观察名单 · 点按查看逐条规则</span>
    </div>
    <div class="strategy-rest-list">
      ${list
        .map(
          (item) => `<button class="strategy-rest-item" data-candidate-detail="${esc(item.code)}" title="${esc(item.name)} · 规则分 ${Math.round(item.score)} · 首封 ${fmtClock(item.stats.firstSeal)}">
        <span class="strategy-rest-name">${esc(item.name)}</span>
        <span class="strategy-rest-code">${esc(item.code)}</span>
        <span class="strategy-rest-score">${Math.round(item.score)}</span>
        <span class="strategy-rest-time">${fmtClock(item.stats.firstSeal)}</span>
      </button>`,
        )
        .join("")}
    </div>
  </div>`;
}

function renderNoCandidate(screen: ScreenResult): string {
  if (screen.universe === 0) {
    return `<div class="strategy-empty">
      <b>今日还没有涨停数据</b>
      <span>盘前或休市时当日涨停池为空；可以切到上一交易日复盘，或开盘后重新运行。</span>
      <button class="chip strategy-empty-action" data-strategy-prev-day>${icon("chevronLeft", 12)}看上一交易日</button>
    </div>`;
  }
  return `<div class="strategy-empty">
    <b>没有股票通过全部规则</b>
    <span>可以放宽参数，或展开「被剔除」查看每条规则拦下了谁；空结果本身也是一种复盘信息。</span>
  </div>`;
}

function renderCandidateTable(rows: ScreenCandidate[]): string {
  return `<table class="pool-table strategy-table">
    <colgroup>
      <col class="c-rank" style="width:4.5%" />
      <col class="c-stock" style="width:22%" />
      <col class="c-seal-time" style="width:9%" />
      <col class="c-seal-ratio" style="width:9.5%" />
      <col class="c-open" style="width:8%" />
      <col class="c-turnover" style="width:9%" />
      <col class="c-cap" style="width:8.5%" />
      <col class="c-limit6m" style="width:8.5%" />
      <col class="c-year" style="width:8%" />
      <col class="c-score" style="width:6.5%" />
      <col class="c-ops" style="width:6.5%" />
    </colgroup>
    <thead>
      <tr>
        <th class="c-rank">名次</th>
        <th class="c-stock">股票</th>
        <th class="num c-seal-time">首封</th>
        <th class="num c-seal-ratio">封单比</th>
        <th class="num c-open">开板</th>
        <th class="num c-turnover">换手</th>
        <th class="num c-cap">流通</th>
        <th class="num c-limit6m" title="近 120 个交易日涨停次数">近6月涨停</th>
        <th class="num c-year" title="近 250 个交易日最高连板">近1年最高</th>
        <th class="num c-score">规则分</th>
        <th class="num c-ops">操作</th>
      </tr>
    </thead>
    <tbody>${rows.map((item, index) => candidateRow(item, index)).join("")}</tbody>
  </table>`;
}

function candidateRow(candidate: ScreenCandidate, index: number): string {
  const stats = candidate.stats;
  const rank = candidate.rank ?? index + 1;
  const top = index < 3;
  return `<tr class="strategy-row" data-candidate-code="${esc(candidate.code)}" data-candidate-name="${esc(candidate.name)}" tabindex="0" aria-label="查看 ${esc(candidate.name)} K线">
    <td class="c-rank"><span class="strategy-rank ${top ? "top" : ""}">${String(rank).padStart(2, "0")}</span></td>
    <td class="stock-cell c-stock">
      <div class="pool-stock"><span class="pool-stock-name">${esc(candidate.name)}</span><span class="pool-stock-code">${esc(candidate.code)}</span></div>
      <span class="pool-sector strategy-sector" title="${esc(stats.sectorName || "—")}">${esc(stats.sectorName || "—")}</span>
    </td>
    <td class="num c-seal-time"><span class="strategy-num">${fmtClock(stats.firstSeal)}</span></td>
    <td class="num c-seal-ratio">${sealRatioCell(stats)}</td>
    <td class="num c-open"><span class="strategy-num ${stats.openNum === 0 ? "is-strong" : ""}">${stats.openNum}</span><span class="strategy-unit">次</span></td>
    <td class="num c-turnover">${turnoverCell(stats)}</td>
    <td class="num c-cap"><span class="strategy-num">${fmtMoney(stats.floatCap)}</span></td>
    <td class="num c-limit6m">${stats.limitUp120d == null ? `<span class="strategy-miss">—</span>` : `<span class="strategy-num">${stats.limitUp120d}</span><span class="strategy-unit">次</span>`}</td>
    <td class="num c-year">${stats.maxStreak250d == null ? `<span class="strategy-miss">—</span>` : `<span class="strategy-num">${stats.maxStreak250d}</span><span class="strategy-unit">板</span>`}</td>
    <td class="num c-score"><span class="strategy-score">${Math.round(candidate.score)}</span></td>
    <td class="num c-ops" data-candidate-ops>
      <div class="strategy-ops">
        <button class="strategy-op" data-candidate-detail="${esc(candidate.code)}" title="规则明细" aria-label="规则明细">${icon("list", 12)}</button>
        <button class="strategy-op" data-candidate-watch="${esc(candidate.code)}" data-candidate-name="${esc(candidate.name)}" title="加入自选" aria-label="加入自选">${icon("plus", 12)}</button>
      </div>
    </td>
  </tr>`;
}

function renderExcluded(list: ExcludedStock[]): string {
  if (!list.length) {
    return `<div class="strategy-excluded"><div class="strategy-excluded-head">没有被剔除的股票</div></div>`;
  }
  return `<div class="strategy-excluded">
    <div class="strategy-excluded-head"><span>被剔除</span><span class="strategy-excluded-count">${list.length} 只</span><span>失败规则</span></div>
    ${list
      .map(
        (stock) => `<div class="strategy-excluded-row">
        <span class="strategy-excluded-name"><b>${esc(stock.name)}</b><em>${esc(stock.code)}</em></span>
        <span class="strategy-fails">${
          stock.failed.length
            ? stock.failed.map((key) => `<span class="strategy-fail"><i>✗</i>${esc(ruleLabel(key))}</span>`).join("")
            : `<span class="strategy-miss">数据不足</span>`
        }</span>
      </div>`,
      )
      .join("")}
  </div>`;
}

/* ————————————————— auction ————————————————— */

function auctionWindowOpen(): boolean {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const clock = now.getUTCHours() * 60 + now.getUTCMinutes();
  return clock >= 9 * 60 + 25 && clock <= 9 * 60 + 30;
}

function renderAuction(v: StrategyView): string {
  const auction = v.auction ?? null;
  const loading = v.auctionLoading === true;
  const canCapture = state.date === state.calendar?.today && auctionWindowOpen();

  if (loading && !auction) return renderAuctionSkeleton();

  const intro = `<div class="strategy-note-line">${icon("activity", 12)}<span>T+1 09:25–09:30 的实时采样，不是历史数据：竞价只有盘中报价，无法事后回补；09:25 前没有打开应用就没有样本。</span></div>`;

  if (!auction || !auction.captured) {
    return `${intro}
      <div class="strategy-auction-empty">
        <div class="strategy-auction-copy">
          <h3>${auction ? "这一日没有采集到竞价" : "尚未采集竞价"}</h3>
          <p>在 09:25–09:30 之间采集一次，即可记录首板池的竞价涨幅、竞价额与竞价换手；采集结果按日期落库，可回看已采集的日期。</p>
        </div>
        ${canCapture ? `<button class="chip strategy-action" data-auction-capture>${icon("activity", 12)}<span>采集竞价</span></button>` : `<span class="strategy-auction-locked">竞价仅当天可采集</span>`}
      </div>
      ${auction && auction.warnings.length ? renderNotes(auction.warnings, false) : ""}`;
  }

  const notes = [...auction.warnings];
  if (!auction.inWindow) notes.push("本次采集不在 09:25–09:30 窗口内，样本可能不完整。");
  if (!auction.rows.length) notes.push("采集已执行，但没有可用的竞价样本。");

  return `${intro}
    ${notes.length ? renderNotes(notes, false) : ""}
    <div class="strategy-list">
      <div class="strategy-list-head">
        <h3 class="strategy-list-title">竞价清单</h3>
        <span class="strategy-list-sub">${auction.rows.length} 只 · 采集于 ${esc(fmtClockSeconds(auction.capturedAt))}${auction.inWindow ? "" : " · 窗口外"}</span>
        ${canCapture ? `<button class="chip" data-auction-capture>${icon("refresh", 12)}<span>重新采集</span></button>` : `<span class="strategy-auction-locked">竞价仅当天可采集</span>`}
      </div>
      ${auction.rows.length ? auctionTable(auction.rows) : renderAuctionBlank()}
      <p class="strategy-auction-foot">「额/昨额」落在 0.10×–0.15× 区间时以铜金圆点标记达标；竞价涨幅 ≥ 10% 的行左侧带铜金发丝线；竞价换手由报价量估算，仅用于横向比较。</p>
    </div>`;
}

function renderAuctionBlank(): string {
  return `<div class="strategy-empty">
    <b>没有可用的竞价样本</b>
    <span>该日期的采集没有返回行情，可能是非交易日或开盘前报价尚未生成。</span>
  </div>`;
}

function auctionTable(rows: AuctionRow[]): string {
  return `<table class="pool-table strategy-table auction-table">
    <colgroup>
      <col class="c-stock" style="width:30%" />
      <col class="c-auction-pct" style="width:15%" />
      <col class="c-auction-amount" style="width:17%" />
      <col class="c-auction-ratio" style="width:14%" />
      <col class="c-turnover" style="width:12%" />
      <col class="c-auction-time" style="width:12%" />
    </colgroup>
    <thead>
      <tr>
        <th class="c-stock">股票</th>
        <th class="num c-auction-pct">竞价涨幅</th>
        <th class="num c-auction-amount">竞价额</th>
        <th class="num c-auction-ratio">额/昨额</th>
        <th class="num c-turnover">竞价换手</th>
        <th class="num c-auction-time">采集时间</th>
      </tr>
    </thead>
    <tbody>${rows.map((row) => auctionRow(row)).join("")}</tbody>
  </table>`;
}

function auctionRow(row: AuctionRow): string {
  const hit = row.auctionPct >= 10;
  const ratio = row.amountRatio;
  const ratioHit = ratio != null && ratio >= 0.1 && ratio <= 0.15;
  const ratioCell =
    ratio == null
      ? `<span class="strategy-miss">—</span>`
      : `${ratioHit ? `<span class="strategy-ratio-dot" aria-hidden="true"></span>` : ""}<span class="strategy-num${ratioHit ? " is-strong" : ""}"${ratioHit ? ` title="额/昨额 ${ratio.toFixed(2)}× · 落在 0.10×–0.15× 达标区间"` : ""}>${ratio.toFixed(2)}×</span>`;
  return `<tr class="${hit ? "is-top" : ""}" data-candidate-code="${esc(row.code)}" data-candidate-name="${esc(row.name)}" tabindex="0" aria-label="查看 ${esc(row.name)} K线">
    <td class="stock-cell c-stock">
      <div class="pool-stock"><span class="pool-stock-name">${esc(row.name)}</span><span class="pool-stock-code">${esc(row.code)}</span></div>
    </td>
    <td class="num c-auction-pct"><span class="strategy-pct ${hit ? "is-strong" : ""}">${fmtPct(row.auctionPct)}</span></td>
    <td class="num c-auction-amount"><span class="strategy-num">${fmtMoney(row.amount)}</span></td>
    <td class="num c-auction-ratio">${ratioCell}</td>
    <td class="num c-turnover"><span class="strategy-num">${row.turnover > 0 ? `${row.turnover.toFixed(2)}%` : "—"}</span></td>
    <td class="num c-auction-time"><span class="strategy-num">${fmtClockSeconds(row.capturedAt)}</span></td>
  </tr>`;
}

function renderAuctionSkeleton(): string {
  return `<div class="strategy-skeleton">
    <div class="strategy-note-line"><span class="sk" style="width:320px;height:11px"></span></div>
    ${[["168px", "72px", "68px", "58px"], ["140px", "66px", "72px", "54px"], ["176px", "70px", "64px", "60px"]]
      .map(
        (widths) => `<div class="strategy-sk-row">${widths
          .map((width) => `<span class="sk" style="width:${width};height:12px"></span>`)
          .join("")}</div>`,
      )
      .join("")}
  </div>`;
}

/* ————————————————— strategy library ————————————————— */

function renderLibrary(v: StrategyView): string {
  const profile = v.profile ?? null;
  const topN = profile && profile.topN > 0 ? profile.topN : 20;
  const cards = [
    {
      title: "一进二",
      tag: "已启用",
      tagCls: "is-on",
      desc: "首板次日的观察池：先由硬条件收敛，再用首封、开板、封单比、换手做强度排序，并逐条给出通过与剔除的理由。",
      meta: `13 项规则 · 观察上限 ${topN}`,
      go: "进入",
      tab: "firstToSecond" as StrategyTab,
      planned: false,
    },
    {
      title: "竞价观察",
      tag: "盘中",
      tagCls: "is-live",
      desc: "T+1 09:25–09:30 的实时采样：竞价涨幅、竞价额 / 昨日成交额、竞价换手，收盘后按日期留档。",
      meta: "仅实时 · 无历史可补",
      go: "进入",
      tab: "auction" as StrategyTab,
      planned: false,
    },
    {
      title: "连板接力",
      tag: "规划中",
      tagCls: "",
      desc: "面向 2 板以上的高度接力：需要分时封板质量与炸板回封数据，规则表尚未确定。",
      meta: "接口预留 · 未启用",
      go: "",
      tab: null,
      planned: true,
    },
    {
      title: "更多策略",
      tag: "接入口",
      tagCls: "",
      desc: "后续策略共用同一套「规则 → 候选 → 证据 → 免责声明」结构，新增只补规则与参数，不新开导航。",
      meta: "同一契约接入",
      go: "",
      tab: null,
      planned: true,
    },
  ];

  return `<div class="strategy-cards">
    ${cards
      .map((card) => {
        const cardClass = ["strategy-card", card.tagCls === "is-on" ? "is-on" : "", card.planned ? "is-planned" : ""]
          .filter(Boolean)
          .join(" ");
        const tagClass = ["strategy-tag", card.tagCls].filter(Boolean).join(" ");
        return `<article class="${cardClass}"${card.planned ? ` aria-disabled="true"` : ""}>
        <div class="strategy-card-head">
          <h3>${card.title}</h3>
          <span class="${tagClass}">${card.tag}</span>
        </div>
        <p>${card.desc}</p>
        <div class="strategy-card-foot">
          <span class="strategy-card-meta">${esc(card.meta)}</span>
          ${card.tab ? `<button class="strategy-card-go" data-strategy-tab="${card.tab}">${card.go}${icon("chevronRight", 11)}</button>` : ""}
        </div>
      </article>`;
      })
      .join("")}
  </div>
  <p class="strategy-library-foot">${icon("info", 11)}策略库只陈列规则与状态；「规划中」的卡片是未来策略的接入口，不代表已在运行。</p>`;
}

/* ————————————————— rule drawer ————————————————— */

function renderDetail(v: StrategyView): string {
  const code = v.strategyDetailCode;
  if (!code) return "";
  const screen = v.screen ?? null;
  const candidate = screen?.candidates.find((item) => item.code === code) ?? null;
  const excluded = screen?.excluded.find((item) => item.code === code) ?? null;
  const name = candidate?.name ?? excluded?.name ?? code;

  const body = candidate
    ? ruleList(candidate.checks, candidate.missing)
    : excluded
      ? failedList(excluded)
      : `<p class="strategy-drawer-empty">没有这只股票的规则明细。请先运行一次筛选。</p>`;

  const subtitle = candidate
    ? `规则分 ${Math.round(candidate.score)}`
    : excluded
      ? "已被剔除"
      : "来源不在当前结果中";

  return `<div class="strategy-drawer-layer">
    <div class="strategy-drawer-mask" data-detail-close></div>
    <aside class="strategy-drawer" role="dialog" aria-modal="true" aria-label="规则明细">
      <header class="strategy-drawer-head">
        <div>
          <h2>${esc(name)}</h2>
          <p><span class="mono">${esc(code)}</span> · ${esc(subtitle)}</p>
        </div>
        <button class="modal-close" data-detail-close aria-label="关闭">${icon("close", 15)}</button>
      </header>
      <div class="strategy-drawer-body">${body}</div>
      <div class="strategy-drawer-foot">
        <button class="btn" data-candidate-code="${esc(code)}" data-candidate-name="${esc(name)}">查看 K 线</button>
        <button class="btn" data-candidate-watch="${esc(code)}" data-candidate-name="${esc(name)}">加入自选</button>
      </div>
    </aside>
  </div>`;
}

function ruleMark(passed: boolean | null): { cls: string; mark: string; label: string } {
  if (passed === true) return { cls: "is-pass", mark: "✓", label: "通过" };
  if (passed === false) return { cls: "is-fail", mark: "✗", label: "未通过" };
  return { cls: "is-warn", mark: "!", label: "数据不足" };
}

function ruleList(checks: RuleCheck[], missing: string[]): string {
  const rows = checks.length
    ? checks
        .map((check) => {
          const mark = ruleMark(check.passed);
          return `<li class="strategy-rule ${mark.cls}">
            <span class="strategy-rule-mark" title="${mark.label}" aria-label="${mark.label}">${mark.mark}</span>
            <div class="strategy-rule-copy">
              <div class="strategy-rule-line">
                <b>${esc(check.label)}</b>
                <span class="strategy-rule-value">${esc(check.value)}</span>
                <span class="strategy-rule-threshold">${esc(check.threshold)}</span>
              </div>
              ${check.note ? `<span class="strategy-rule-note">${esc(check.note)}</span>` : ""}
            </div>
          </li>`;
        })
        .join("")
    : `<li class="strategy-drawer-empty">这只股票没有规则明细。</li>`;

  const missingBlock = missing.length
    ? `<div class="strategy-rule-missing">${icon("info", 11)}<span>数据不足：${esc(missing.join("、"))}；数据不足的规则不计为通过。</span></div>`
    : "";

  return `<ul class="strategy-rules">${rows}</ul>${missingBlock}`;
}

function failedList(stock: ExcludedStock): string {
  const items = stock.failed.length
    ? stock.failed
        .map(
          (key) => `<li class="strategy-rule is-fail">
        <span class="strategy-rule-mark" title="未通过" aria-label="未通过">✗</span>
        <div class="strategy-rule-copy"><div class="strategy-rule-line"><b>${esc(ruleLabel(key))}</b><span class="strategy-rule-note">未达到阈值</span></div></div>
      </li>`,
        )
        .join("")
    : `<li class="strategy-drawer-empty">没有记录失败规则。</li>`;
  return `<ul class="strategy-rules">${items}</ul>`;
}

/* ————————————————— profile panel ————————————————— */

type ProfileKey = Exclude<keyof StrategyProfile, "updatedAt">;

interface ProfileField {
  key: ProfileKey;
  label: string;
  unit: string;
  hint: string;
  step: string;
  min: string;
  /** 显示值 = 契约值 × scale；main.ts 保存时按同一比例除回去。 */
  scale: number;
  digits: number;
}

const PROFILE_FIELDS: ProfileField[] = [
  { key: "maxPrice", label: "股价上限", unit: "元", hint: "高于该价格直接剔除", step: "0.01", min: "0", scale: 1, digits: 2 },
  { key: "maxFloatCap", label: "流通市值上限", unit: "亿元", hint: "按 1 亿 = 100,000,000 元换算", step: "10", min: "0", scale: 1e-8, digits: 1 },
  { key: "minLimitCount", label: "涨停次数下限", unit: "次", hint: "窗口期内涨停次数，含当日", step: "1", min: "0", scale: 1, digits: 0 },
  { key: "limitWindowDays", label: "涨停统计窗口", unit: "交易日", hint: "默认 120 个交易日", step: "5", min: "20", scale: 1, digits: 0 },
  { key: "maxStreak", label: "最高连板上限", unit: "板", hint: "近一年达到该高度视为透支", step: "1", min: "1", scale: 1, digits: 0 },
  { key: "maxGain20d", label: "20 日涨幅上限", unit: "%", hint: "近一年最大 20 日涨幅", step: "1", min: "0", scale: 1, digits: 1 },
  { key: "minSectorLimitUps", label: "板块涨停家数下限", unit: "只", hint: "主板块当日涨停家数", step: "1", min: "1", scale: 1, digits: 0 },
  { key: "minSectorContinuous", label: "板块连板家数下限", unit: "只", hint: "主板块连续涨停家数", step: "1", min: "0", scale: 1, digits: 0 },
  { key: "minSealRatio", label: "封单比下限", unit: "%", hint: "封单额 ÷ 成交额", step: "1", min: "0", scale: 100, digits: 1 },
  { key: "maxOpenNum", label: "开板上限", unit: "次", hint: "0 表示不接受炸板", step: "1", min: "0", scale: 1, digits: 0 },
  { key: "latestFirstSealMinute", label: "首封时限", unit: "分钟", hint: "自 09:30 起算，30 即 10:00", step: "5", min: "0", scale: 1, digits: 0 },
  { key: "minTurnover", label: "换手下限", unit: "%", hint: "衡量放量程度", step: "0.5", min: "0", scale: 1, digits: 1 },
  { key: "topN", label: "观察上限", unit: "只", hint: "候选最多展示的只数", step: "1", min: "1", scale: 1, digits: 0 },
];

export function renderStrategyProfilePanel(): string {
  const v = view();
  if (v.profileOpen !== true) return "";
  const profile = v.profile ?? null;
  const saving = v.profileSaving === true;
  return `<div class="overlay modal-overlay strategy-profile" id="strategy-profile" role="dialog" aria-modal="true" aria-label="策略参数">
    <div class="overlay-panel strategy-profile-panel">
      <div class="modal-head">
        <div><h2>策略参数</h2><p>13 项固定规则 · 保存后重算，不改写历史与快照</p></div>
        <button class="modal-close" data-profile-close aria-label="关闭">${icon("close", 15)}</button>
      </div>
      <div class="modal-body strategy-profile-body" id="strategy-profile-form">
        ${profile ? `<div class="strategy-profile-grid">${PROFILE_FIELDS.map((field) => profileField(profile, field)).join("")}</div>` : `<p class="strategy-profile-missing">正在读取参数…</p>`}
        <p class="strategy-profile-note">${icon("info", 11)}参数只改变筛选阈值，不代表收益预期；修改后点「保存参数」并重新运行筛选。</p>
      </div>
      <div class="modal-foot">
        <button class="btn" data-profile-close>取消</button>
        <button class="btn primary" data-profile-save ${saving || !profile ? "disabled" : ""}>${saving ? "保存中" : "保存参数"}</button>
      </div>
    </div>
  </div>`;
}

function profileField(profile: StrategyProfile, field: ProfileField): string {
  const raw = Number(profile[field.key]);
  const value = trimNum((Number.isFinite(raw) ? raw : 0) * field.scale, field.digits);
  return `<label class="strategy-field">
    <span class="strategy-field-label">${field.label}<span class="strategy-field-unit">${field.unit}</span></span>
    <input type="number" inputmode="decimal" step="${field.step}" min="${field.min}" value="${value}" data-profile-field="${field.key}" autocomplete="off" spellcheck="false" />
    <span class="strategy-field-hint">${esc(field.hint)}</span>
  </label>`;
}
