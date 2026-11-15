import { esc, fmtAmount, fmtClock, fmtMoney, fmtPct, fmtPrice, fmtShortDate, icon, tierName, tone } from "../lib/ui";
import { filterStocks, findStock, state } from "../lib/state";
import type { ChartPrefs, KlineCandle } from "../lib/types";

const PERIODS: Array<{ value: import("../lib/types").Period; label: string }> = [
  { value: "15m", label: "15分" },
  { value: "30m", label: "30分" },
  { value: "60m", label: "60分" },
  { value: "day", label: "日K" },
  { value: "week", label: "周K" },
  { value: "month", label: "月K" },
  { value: "year", label: "年K" },
];

const PERIOD_LABEL: Record<string, string> = {
  "15m": "15分钟",
  "30m": "30分钟",
  "60m": "60分钟",
  day: "日线",
  week: "周线",
  month: "月线",
  year: "年线",
};

const RANGES = [
  { value: 60, label: "3月" },
  { value: 120, label: "半年" },
  { value: 250, label: "一年" },
  { value: 0, label: "全部" },
];

function exchange(code: string, kind?: string): string {
  if (kind === "index") return "指数";
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

export function indicatorSummary(prefs: ChartPrefs): string {
  const parts: string[] = [];
  if (prefs.maEnabled) parts.push(`MA ${prefs.maPeriods.join(" / ")}`);
  if (prefs.emaEnabled) parts.push(`EMA ${prefs.emaPeriods.join(" / ")}`);
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
        <div class="empty-desc">搜索代码或名称，查看分时、日、周、月、年 K 线，叠加 MA / EMA / KDJ。</div>
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
            ${state.chartLoading ? `<div class="chart-loading"><span class="loader"></span><span>正在刷新 ${esc(PERIOD_LABEL[state.chartPeriod] || "K线")}</span></div>` : ""}
            ${state.chartError ? `<div class="chart-error"><div class="error-title">K线没有加载</div><span>${esc(state.chartError)}</span><button class="chart-retry" data-action="chart-retry">重新加载</button></div>` : ""}
          </div>
          <div class="chart-footnote"><span>行情数据 · 东方财富 · 前复权${stock.kind === "index" ? " · 指数" : ""}</span><span>${esc(indicatorSummary(state.chartPrefs))}</span></div>
        </div>
        <aside class="chart-side" id="chart-side">${renderChartSide()}</aside>
      </div>
      ${renderWatchPanel()}
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

export function renderChartHead(): string {
  const stock = state.chartStock;
  if (!stock) return "";
  const data = state.chartData;
  const switcher = chartSwitchContext();
  const candles = data?.candles ?? [];
  const st = stats(candles);
  const last = st?.last;
  const name = data?.name || stock.name || stock.code;
  const code = stock.kind === "index" ? (stock.secid || stock.code) : data?.code || stock.code;
  const pct = last?.pct ?? 0;
  const change = last && st ? last.close - st.prev.close : 0;
  let dateLabel = "—";
  if (data?.latestDate) {
    if (data.latestDate.includes(" ")) {
      const [day, time] = data.latestDate.split(" ");
      dateLabel = `${day.slice(5, 7)}.${day.slice(8, 10)} ${time.slice(0, 5)}`;
    } else {
      dateLabel = fmtShortDate(data.latestDate.replace(/-/g, ""));
    }
  }

  const identity = `<div class="chart-identity">
    <div class="chart-name-line"><h1 class="chart-name">${esc(name)}</h1><span class="chart-code">${esc(code)} · ${exchange(stock.code, stock.kind)}</span></div>
    <div class="chart-meta">
      <span>${PERIOD_LABEL[state.chartPeriod]}</span><span class="sep"></span>
      <span>${stock.kind === "index" ? "指数" : "前复权"}</span><span class="sep"></span>
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

  return `<button class="back-btn" data-action="chart-back" title="返回" aria-label="返回">${icon("arrowLeft", 16)}</button>
    ${identity}
    ${quote}
    <div class="chart-head-spacer"></div>
    ${stock.kind === "stock" ? `<div class="chart-switch" title="在当前列表 / 自选分组中直接切换">
      <button data-action="chart-prev" aria-label="上一只" ${switcher.list.length < 2 ? "disabled" : ""}>${icon("chevronLeft", 13)}</button>
      <span>${switcher.index >= 0 ? switcher.index + 1 : "—"}<i>/</i>${switcher.list.length || "—"}</span>
      <button data-action="chart-next" aria-label="下一只" ${switcher.list.length < 2 ? "disabled" : ""}>${icon("chevronRight", 13)}</button>
    </div>` : ""}
    ${stock.kind === "stock" ? `<button class="chart-watch-add" data-action="watch-add-current">${icon("wallet", 13)} 加自选</button>` : ""}
    ${snapshots}`;
}

export function renderChartToolbar(): string {
  const prefs = state.chartPrefs;
  return `<div class="seg chart-periods" role="group" aria-label="K线周期">
      ${PERIODS.map((p) => `<button class="${state.chartPeriod === p.value ? "active" : ""}" data-chart-period="${p.value}">${p.label}</button>`).join("")}
    </div>
    <div class="seg" role="group" aria-label="显示区间">
      ${RANGES.map((r) => `<button class="${state.chartRange === r.value ? "active" : ""}" data-chart-range="${r.value}">${state.chartPeriod.endsWith("m") ? (r.value ? `${r.value}根` : "全部") : r.label}</button>`).join("")}
    </div>
    <span class="toolbar-divider"></span>
    <button class="chip ${prefs.maEnabled ? "active" : ""}" data-indicator="ma" aria-pressed="${prefs.maEnabled}">MA</button>
    <button class="chip ${prefs.emaEnabled ? "active" : ""}" data-indicator="ema" aria-pressed="${prefs.emaEnabled}">EMA</button>
    <button class="chip ${prefs.kdjEnabled ? "active" : ""}" data-indicator="kdj" aria-pressed="${prefs.kdjEnabled}">KDJ</button>
    <button class="chart-settings-btn" data-action="indicator-settings" title="指标参数">${icon("settings", 14)}<span>参数</span></button>
    <span class="toolbar-spacer"></span>
    <span class="chart-note">滚轮缩放 · 拖动平移 · 方向键查看</span>`;
}

export function renderChartSide(): string {
  const st = stats(state.chartData?.candles ?? []);
  const stockSel = state.chartStock;
  const limitUp = stockSel?.kind === "stock" ? findStock(stockSel.code) : undefined;
  const openStock = stockSel?.kind === "stock" ? state.day?.openLimit.find((s) => s.code === stockSel.code) : undefined;
  const downStock = stockSel?.kind === "stock" ? state.day?.limitDown.find((s) => s.code === stockSel.code) : undefined;
  const code = stockSel?.code ?? "";
  let archive = "";
  if (stockSel?.kind === "index") {
    archive = `<div class="archive"><div class="archive-tag">${icon("activity", 11)} 指数行情</div><div class="archive-empty">指数 K线不提供涨停档案。<br />可切换周期与 MA / EMA / KDJ 参数观察趋势。</div></div>`;
  } else if (limitUp) {
    archive = `<div class="archive">
      <div class="archive-tag">${icon("activity", 11)} 今日涨停 · ${esc(tierName(limitUp.streak))}</div>
      <div class="archive-name">${esc(limitUp.name)} <span style="font-family:var(--mono);font-size:8px;color:var(--faint)">${limitUp.code}</span></div>
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
  } else if (openStock) {
    archive = `<div class="archive">
      <div class="archive-tag">${icon("activity", 11)} 今日炸板 · 开板 ${openStock.openNum} 次</div>
      <div class="archive-name">${esc(openStock.name)} <span style="font-family:var(--mono);font-size:8px;color:var(--faint)">${openStock.code}</span></div>
      <div class="archive-reason">盘中触及涨停后打开</div>
      <div class="archive-rows">
        <div class="archive-row"><label>首次触板</label><span>${fmtClock(openStock.firstSeal)}</span></div>
        <div class="archive-row"><label>末次封板</label><span>${fmtClock(openStock.lastSeal)}</span></div>
        <div class="archive-row"><label>收盘涨幅</label><span class="text-${tone(openStock.changeRate)}">${fmtPct(openStock.changeRate)}</span></div>
        <div class="archive-row"><label>开板次数</label><span>${openStock.openNum} 次</span></div>
        <div class="archive-row"><label>换手率</label><span>${openStock.turnoverRate.toFixed(2)}%</span></div>
        <div class="archive-row"><label>流通市值</label><span>${fmtMoney(openStock.floatCap)}</span></div>
      </div>
    </div>`;
  } else if (downStock) {
    archive = `<div class="archive">
      <div class="archive-tag">${icon("activity", 11)} 今日跌停</div>
      <div class="archive-name">${esc(downStock.name)} <span style="font-family:var(--mono);font-size:8px;color:var(--faint)">${downStock.code}</span></div>
      <div class="archive-reason">收盘封死跌停</div>
      <div class="archive-rows">
        <div class="archive-row"><label>收盘涨幅</label><span class="text-${tone(downStock.changeRate)}">${fmtPct(downStock.changeRate)}</span></div>
        <div class="archive-row"><label>换手率</label><span>${downStock.turnoverRate.toFixed(2)}%</span></div>
        <div class="archive-row"><label>流通市值</label><span>${fmtMoney(downStock.floatCap)}</span></div>
        <div class="archive-row"><label>市场</label><span>${downStock.market === "GEM" ? "创业板" : downStock.market === "STAR" ? "科创板" : "主板"}</span></div>
      </div>
    </div>`;
  } else if (stockSel) {
    archive = `<div class="archive"><div class="archive-tag">${icon("info", 11)} 涨停档案</div><div class="archive-empty">${esc(code)} 今日未进入涨停、炸板或跌停池。<br />上方 K 线仍可查看价格与指标。</div></div>`;
  }

  const perf = st
    ? `<div class="perf-grid">
        <div class="perf-item"><span class="perf-label">252日高</span><span class="perf-value">${fmtPrice(st.hi)}</span></div>
        <div class="perf-item"><span class="perf-label">252日低</span><span class="perf-value">${fmtPrice(st.lo)}</span></div>
        <div class="perf-item"><span class="perf-label">区间涨幅</span><span class="perf-value text-${tone(st.yearReturn)}">${fmtPct(st.yearReturn)}</span></div>
        <div class="perf-item"><span class="perf-label">近20日</span><span class="perf-value text-${tone(st.monthReturn)}">${fmtPct(st.monthReturn)}</span></div>
        <div class="perf-item"><span class="perf-label">20日均额</span><span class="perf-value">${fmtAmount(st.avgAmount)}</span></div>
        <div class="perf-item"><span class="perf-label">今日振幅</span><span class="perf-value">${st.amplitude.toFixed(2)}%</span></div>
      </div>`
    : `<div class="perf-grid">${Array.from({ length: 6 })
        .map(() => `<div class="perf-item"><span class="sk" style="width:38px;height:8px"></span><span class="sk" style="width:62px;height:14px;margin-top:4px"></span></div>`)
        .join("")}</div>`;

  return `<div class="side-head"><h3 class="side-title">区间</h3><span class="side-kicker">最近 250 个周期</span></div>
    ${perf}
    <div class="side-head" style="margin-top:22px"><h3 class="side-title">档案</h3><span class="side-kicker">当日盘口池</span></div>
    ${archive}
    <div class="indicator-note">
      <b>MA</b> 简单移动平均 · <b>EMA</b> 指数移动平均 · <b>KDJ</b> 随机指标。<br />
      进入「参数」可修改周期与 KDJ 系数。<br />
      指标仅辅助观察，不构成投资建议。
    </div>`;
}

export function renderWatchPanel(): string {
  const groups = state.watchGroups;
  const active = groups.find((g) => g.id === state.watchGroupId) ?? groups[0];
  const stocks = active?.stocks ?? [];
  const collapsed = state.watchCollapsed;
  const canAdd = state.chartStock?.kind === "stock";
  return `<section class="watch-panel ${collapsed ? "is-collapsed" : ""}">
    <div class="watch-head">
      <div class="watch-title"><span class="watch-mark"></span><h3>自选</h3><span class="watch-count">${stocks.length} 只</span></div>
      <div class="watch-groups">
        ${groups
          .map(
            (g) => `<button class="watch-group ${g.id === active?.id ? "active" : ""}" data-watch-group="${g.id}">${esc(g.name)}<i>${g.stocks.length}</i></button>`,
          )
          .join("")}
        <button class="watch-group-add" data-action="watch-create-group" title="新建分组">${icon("plus", 13)}</button>
      </div>
      <div class="watch-actions">
        ${active ? `<button class="watch-mini" data-action="watch-rename" title="重命名分组">${icon("edit", 13)}</button><button class="watch-mini danger" data-action="watch-delete" title="删除分组">${icon("trash", 13)}</button>` : ""}
        ${canAdd ? `<button class="watch-add-current" data-action="watch-add-current">${icon("plus", 12)} 加入当前</button>` : ""}
        <button class="watch-mini" data-action="watch-toggle" title="${collapsed ? "展开自选" : "收起自选"}">${icon(collapsed ? "chevronDown" : "chevronUp", 13)}</button>
      </div>
    </div>
    ${
      collapsed
        ? ""
        : `<div class="watch-body">
          ${
            !active
              ? `<div class="watch-empty">还没有分组，先新建一个分组。</div>`
              : !stocks.length
                ? `<div class="watch-empty">「${esc(active.name)}」还是空的。${canAdd ? "点「加入当前」或到涨停池批量添加。" : "到涨停池批量添加。"}</div>`
                : `<div class="watch-stocks">${stocks
                    .map(
                      (s) => `<button class="watch-stock" data-stock-code="${s.code}" data-stock-name="${esc(s.name)}" data-watch-code="${s.code}" data-watch-group="${active.id}" title="右键分配到其他分组">
                        <span class="watch-stock-name">${esc(s.name)}</span>
                        <span class="watch-stock-code">${s.code}</span>
                      </button>`,
                    )
                    .join("")}</div>`
          }
        </div>`
    }
  </section>`;
}
