import { esc, fmtAmount, fmtClock, fmtMoney, fmtPct, fmtPrice, fmtShortDate, icon, tierName, tone } from "../lib/ui";
import { filterStocks, findStock, state } from "../lib/state";
import type { ChartPrefs, KlineCandle, Period, StockQuote, WatchStock } from "../lib/types";

const PRIMARY_PERIODS: Array<{ value: Period; label: string }> = [
  { value: "1m", label: "1分" },
  { value: "day", label: "日K" },
  { value: "week", label: "周K" },
  { value: "month", label: "月K" },
];

const MORE_PERIODS: Array<{ value: Period; label: string }> = [
  { value: "15m", label: "15分钟" },
  { value: "30m", label: "30分钟" },
  { value: "60m", label: "60分钟" },
  { value: "year", label: "年K" },
];

const PERIOD_LABEL: Record<string, string> = {
  "1m": "1分钟",
  "15m": "15分钟",
  "30m": "30分钟",
  "60m": "60分钟",
  day: "日线",
  week: "周线",
  month: "月线",
  year: "年线",
};

export function rangeOptions(period: Period): Array<{ value: number; label: string }> {
  if (period === "1m") {
    return [
      { value: 60, label: "1时" },
      { value: 120, label: "半日" },
      { value: 240, label: "全日" },
      { value: 0, label: "全部" },
    ];
  }
  if (period.endsWith("m")) {
    return [
      { value: 60, label: "60根" },
      { value: 120, label: "120根" },
      { value: 250, label: "250根" },
      { value: 0, label: "全部" },
    ];
  }
  return [
    { value: 60, label: "3月" },
    { value: 120, label: "半年" },
    { value: 250, label: "一年" },
    { value: 0, label: "全部" },
  ];
}

export function normalizeChartRange(period: Period, current: number): number {
  const options = rangeOptions(period);
  if (options.some((o) => o.value === current)) return current;
  return period === "1m" ? 240 : 120;
}

function marketName(code: string, kind?: string): string {
  if (kind === "index") return "指数";
  if (code.startsWith("688")) return "科创板";
  if (code.startsWith("6") || code.startsWith("9")) return "沪市";
  if (code.startsWith("300") || code.startsWith("301")) return "创业板";
  return "深市";
}

function marketShort(code: string, market = ""): string {
  if (market === "1" || code.startsWith("6") || code.startsWith("9")) return "沪";
  if (code.startsWith("300") || code.startsWith("301")) return "创";
  if (code.startsWith("688")) return "科";
  return "深";
}

interface IntradaySnapshot {
  rows: KlineCandle[];
  base: number;
  pct: number;
  change: number;
  high: number;
  low: number;
  amount: number;
  turnover: number;
  avg: number;
}

function intradaySnapshot(candles: KlineCandle[], prevClose?: number | null): IntradaySnapshot | null {
  const last = candles[candles.length - 1];
  if (!last || !last.date.includes(" ")) return null;
  const day = last.date.slice(0, 10);
  const start = candles.findIndex((c) => c.date.startsWith(day));
  const rows = candles.slice(Math.max(0, start));
  const first = rows[0];
  if (!first) return null;
  const base = prevClose && prevClose > 0 ? prevClose : start > 0 ? candles[start - 1].close : first.open || first.close;
  const high = Math.max(...rows.map((r) => r.high));
  const low = Math.min(...rows.map((r) => r.low));
  const amount = rows.reduce((sum, r) => sum + r.amount, 0);
  const turnover = rows.reduce((sum, r) => sum + r.turnover, 0);
  const volume = rows.reduce((sum, r) => sum + r.volume, 0);
  const avg = volume > 0 ? amount / (volume * 100) : last.close;
  return {
    rows,
    base,
    pct: base > 0 ? ((last.close - base) / base) * 100 : 0,
    change: last.close - base,
    high,
    low,
    amount,
    turnover,
    avg,
  };
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

export function indicatorSummary(prefs: ChartPrefs): string {
  const parts: string[] = [];
  const maVisible = prefs.maLines.filter((l) => l.visible !== false);
  const emaVisible = prefs.emaLines.filter((l) => l.visible !== false);
  if (prefs.maEnabled && maVisible.length) parts.push(`MA ${maVisible.map((l) => l.period).join(" / ")}`);
  if (prefs.emaEnabled && emaVisible.length) parts.push(`EMA ${emaVisible.map((l) => l.period).join(" / ")}`);
  if (prefs.kdjEnabled) parts.push(`KDJ (${prefs.kdjN}, ${prefs.kdjK}, ${prefs.kdjD})`);
  return parts.join(" · ") || "未启用指标";
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
        <div class="empty-desc">搜索代码或名称，查看 1分、日、周、月与更多周期 K 线。</div>
        <button class="empty-action" data-action="search">搜索股票</button>
      </div>
    </section>`;
  }
  return `<section class="view view-chart">
    <header class="chart-head" id="chart-head">${renderChartHead()}</header>
    <div class="chart-body">
      <div class="chart-layout">
        <div class="chart-main">
          <div class="chart-toolbar" id="chart-toolbar">${renderChartToolbar()}</div>
          <div class="chart-stage-shell">
            <div class="chart-stage" id="chart-stage"></div>
            ${state.chartLoading ? `<div class="chart-loading"><span class="loader"></span><span>正在刷新 ${state.chartMode === "timeshare" ? "分时" : esc(PERIOD_LABEL[state.chartPeriod] || "K线")}</span></div>` : ""}
            ${state.chartError ? `<div class="chart-error"><div class="error-title">K线没有加载</div><span>${esc(state.chartError)}</span><button class="chart-retry" data-action="chart-retry">重新加载</button></div>` : ""}
          </div>
          <div class="chart-footnote"><span>东方财富 · ${state.chartMode === "timeshare" ? "分时" : "前复权"}${stock.kind === "index" ? " · 指数" : ""}</span><span>${state.chartMode === "timeshare" ? "价格 · 日内均价" : esc(indicatorSummary(state.chartPrefs))}</span></div>
        </div>
        ${renderChartDock()}
      </div>
    </div>
  </section>`;
}

export function chartSwitchContext(): { list: Array<{ code: string; name: string; market: string }>; index: number } {
  const current = state.chartStock;
  if (!current || current.kind !== "stock") return { list: [], index: -1 };
  let list = filterStocks().map((s) => ({ code: s.code, name: s.name, market: s.market }));
  if (!list.some((s) => s.code === current.code)) {
    const group = state.watchGroups.find((g) => g.id === state.watchGroupId) ?? state.watchGroups[0];
    const groupList = group?.stocks ?? [];
    if (groupList.some((s) => s.code === current.code)) list = groupList.slice();
  }
  if (!list.some((s) => s.code === current.code)) {
    const seen = new Set<string>();
    list = [];
    for (const s of [...(state.day?.stocks ?? []), ...(state.day?.openLimit ?? []), ...(state.day?.limitDown ?? [])]) {
      if (seen.has(s.code)) continue;
      seen.add(s.code);
      list.push({ code: s.code, name: s.name, market: s.market });
    }
  }
  return { list, index: list.findIndex((s) => s.code === current.code) };
}

function currentStockQuote(stock: NonNullable<typeof state.chartStock>): StockQuote | null {
  const quote = state.chartQuote;
  if (!quote) return null;
  const code = stock.kind === "index" ? (stock.secid || stock.code).split(".").pop() : stock.code;
  return quote.code === code ? quote : null;
}

function quoteDateLabel(asOf: string): string {
  const [day, time] = asOf.split(" ");
  if (!day || !time) return asOf;
  return `${day.slice(5, 7)}.${day.slice(8, 10)} ${time.slice(0, 5)}`;
}

export function renderChartHead(): string {
  const stock = state.chartStock;
  if (!stock) return "";
  const data = state.chartData;
  const candles = data?.candles ?? [];
  const intraday = intradaySnapshot(candles, data?.prevClose);
  const st = stats(candles);
  const last = st?.last;
  const live = currentStockQuote(stock);
  const name = data?.name || stock.name || stock.code;
  const code = stock.kind === "index" ? stock.secid || stock.code : data?.code || stock.code;
  const price = live?.price ?? last?.close ?? 0;
  const pct = live?.pct ?? intraday?.pct ?? last?.pct ?? 0;
  const change = live?.change ?? intraday?.change ?? (last && st ? last.close - st.prev.close : 0);
  const dayHigh = live?.high || intraday?.high || last?.high || 0;
  const dayLow = live?.low || intraday?.low || last?.low || 0;
  const dayAmount = live?.amount || intraday?.amount || last?.amount || 0;
  const dayTurnover = live?.turnover || intraday?.turnover || last?.turnover || 0;
  let dateLabel = "—";
  if (data?.latestDate) {
    if (data.latestDate.includes(" ")) {
      const [day, time] = data.latestDate.split(" ");
      dateLabel = `${day.slice(5, 7)}.${day.slice(8, 10)} ${time.slice(0, 5)}`;
    } else {
      dateLabel = fmtShortDate(data.latestDate.replace(/-/g, ""));
    }
  }
  if (live?.asOf) dateLabel = quoteDateLabel(live.asOf);

  const quote = price > 0
    ? `<div class="chart-quote">
        <span class="chart-price">${fmtPrice(price)}</span>
        <span class="chart-change">
          <b class="text-${tone(pct)}">${fmtPct(pct)}</b>
          <em class="text-${tone(change)}">${change >= 0 ? "+" : ""}${change.toFixed(2)}</em>
        </span>
      </div>`
    : `<div class="chart-quote"><span class="chart-price" style="color:var(--faint)">—</span></div>`;

  const snapshots = price > 0
    ? `<div class="chart-snapshot">
        <div class="snapshot-item"><span class="snapshot-label">最高</span><span class="snapshot-value">${fmtPrice(dayHigh)}</span></div>
        <div class="snapshot-item"><span class="snapshot-label">最低</span><span class="snapshot-value">${fmtPrice(dayLow)}</span></div>
        <div class="snapshot-item"><span class="snapshot-label">成交额</span><span class="snapshot-value">${fmtAmount(dayAmount)}</span></div>
        <div class="snapshot-item"><span class="snapshot-label">${intraday ? "均价" : "换手"}</span><span class="snapshot-value">${intraday ? fmtPrice(intraday.avg) : `${dayTurnover.toFixed(2)}%`}</span></div>
      </div>`
    : "";

  return `<button class="back-btn" data-action="chart-back" title="返回" aria-label="返回">${icon("arrowLeft", 16)}</button>
    <div class="chart-identity">
      <div class="chart-name-line">
        <h1 class="chart-name">${esc(name)}</h1>
        <span class="chart-code">${esc(code)}</span>
        <span class="chart-market">${marketName(stock.code, stock.kind)}</span>
      </div>
      <div class="chart-meta">
        <span>${state.chartMode === "timeshare" ? "分时" : PERIOD_LABEL[state.chartPeriod]}</span><span class="meta-dot"></span>
        <span>${stock.kind === "index" ? "指数" : state.chartMode === "timeshare" ? "日内均价" : "前复权"}</span><span class="meta-dot"></span>
        <span>截至 ${dateLabel}</span>
        ${live ? `<span class="meta-dot"></span><span class="live-tag">${live.stale ? "缓存" : "实时"}</span>` : data?.source === "cache" ? `<span class="meta-dot"></span><span class="cache-tag">本地缓存</span>` : ""}
      </div>
    </div>
    ${quote}
    <div class="chart-head-spacer"></div>
    ${snapshots}`;
}

export function renderChartToolbar(): string {
  const prefs = state.chartPrefs;
  const moreActive = MORE_PERIODS.find((p) => p.value === state.chartPeriod);
  const ranges = rangeOptions(state.chartPeriod);
  return `<div class="seg chart-periods" role="group" aria-label="K线周期">
      <button class="${state.chartMode === "timeshare" ? "active" : ""}" data-chart-mode="timeshare">分时</button>
      ${PRIMARY_PERIODS.map((p) => `<button class="${state.chartMode === "kline" && state.chartPeriod === p.value ? "active" : ""}" data-chart-period="${p.value}">${p.label}</button>`).join("")}
    </div>
    <div class="period-more" id="period-more">
      <button class="period-more-btn ${moreActive && state.chartMode === "kline" ? "active" : ""}" data-action="period-menu" aria-haspopup="true">
        <span>${moreActive && state.chartMode === "kline" ? moreActive.label : "更多"}</span>${icon("chevronDown", 12)}
      </button>
      <div class="period-menu" role="menu">
        ${MORE_PERIODS.map((p) => `<button class="${state.chartMode === "kline" && state.chartPeriod === p.value ? "active" : ""}" data-chart-period="${p.value}">${p.label}${state.chartMode === "kline" && state.chartPeriod === p.value ? icon("check", 12) : ""}</button>`).join("")}
      </div>
    </div>
    ${state.chartMode === "kline" ? `<div class="seg chart-ranges" role="group" aria-label="显示区间">
      ${ranges.map((r) => `<button class="${state.chartRange === r.value ? "active" : ""}" data-chart-range="${r.value}">${r.label}</button>`).join("")}
    </div>
    <span class="toolbar-divider"></span>
    <span class="toolbar-break"></span>
    <div class="chart-indicators">
      <button class="chip ${prefs.maEnabled ? "active" : ""}" data-indicator="ma" aria-pressed="${prefs.maEnabled}">MA</button>
      <button class="chip ${prefs.emaEnabled ? "active" : ""}" data-indicator="ema" aria-pressed="${prefs.emaEnabled}">EMA</button>
      <button class="chip ${prefs.kdjEnabled ? "active" : ""}" data-indicator="kdj" aria-pressed="${prefs.kdjEnabled}">KDJ</button>
    </div>
    <button class="chart-settings-btn" data-action="indicator-settings" title="MA / EMA 颜色、粗细、虚实；KDJ 系数">${icon("sliders", 14)}<span>参数</span></button>
    <button class="chart-info" aria-label="指标说明">${icon("info", 13)}<span class="info-pop"><b>MA</b> 简单移动平均 · <b>EMA</b> 指数移动平均 · <b>KDJ</b> 随机指标。颜色、粗细、虚实可在「参数」里修改。指标仅辅助观察，不构成投资建议。</span></button>` : `<span class="chart-timeshare-chip">日内走势 · 均价线</span>`}
    <div class="chart-toolbar-spacer"></div>
    <div class="chart-toolbar-actions">
      ${state.chartStock?.kind === "stock" ? renderChartSwitchAction() : ""}
      ${state.chartStock?.kind === "stock" ? `<button class="chart-watch-add" data-action="watch-add-current">${icon("plus", 12)} 加自选</button>` : ""}
    </div>`;
}

function renderChartSwitchAction(): string {
  const switcher = chartSwitchContext();
  if (switcher.index < 0) return "";
  return `<div class="chart-switch" title="在当前列表 / 自选分组中直接切换">
    <button data-action="chart-prev" aria-label="上一只" ${switcher.list.length < 2 ? "disabled" : ""}>${icon("chevronLeft", 13)}</button>
    <span>${switcher.index >= 0 ? switcher.index + 1 : "—"}<i>/</i>${switcher.list.length || "—"}</span>
    <button data-action="chart-next" aria-label="下一只" ${switcher.list.length < 2 ? "disabled" : ""}>${icon("chevronRight", 13)}</button>
  </div>`;
}

function renderPerf(): string {
  const candles = state.chartData?.candles ?? [];
  const intraday = ["1m", "15m", "30m", "60m"].includes(state.chartPeriod) ? intradaySnapshot(candles, state.chartData?.prevClose) : null;
  if (intraday) {
    const amplitude = intraday.base > 0 ? ((intraday.high - intraday.low) / intraday.base) * 100 : 0;
    return `<div class="perf-grid">
      <div class="perf-item"><span class="perf-label">日内高</span><span class="perf-value">${fmtPrice(intraday.high)}</span></div>
      <div class="perf-item"><span class="perf-label">日内低</span><span class="perf-value">${fmtPrice(intraday.low)}</span></div>
      <div class="perf-item"><span class="perf-label">日内涨幅</span><span class="perf-value text-${tone(intraday.pct)}">${fmtPct(intraday.pct)}</span></div>
      <div class="perf-item"><span class="perf-label">振幅</span><span class="perf-value">${amplitude.toFixed(2)}%</span></div>
      <div class="perf-item"><span class="perf-label">成交额</span><span class="perf-value">${fmtAmount(intraday.amount)}</span></div>
      <div class="perf-item"><span class="perf-label">均价</span><span class="perf-value">${fmtPrice(intraday.avg)}</span></div>
    </div>`;
  }
  const st = stats(candles);
  if (!st) {
    return `<div class="perf-grid">${Array.from({ length: 6 })
      .map(() => `<div class="perf-item"><span class="sk" style="width:38px;height:8px"></span><span class="sk" style="width:62px;height:14px;margin-top:4px"></span></div>`)
      .join("")}</div>`;
  }
  return `<div class="perf-grid">
    <div class="perf-item"><span class="perf-label">252日高</span><span class="perf-value">${fmtPrice(st.hi)}</span></div>
    <div class="perf-item"><span class="perf-label">252日低</span><span class="perf-value">${fmtPrice(st.lo)}</span></div>
    <div class="perf-item"><span class="perf-label">区间涨幅</span><span class="perf-value text-${tone(st.yearReturn)}">${fmtPct(st.yearReturn)}</span></div>
    <div class="perf-item"><span class="perf-label">近20日</span><span class="perf-value text-${tone(st.monthReturn)}">${fmtPct(st.monthReturn)}</span></div>
    <div class="perf-item"><span class="perf-label">20日均额</span><span class="perf-value">${fmtAmount(st.avgAmount)}</span></div>
    <div class="perf-item"><span class="perf-label">今日振幅</span><span class="perf-value">${st.amplitude.toFixed(2)}%</span></div>
  </div>`;
}

function renderArchive(): string {
  const sel = state.chartStock;
  if (!sel) return "";
  const limitUp = sel.kind === "stock" ? findStock(sel.code) : undefined;
  const openStock = sel.kind === "stock" ? state.day?.openLimit.find((s) => s.code === sel.code) : undefined;
  const downStock = sel.kind === "stock" ? state.day?.limitDown.find((s) => s.code === sel.code) : undefined;
  if (sel.kind === "index") {
    return `<div class="archive"><div class="archive-tag">${icon("activity", 12)} 指数行情</div><div class="archive-empty">指数 K线不提供涨停档案。<br />可切换周期与指标观察趋势。</div></div>`;
  }
  if (limitUp) {
    return `<div class="archive">
      <div class="archive-tag">${icon("activity", 12)} 今日涨停 · ${esc(tierName(limitUp.streak))}</div>
      <div class="archive-name">${esc(limitUp.name)} <span>${limitUp.code}</span></div>
      <div class="archive-reason">${esc(limitUp.reason || "—")}</div>
      <div class="archive-rows">
        <div class="archive-row"><label>首次封板</label><span>${fmtClock(limitUp.firstSeal)}</span></div>
        <div class="archive-row"><label>封单金额</label><span>${limitUp.sealAmount > 0 ? fmtMoney(limitUp.sealAmount) : "—"}</span></div>
        <div class="archive-row"><label>连板高度</label><span>${esc(limitUp.highDays)}</span></div>
        <div class="archive-row"><label>开板次数</label><span>${limitUp.openNum} 次</span></div>
        <div class="archive-row"><label>换手率</label><span>${limitUp.turnoverRate.toFixed(2)}%</span></div>
        <div class="archive-row"><label>封板成功率</label><span>${limitUp.successRate.toFixed(0)}%</span></div>
      </div>
    </div>`;
  }
  if (openStock) {
    return `<div class="archive">
      <div class="archive-tag">${icon("activity", 12)} 今日炸板 · ${openStock.openNum > 0 ? `${openStock.openNum} 次开板` : "触板未封"}</div>
      <div class="archive-name">${esc(openStock.name)} <span>${openStock.code}</span></div>
      <div class="archive-reason">盘中触及涨停后打开</div>
      <div class="archive-rows">
        <div class="archive-row"><label>首次触板</label><span>${fmtClock(openStock.firstSeal)}</span></div>
        <div class="archive-row"><label>末次封板</label><span>${fmtClock(openStock.lastSeal)}</span></div>
        <div class="archive-row"><label>收盘涨幅</label><span class="text-${tone(openStock.changeRate)}">${fmtPct(openStock.changeRate)}</span></div>
        <div class="archive-row"><label>换手率</label><span>${openStock.turnoverRate.toFixed(2)}%</span></div>
        <div class="archive-row"><label>流通市值</label><span>${fmtMoney(openStock.floatCap)}</span></div>
      </div>
    </div>`;
  }
  if (downStock) {
    return `<div class="archive">
      <div class="archive-tag">${icon("activity", 12)} 今日跌停</div>
      <div class="archive-name">${esc(downStock.name)} <span>${downStock.code}</span></div>
      <div class="archive-reason">收盘封死跌停</div>
      <div class="archive-rows">
        <div class="archive-row"><label>收盘涨幅</label><span class="text-${tone(downStock.changeRate)}">${fmtPct(downStock.changeRate)}</span></div>
        <div class="archive-row"><label>换手率</label><span>${downStock.turnoverRate.toFixed(2)}%</span></div>
        <div class="archive-row"><label>流通市值</label><span>${fmtMoney(downStock.floatCap)}</span></div>
        <div class="archive-row"><label>市场</label><span>${downStock.market === "GEM" ? "创业板" : downStock.market === "STAR" ? "科创板" : "主板"}</span></div>
      </div>
    </div>`;
  }
  return `<div class="archive"><div class="archive-tag">${icon("info", 12)} 盘口档案</div><div class="archive-empty">${esc(sel.code)} 今日未进入涨停、炸板或跌停池。<br />上方 K 线仍可查看价格与指标。</div></div>`;
}

export function renderChartInsight(): string {
  const intraday = ["1m", "15m", "30m", "60m"].includes(state.chartPeriod);
  return `<div class="insight-dock">
    <div class="dock-section-head"><h3>${intraday ? "日内" : "区间"}</h3><span>${intraday ? "09:30 – 15:00" : "最近 250 个周期"}</span></div>
    ${renderPerf()}
    <div class="dock-section-head" style="margin-top:26px"><h3>档案</h3><span>当日盘口池</span></div>
    ${renderArchive()}
  </div>`;
}

function watchQuote(code: string): { text: string; cls: string } | null {
  const live = state.watchQuotes[code];
  if (live) return { text: fmtPct(live.pct), cls: `text-${tone(live.pct)}` };
  const up = findStock(code);
  if (up) return { text: fmtPct(up.changeRate), cls: `text-${tone(up.changeRate)}` };
  const open = state.day?.openLimit.find((s) => s.code === code);
  if (open) return { text: fmtPct(open.changeRate), cls: `text-${tone(open.changeRate)}` };
  const down = state.day?.limitDown.find((s) => s.code === code);
  if (down) return { text: fmtPct(down.changeRate), cls: `text-${tone(down.changeRate)}` };
  return null;
}

export function renderWatchDock(): string {
  const groups = state.watchGroups;
  const active = groups.find((g) => g.id === state.watchGroupId) ?? groups[0];
  const stocks = active?.stocks ?? [];
  const canAdd = state.chartStock?.kind === "stock";
  const rows = stocks
    .map((s: WatchStock) => {
      const quote = watchQuote(s.code);
      return `<button class="watch-row" data-stock-code="${s.code}" data-stock-name="${esc(s.name)}" data-watch-code="${s.code}" data-watch-group="${active?.id}" title="查看 ${esc(s.name)} K线 · 右键分配到其他分组">
        <span class="watch-row-main"><b>${esc(s.name)}</b><em>${s.code}</em></span>
        <span class="watch-row-quote ${quote?.cls || "text-flat"}">${quote?.text || "—"}</span>
        <span class="watch-row-market">${marketShort(s.code, s.market)}</span>
        <span class="watch-row-go">${icon("arrowUpRight", 12)}</span>
      </button>`;
    })
    .join("");

  return `<div class="watch-dock">
    <div class="watch-dock-head">
      <div><h3>自选</h3><p>${stocks.length} 只 · ${active ? esc(active.name) : "未分组"}</p></div>
      <div class="watch-dock-tools">
        ${active ? `<button class="dock-icon" data-action="watch-rename" title="重命名分组">${icon("edit", 14)}</button><button class="dock-icon danger" data-action="watch-delete" title="删除分组">${icon("trash", 14)}</button>` : ""}
        <button class="dock-icon accent" data-action="watch-create-group" title="新建分组">${icon("plus", 15)}</button>
      </div>
    </div>
    <div class="watch-groups">
      ${groups.map((g) => `<button class="watch-group ${g.id === active?.id ? "active" : ""}" data-watch-group="${g.id}">${esc(g.name)}<i>${g.stocks.length}</i></button>`).join("")}
      ${groups.length ? "" : `<span class="watch-groups-empty">还没有分组</span>`}
    </div>
    ${canAdd ? `<button class="watch-add-row" data-action="watch-add-current">${icon("plus", 13)} 加入当前股票</button>` : ""}
    <div class="watch-list">
      ${
        !active
          ? `<div class="watch-empty"><b>先建一个分组</b><span>把常看的票放在一起，右键可以分配到其他分组。</span></div>`
          : !stocks.length
            ? `<div class="watch-empty"><b>这里还是空的</b><span>${canAdd ? "用上方按钮加入当前股票，或到涨停池批量添加。" : "到涨停池批量添加股票。"}</span></div>`
            : rows
      }
    </div>
    <div class="watch-dock-foot">
      <span class="watch-foot-hint">同组去重 · 右键分配分组</span>
    </div>
  </div>`;
}

export function renderChartDock(): string {
  const active = state.chartDock;
  const watchCount = state.watchGroups.find((g) => g.id === state.watchGroupId)?.stocks.length ?? state.watchGroups[0]?.stocks.length ?? 0;
  return `<aside class="chart-dock" id="chart-dock">
    <div class="dock-tabs">
      <button class="dock-tab ${active === "watch" ? "active" : ""}" data-dock-tab="watch"><span>自选</span><b>${watchCount}</b></button>
      <button class="dock-tab ${active === "insight" ? "active" : ""}" data-dock-tab="insight"><span>档案</span></button>
    </div>
    <div class="dock-content" id="dock-content">${active === "insight" ? renderChartInsight() : renderWatchDock()}</div>
  </aside>`;
}

export function updateChartDock(): void {
  const old = document.getElementById("chart-dock");
  if (!old) return;
  const scroll = old.querySelector<HTMLElement>(".watch-list")?.scrollTop ?? 0;
  const tmp = document.createElement("div");
  tmp.innerHTML = renderChartDock();
  old.replaceWith(tmp.firstElementChild!);
  const list = document.querySelector<HTMLElement>("#chart-dock .watch-list");
  if (list) list.scrollTop = scroll;
}
