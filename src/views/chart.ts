import { esc, fmtAmount, fmtClock, fmtMoney, fmtPct, fmtPrice, fmtShortDate, fmtVolume, icon, tierName, tone } from "../lib/ui";
import { findStock, state } from "../lib/state";
import type { KlineCandle } from "../lib/types";

const PERIOD_LABEL: Record<string, string> = { day: "日线", week: "周线", month: "月线" };
const RANGES = [
  { value: 60, label: "3月" },
  { value: 120, label: "半年" },
  { value: 250, label: "一年" },
  { value: 0, label: "全部" },
];

function exchange(code: string): string {
  if (code.startsWith("688")) return "科创板";
  if (code.startsWith("6") || code.startsWith("9")) return "沪市";
  if (code.startsWith("300") || code.startsWith("301")) return "创业板";
  return "深市";
}

function stats(candles: KlineCandle[]) {
  if (!candles.length) return null;
  const last = candles[candles.length - 1];
  const prev = candles.length > 1 ? candles[candles.length - 2] : last;
  const window = candles.slice(-250);
  const hi = Math.max(...window.map((d) => d.high));
  const lo = Math.min(...window.map((d) => d.low));
  const first = window[0];
  const yearReturn = first ? ((last.close - first.close) / Math.max(0.001, first.close)) * 100 : 0;
  const twenty = candles.slice(-21);
  const twentyFirst = twenty[0];
  const monthReturn = twentyFirst ? ((last.close - twentyFirst.close) / Math.max(0.001, twentyFirst.close)) * 100 : 0;
  const avgAmount = candles.slice(-20).reduce((a, d) => a + d.amount, 0) / Math.max(1, candles.slice(-20).length);
  const amplitude = ((last.high - last.low) / Math.max(0.001, prev.close)) * 100;
  return { last, prev, hi, lo, yearReturn, monthReturn, avgAmount, amplitude };
}

export function renderChartView(): string {
  const stock = state.chartStock;
  if (!stock) {
    return `<section class="view view-chart">
      <header class="chart-head">
        <div class="chart-identity"><div class="chart-name-line"><h1 class="chart-name">K线</h1></div><div class="chart-meta"><span>选择一只股票开始</span></div></div>
      </header>
      <div class="empty-state" style="flex:1">
        <div class="empty-mark">${icon("chart", 22)}</div>
        <div class="empty-title">没有打开的股票</div>
        <div class="empty-desc">搜索代码或名称，查看日、周、月 K 线，叠加 EMA 与 KDJ。</div>
        <button class="empty-action" data-action="search">搜索股票</button>
      </div>
    </section>`;
  }
  const data = state.chartData;
  const candles = data?.candles ?? [];
  const st = stats(candles);
  const last = st?.last;
  const name = data?.name || stock?.name || (stock ? stock.code : "选择股票");
  const code = data?.code || stock?.code || "—";
  const pct = last?.pct ?? 0;
  const change = last && st ? last.close - st.prev.close : 0;
  const loading = state.chartLoading && !data;
  const error = state.chartError && !data;
  const dateLabel = data?.latestDate ? fmtShortDate(data.latestDate.replace(/-/g, "")) : "—";

  const identity = `<div class="chart-identity">
    <div class="chart-name-line"><h1 class="chart-name">${esc(name)}</h1><span class="chart-code">${esc(code)} · ${stock ? exchange(code) : ""}</span></div>
    <div class="chart-meta">
      <span>${PERIOD_LABEL[state.chartPeriod]}</span><span class="sep"></span>
      <span>前复权</span><span class="sep"></span>
      <span>截至 ${dateLabel}</span>
      ${data?.source === "cache" ? `<span class="sep"></span><span style="color:var(--brass)">本地缓存</span>` : ""}
    </div>
  </div>`;

  const quote = last
    ? `<div class="chart-quote">
        <span class="chart-price">${fmtPrice(last.close)}</span>
        <span class="chart-change">
          <span class="text-${tone(pct)}">${fmtPct(pct)}</span>
          <span class="text-${tone(change)}">${change >= 0 ? "+" : ""}${change.toFixed(2)}</span>
        </span>
      </div>`
    : `<div class="chart-quote"><span class="chart-price" style="color:var(--faint)">—</span></div>`;

  const snapshots = last
    ? `<div class="chart-snapshot">
        <div class="snapshot-item"><span class="snapshot-label">最高</span><span class="snapshot-value">${fmtPrice(last.high)}</span></div>
        <div class="snapshot-item"><span class="snapshot-label">最低</span><span class="snapshot-value">${fmtPrice(last.low)}</span></div>
        <div class="snapshot-item"><span class="snapshot-label">成交额</span><span class="snapshot-value">${fmtAmount(last.amount)}</span></div>
        <div class="snapshot-item"><span class="snapshot-label">换手</span><span class="snapshot-value">${last.turnover.toFixed(2)}%</span></div>
      </div>`
    : "";

  return `<section class="view view-chart">
    <header class="chart-head">
      <button class="back-btn" data-action="chart-back" title="返回" aria-label="返回">${icon("arrowLeft", 16)}</button>
      ${identity}
      ${quote}
      <div class="chart-head-spacer"></div>
      ${snapshots}
    </header>
    <div class="chart-layout">
      <div class="chart-main">
        <div class="chart-toolbar">
          <div class="seg" role="group" aria-label="K线周期">
            ${(["day", "week", "month"] as const).map((p) => `<button class="${state.chartPeriod === p ? "active" : ""}" data-chart-period="${p}">${{ day: "日K", week: "周K", month: "月K" }[p]}</button>`).join("")}
          </div>
          <div class="seg" role="group" aria-label="显示区间">
            ${RANGES.map((r) => `<button class="${state.chartRange === r.value ? "active" : ""}" data-chart-range="${r.value}">${r.label}</button>`).join("")}
          </div>
          <span class="toolbar-divider"></span>
          <button class="chip ${state.chartEma ? "active" : ""}" data-indicator="ema" aria-pressed="${state.chartEma}">EMA</button>
          <button class="chip ${state.chartKdj ? "active" : ""}" data-indicator="kdj" aria-pressed="${state.chartKdj}">KDJ</button>
          <span class="toolbar-spacer"></span>
          <span class="chart-note">滚轮缩放 · 拖动平移 · 方向键查看</span>
        </div>
        <div class="chart-stage-shell">
          <div class="chart-stage" id="chart-stage"></div>
          ${loading ? `<div class="chart-loading"><span class="loader"></span><span>正在读取 K 线</span></div>` : ""}
          ${error ? `<div class="chart-error"><div class="error-title">K线没有加载</div><span>${esc(state.chartError || "")}</span><button class="chart-retry" data-action="chart-retry">重新加载</button></div>` : ""}
        </div>
        <div class="chart-footnote"><span>行情数据 · 东方财富 · 前复权</span><span>EMA 5 / 10 / 20 / 60 · KDJ (9, 3, 3)</span></div>
      </div>
      <aside class="chart-side">${renderChartSide(st)}</aside>
    </div>
  </section>`;
}

function renderChartSide(st: ReturnType<typeof stats>): string {
  const stock = state.chartStock ? findStock(state.chartStock.code) : undefined;
  const code = state.chartStock?.code ?? "";
  const archive = stock
    ? `<div class="archive">
        <div class="archive-tag">${icon("activity", 11)} 今日涨停 · ${esc(tierName(stock.streak))}</div>
        <div class="archive-name">${esc(stock.name)} <span style="font-family:var(--mono);font-size:8px;color:var(--faint)">${stock.code}</span></div>
        <div class="archive-reason">${esc(stock.reason || "—")}</div>
        <div class="archive-rows">
          <div class="archive-row"><label>首次封板</label><span>${fmtClock(stock.firstSeal)}</span></div>
          <div class="archive-row"><label>封单金额</label><span>${stock.sealAmount > 0 ? fmtMoney(stock.sealAmount) : "—"}</span></div>
          <div class="archive-row"><label>连板高度</label><span>${esc(stock.highDays)}</span></div>
          <div class="archive-row"><label>开板次数</label><span>${stock.openNum} 次</span></div>
          <div class="archive-row"><label>换手率</label><span>${stock.turnoverRate.toFixed(2)}%</span></div>
          <div class="archive-row"><label>封板成功率</label><span>${stock.successRate.toFixed(0)}%</span></div>
        </div>
      </div>`
    : state.chartStock
      ? `<div class="archive"><div class="archive-tag">${icon("info", 11)} 涨停档案</div><div class="archive-empty">${esc(code)} 今日未进入涨停池。<br />上方 K 线仍可查看价格、EMA 与 KDJ。</div></div>`
      : "";

  const perf = st
    ? `<div class="perf-grid">
        <div class="perf-item"><span class="perf-label">52周高</span><span class="perf-value">${fmtPrice(st.hi)}</span></div>
        <div class="perf-item"><span class="perf-label">52周低</span><span class="perf-value">${fmtPrice(st.lo)}</span></div>
        <div class="perf-item"><span class="perf-label">近一年</span><span class="perf-value text-${tone(st.yearReturn)}">${fmtPct(st.yearReturn)}</span></div>
        <div class="perf-item"><span class="perf-label">近20日</span><span class="perf-value text-${tone(st.monthReturn)}">${fmtPct(st.monthReturn)}</span></div>
        <div class="perf-item"><span class="perf-label">20日均额</span><span class="perf-value">${fmtAmount(st.avgAmount)}</span></div>
        <div class="perf-item"><span class="perf-label">今日振幅</span><span class="perf-value">${st.amplitude.toFixed(2)}%</span></div>
      </div>`
    : `<div class="perf-grid">${Array.from({ length: 6 })
        .map(() => `<div class="perf-item"><span class="sk" style="width:38px;height:8px"></span><span class="sk" style="width:62px;height:14px;margin-top:4px"></span></div>`)
        .join("")}</div>`;

  return `<div class="side-head"><h3 class="side-title">区间</h3><span class="side-kicker">最近 250 个交易日</span></div>
    ${perf}
    <div class="side-head" style="margin-top:22px"><h3 class="side-title">档案</h3><span class="side-kicker">当日涨停池</span></div>
    ${archive}
    <div class="indicator-note">
      <b>EMA</b> 指数移动平均，线越短反应越快。<br />
      <b>KDJ</b> 随机指标，K / D 在 20 下方与 80 上方常用于观察超卖与超买；J 值更敏感。<br />
      指标仅辅助观察，不构成投资建议。
    </div>`;
}
