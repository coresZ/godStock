import { esc, fmtClock, fmtMoney, fmtPct, fmtPrice, icon, tone } from "../lib/ui";
import { breakInfo, downInfo } from "../lib/market";
import { filterStocks, poolStocks, state } from "../lib/state";
import type { PoolKind, Stock } from "../lib/types";
import { emptyState, renderViewHead } from "./common";

const FILTERS: Array<{ key: typeof state.poolFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "streak", label: "连板" },
  { key: "first", label: "首板" },
  { key: "oneWord", label: "一字" },
  { key: "turnover", label: "换手" },
];

const KINDS: Array<{ key: PoolKind; label: string }> = [
  { key: "limitUp", label: "涨停" },
  { key: "openLimit", label: "炸板" },
  { key: "limitDown", label: "跌停" },
];

function kindCount(kind: PoolKind): number {
  if (!state.day) return 0;
  if (kind === "openLimit") return state.day.openLimit.length;
  if (kind === "limitDown") return state.day.limitDown.length;
  return state.day.stocks.length;
}

function countFor(key: typeof state.poolFilter): number {
  const stocks = state.day?.stocks ?? [];
  if (key === "streak") return stocks.filter((s) => s.streak >= 2).length;
  if (key === "first") return stocks.filter((s) => s.streak <= 1).length;
  if (key === "oneWord") return stocks.filter((s) => s.limitType.includes("一字")).length;
  if (key === "turnover") return stocks.filter((s) => s.limitType.includes("换手")).length;
  return stocks.length;
}

function sortMark(key: string): string {
  if (state.poolSort.key !== key) return "";
  const asc = state.poolSort.dir === 1;
  return `<span class="sort-mark ${asc ? "asc" : ""}">${icon("chevronDown", 11)}</span>`;
}

function tableSkeleton(): string {
  return Array.from({ length: 9 })
    .map(
      () => `<tr class="skeleton-row">
      <td><div class="sk" style="width:110px;height:22px"></div></td>
      <td><div class="sk" style="width:30px;height:20px"></div></td>
      <td><div class="sk" style="width:64px;height:20px"></div></td>
      <td><div class="sk" style="width:50px;height:14px"></div></td>
      <td><div class="sk" style="width:40px;height:14px"></div></td>
      <td><div class="sk" style="width:60px;height:14px"></div></td>
      <td><div class="sk" style="width:85%;height:14px"></div></td>
      <td><div class="sk" style="width:50px;height:14px"></div></td>
    </tr>`,
    )
    .join("");
}

function reasonCell(s: Stock): string {
  if (state.poolKind === "openLimit") {
    return `<span class="pool-muted">${s.openNum > 0 ? `盘中触板后开板${s.openNum > 1 ? ` ${s.openNum} 次` : ""}` : "盘中触板，未能封住"}</span>`;
  }
  if (state.poolKind === "limitDown") {
    return `<span class="pool-muted">跌停 · ${s.market === "GEM" ? "创业板" : s.market === "STAR" ? "科创板" : "主板"}</span>`;
  }
  return s.reasonTags.slice(0, 3).map((t) => `<span class="reason-tag">${esc(t)}</span>`).join("") || `<span class="pool-muted">—</span>`;
}

function openNote(s: Stock): string {
  return s.openNum > 0 ? `开板 ${s.openNum} 次` : "触板未封";
}

function heightCell(s: Stock, isTop: boolean): string {
  if (state.poolKind === "openLimit") {
    return `<span class="pool-kind-mark break">炸板</span><span class="pool-height-note">${openNote(s)}</span>`;
  }
  if (state.poolKind === "limitDown") {
    return `<span class="pool-kind-mark fall">跌停</span><span class="pool-height-note">${s.market === "GEM" ? "20cm" : "10cm"}</span>`;
  }
  const high = s.streak >= 2;
  const height = high
    ? `<span class="pool-height high"><b>${s.streak}</b><span>板</span></span>${isTop ? `<span class="row-top-mark">最高</span>` : ""}`
    : `<span class="pool-height"><b style="font-family:var(--serif);font-size:15px;letter-spacing:.04em">首</b><span>板</span></span>`;
  const heightNote = s.highDays && s.highDays.includes("天") ? s.highDays : "";
  return `${height}${heightNote ? `<span class="pool-height-note">${esc(heightNote)}</span>` : ""}`;
}

function statusCell(s: Stock): string {
  if (state.poolKind === "openLimit") {
    return `<span class="pool-muted" style="color:var(--brass)">${openNote(s)}</span>`;
  }
  if (state.poolKind === "limitDown") {
    return `<span class="pool-muted text-down">跌停</span>`;
  }
  return `<span class="pool-muted" style="color:var(--brass)">${s.sealAmount > 0 ? fmtMoney(s.sealAmount) : "—"}</span>`;
}

function marketText(s: Stock): string {
  if (s.market === "GEM") return "创业板";
  if (s.market === "STAR") return "科创板";
  return "主板";
}

function timeCell(s: Stock): string {
  if (state.poolKind === "openLimit") {
    const b = breakInfo(s);
    return `<span class="pool-muted">${fmtClock(s.lastSeal)}</span>${b ? `<span class="pool-height-note" title="由分时采样推断">~${b.clock} 炸板</span>` : ""}`;
  }
  if (state.poolKind === "limitDown") {
    const d = downInfo(s);
    return d ? `<span class="pool-muted" title="由分时采样推断">~${d.clock}</span>` : `<span class="pool-muted">—</span>`;
  }
  return `<span class="pool-muted">${fmtClock(s.firstSeal)}</span>${s.openNum > 0 ? `<span class="pool-height-note">开板 ${s.openNum} 次</span>` : ""}`;
}

function renderRows(): string {
  const list = filterStocks();
  if (!list.length) {
    return `<tr><td colspan="8"><div class="empty-table"><div class="empty-title">没有符合条件的股票</div>调整筛选条件，或切换交易日。</div></td></tr>`;
  }
  const maxStreak = state.day?.stats.maxStreak ?? 0;
  return list
    .map((s) => {
      const isTop = state.poolKind === "limitUp" && s.streak >= 2 && s.streak === maxStreak;
      return `<tr class="${isTop ? "is-top" : ""}" data-stock-code="${s.code}" data-stock-name="${esc(s.name)}" tabindex="0" aria-label="查看 ${esc(s.name)} K线">
        <td class="stock-cell"><div class="pool-stock"><span class="pool-stock-name">${esc(s.name)}</span><span class="pool-stock-code">${s.code}</span></div></td>
        <td>${heightCell(s, isTop)}</td>
        <td class="num"><span class="pool-price">${fmtPrice(s.price)}</span><br /><span class="pool-pct text-${tone(s.changeRate)}">${fmtPct(s.changeRate)}</span></td>
        <td class="num">${statusCell(s)}</td>
        <td class="num">${timeCell(s)}</td>
        <td class="num"><span class="pool-muted">${s.turnoverRate.toFixed(1)}%</span><span class="pool-height-note">${state.poolKind === "limitUp" ? fmtMoney(s.amount) : `流通 ${fmtMoney(s.floatCap)}`}</span></td>
        <td><div class="pool-reason">${reasonCell(s)}</div></td>
        <td><span class="pool-sector" title="${esc(s.primarySector || marketText(s))}">${esc(state.poolKind === "limitUp" ? s.primarySector || "—" : marketText(s))}</span></td>
      </tr>`;
    })
    .join("");
}

function tableHead(): string {
  const first = state.poolKind === "limitUp" ? "高度" : "类型";
  const fourth = state.poolKind === "limitUp" ? "封单" : state.poolKind === "openLimit" ? "开板" : "状态";
  const fifth = state.poolKind === "limitUp" ? "首封" : state.poolKind === "openLimit" ? "末封" : "跌停时间";
  const seventh = state.poolKind === "limitUp" ? "涨停题材" : "盘面";
  const eighth = state.poolKind === "limitUp" ? "主线" : "市场";
  const secondTh =
    state.poolKind === "limitUp"
      ? `<th class="sortable" data-sort="streak">${first}${sortMark("streak")}</th>`
      : `<th>${first}</th>`;
  const fourthTh =
    state.poolKind === "limitUp"
      ? `<th class="num sortable" data-sort="sealAmount">${fourth}${sortMark("sealAmount")}</th>`
      : state.poolKind === "openLimit"
        ? `<th class="num sortable" data-sort="openNum">${fourth}${sortMark("openNum")}</th>`
        : `<th class="num">${fourth}</th>`;
  const fifthTh =
    state.poolKind === "limitUp"
      ? `<th class="num sortable" data-sort="firstSeal">${fifth}${sortMark("firstSeal")}</th>`
      : state.poolKind === "openLimit"
        ? `<th class="num sortable" data-sort="lastSeal">${fifth}${sortMark("lastSeal")}</th>`
        : `<th class="num">${fifth}</th>`;
  return `<tr>
    <th class="sortable" data-sort="name">股票${sortMark("name")}</th>
    ${secondTh}
    <th class="num sortable" data-sort="changeRate">现价 / 涨幅${sortMark("changeRate")}</th>
    ${fourthTh}
    ${fifthTh}
    <th class="num sortable" data-sort="turnoverRate">换手 / ${state.poolKind === "limitUp" ? "成交" : "流通"}${sortMark("turnoverRate")}</th>
    <th>${seventh}</th>
    <th>${eighth}</th>
  </tr>`;
}

function sectorDropdown(): string {
  const sectors = state.day?.sectors ?? [];
  const selected = sectors.find((s) => s.code === state.poolSector);
  return `<div class="dd sector-dd">
    <button type="button" class="dd-trigger" data-dd-trigger data-dd-kind="sector" data-dd-menu="196" data-value="${state.poolSector}" aria-haspopup="listbox" aria-expanded="false">
      <span class="dd-label">${selected ? esc(selected.name) : "全部板块"}</span>
      ${icon("chevronDown", 12)}
    </button>
    <div class="dd-options" hidden>
      <button type="button" data-value="">全部板块</button>
      ${sectors.map((s) => `<button type="button" data-value="${s.code}">${esc(s.name)} · ${s.limitUpNum}</button>`).join("")}
    </div>
  </div>`;
}

function renderToolbar(): string {
  return `<div class="pool-toolbar">
    <div class="pool-title"><h2>盘口池</h2><span>${state.day ? String(filterStocks().length).padStart(2, "0") : "—"}</span></div>
    <div class="seg pool-kinds" role="group" aria-label="股票池">
      ${KINDS.map((k) => `<button class="${state.poolKind === k.key ? "active" : ""}" data-pool-kind="${k.key}">${k.label}<i>${kindCount(k.key)}</i></button>`).join("")}
    </div>
    <span class="pool-divider"></span>
    ${state.poolKind === "limitUp" ? FILTERS.map((f) => `<button class="chip ${state.poolFilter === f.key ? "active" : ""}" data-action="pool-filter" data-value="${f.key}">${f.label}<span class="count">${countFor(f.key)}</span></button>`).join("") : ""}
    <span class="toolbar-spacer"></span>
    ${state.poolKind === "limitUp" ? sectorDropdown() : ""}
    <button class="chip watch-batch" data-action="batch-watch">${icon("wallet", 13)} 批量自选<span class="count">${filterStocks().length}</span></button>
    <label class="pool-search">${icon("search", 13)}<input type="text" data-pool-search placeholder="筛选名称 / 题材" value="${esc(state.poolQuery)}" autocomplete="off" spellcheck="false" /></label>
  </div>
  ${state.poolKind !== "limitUp" ? `<div class="pool-kind-note">${state.poolKind === "openLimit" ? "炸板池 · 盘中触及涨停后打开；炸板时间为分时采样推断。" : "跌停池 · 当日收盘封死跌停；跌停时间为分时采样推断。"}</div>` : ""}`;
}

export function renderPoolStage(): string {
  const day = state.day;
  const loading = state.dayLoading && !day;
  const selectedLabel = state.poolSector && state.poolKind === "limitUp" ? day?.sectors.find((s) => s.code === state.poolSector)?.name ?? "" : "";
  return `${renderToolbar()}
    ${selectedLabel ? `<div class="pool-active-filter"><span>板块</span><b>${esc(selectedLabel)}</b><button data-action="pool-clear-sector" aria-label="清除板块筛选">${icon("close", 11)}</button></div>` : ""}
    <div class="pool-body" id="pool-body">
      <table class="pool-table">
        <colgroup>
          <col style="width:20%" />
          <col style="width:8%" />
          <col style="width:9%" />
          <col style="width:8%" />
          <col style="width:9%" />
          <col style="width:9%" />
          <col style="width:28%" />
          <col style="width:9%" />
        </colgroup>
        <thead>${tableHead()}</thead>
        <tbody>
          ${loading ? tableSkeleton() : day ? renderRows() : `<tr><td colspan="8">${emptyState("没有盘口数据", state.error || "换一个交易日，或重新加载。", "retry-day", "重新加载")}</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

export function renderPool(): string {
  return `<section class="view view-pool">
    ${renderViewHead()}
    <div id="pool-stage">${renderPoolStage()}</div>
  </section>`;
}

export function updatePoolStage(): void {
  const old = document.getElementById("pool-stage");
  if (!old) return;
  const top = old.querySelector<HTMLElement>(".pool-body")?.scrollTop ?? 0;
  const stage = document.createElement("div");
  stage.id = "pool-stage";
  stage.innerHTML = renderPoolStage();
  old.replaceWith(stage);
  const scroller = stage.querySelector<HTMLElement>(".pool-body");
  if (scroller) scroller.scrollTop = top;
}

export function updatePoolTable(): void {
  const body = document.querySelector<HTMLElement>("#pool-body tbody");
  if (body) body.innerHTML = renderRows();
  const count = filterStocks().length;
  const countEl = document.querySelector<HTMLElement>(".pool-title span");
  if (countEl) countEl.textContent = state.day ? String(count).padStart(2, "0") : "—";
  const batchCount = document.querySelector<HTMLElement>(".watch-batch .count");
  if (batchCount) batchCount.textContent = String(count);
}
