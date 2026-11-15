import { esc, fmtClock, fmtMoney, fmtPct, fmtPrice, icon, tierName, tone } from "../lib/ui";
import { filterStocks, state } from "../lib/state";
import { emptyState, renderViewHead } from "./common";

const FILTERS: Array<{ key: typeof state.poolFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "streak", label: "连板" },
  { key: "first", label: "首板" },
  { key: "oneWord", label: "一字" },
  { key: "turnover", label: "换手" },
];

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

function renderRows(): string {
  const list = filterStocks();
  if (!list.length) {
    return `<tr><td colspan="8"><div class="empty-table"><div class="empty-title">没有符合条件的股票</div>调整筛选条件，或切换交易日。</div></td></tr>`;
  }
  const maxStreak = state.day?.stats.maxStreak ?? 0;
  return list
    .map((s) => {
      const high = s.streak >= 2;
      const isTop = high && s.streak === maxStreak;
      const height = high
        ? `<span class="pool-height high"><b>${s.streak}</b><span>板</span></span>${isTop ? `<span class="row-top-mark">最高</span>` : ""}`
        : `<span class="pool-height"><b style="font-family:var(--serif);font-size:15px;letter-spacing:.04em">首</b><span>板</span></span>`;
      const heightNote = s.highDays && s.highDays.includes("天") ? s.highDays : "";
      return `<tr class="${isTop ? "is-top" : ""}" data-stock-code="${s.code}" data-stock-name="${esc(s.name)}" tabindex="0" aria-label="查看 ${esc(s.name)} K线">
        <td class="stock-cell"><div class="pool-stock"><span class="pool-stock-name">${esc(s.name)}</span><span class="pool-stock-code">${s.code}</span></div></td>
        <td>${height}${heightNote ? `<span class="pool-height-note">${esc(heightNote)}</span>` : ""}</td>
        <td class="num"><span class="pool-price">${fmtPrice(s.price)}</span><br /><span class="pool-pct text-${tone(s.changeRate)}">${fmtPct(s.changeRate)}</span></td>
        <td class="num"><span class="pool-muted" style="color:var(--brass)">${s.sealAmount > 0 ? fmtMoney(s.sealAmount) : "—"}</span></td>
        <td class="num"><span class="pool-muted">${fmtClock(s.firstSeal)}</span>${s.openNum > 0 ? `<span class="pool-height-note">开板 ${s.openNum} 次</span>` : ""}</td>
        <td class="num"><span class="pool-muted">${s.turnoverRate.toFixed(1)}%</span><span class="pool-height-note">${fmtMoney(s.amount)}</span></td>
        <td><div class="pool-reason">${s.reasonTags.slice(0, 3).map((t) => `<span class="reason-tag">${esc(t)}</span>`).join("") || `<span class="pool-muted">—</span>`}</div></td>
        <td><span class="pool-sector" title="${esc(s.primarySector || "")}">${esc(s.primarySector || "—")}</span></td>
      </tr>`;
    })
    .join("");
}

export function renderPool(): string {
  const day = state.day;
  const loading = state.dayLoading && !day;
  const count = countFor(state.poolFilter);
  const sectors = day?.sectors ?? [];
  const selectedSector = state.poolSector;
  const selectedLabel = selectedSector ? sectors.find((s) => s.code === selectedSector)?.name ?? "" : "";

  return `<section class="view view-pool">
    ${renderViewHead()}
    <div class="pool-toolbar">
      <div class="pool-title"><h2>涨停池</h2><span>${day ? `${String(day.stocks.length).padStart(2, "0")} 只` : "—"}</span></div>
      ${FILTERS.map((f) => `<button class="chip ${state.poolFilter === f.key ? "active" : ""}" data-action="pool-filter" data-value="${f.key}">${f.label}<span class="count">${countFor(f.key)}</span></button>`).join("")}
      <span class="toolbar-spacer"></span>
      <div class="select-wrap">
        <select class="select" data-pool-sector aria-label="按板块筛选" title="按板块筛选">
          <option value="">全部板块</option>
          ${sectors
            .map((s) => `<option value="${s.code}" ${selectedSector === s.code ? "selected" : ""}>${esc(s.name)} · ${s.limitUpNum}</option>`)
            .join("")}
        </select>
        ${icon("chevronDown", 13)}
      </div>
      <label class="pool-search">${icon("search", 13)}<input type="text" data-pool-search placeholder="筛选名称 / 题材" value="${esc(state.poolQuery)}" autocomplete="off" spellcheck="false" /></label>
    </div>
    ${selectedLabel ? `<div class="pool-active-filter"><span>板块</span><b>${esc(selectedLabel)}</b><button data-action="pool-clear-sector" aria-label="清除板块筛选">${icon("close", 11)}</button></div>` : ""}
    <div class="pool-body" id="pool-body">
      <table class="pool-table">
        <colgroup>
          <col style="width:20%" />
          <col style="width:8%" />
          <col style="width:9%" />
          <col style="width:8%" />
          <col style="width:8%" />
          <col style="width:9%" />
          <col style="width:29%" />
          <col style="width:9%" />
        </colgroup>
        <thead>
          <tr>
            <th class="${state.poolSort.key === "name" ? "sortable" : "sortable"}" data-sort="name">股票${sortMark("name")}</th>
            <th class="sortable" data-sort="streak">高度${sortMark("streak")}</th>
            <th class="num sortable" data-sort="changeRate">现价 / 涨幅${sortMark("changeRate")}</th>
            <th class="num sortable" data-sort="sealAmount">封单${sortMark("sealAmount")}</th>
            <th class="num sortable" data-sort="firstSeal">首封${sortMark("firstSeal")}</th>
            <th class="num sortable" data-sort="turnoverRate">换手 / 成交${sortMark("turnoverRate")}</th>
            <th>涨停题材</th>
            <th>主线</th>
          </tr>
        </thead>
        <tbody>
          ${loading ? tableSkeleton() : day ? renderRows() : `<tr><td colspan="8">${emptyState("没有涨停数据", state.error || "换一个交易日，或重新加载。", "retry-day", "重新加载")}</td></tr>`}
        </tbody>
      </table>
    </div>
  </section>`;
}

export function updatePoolTable(): void {
  const body = document.querySelector<HTMLElement>("#pool-body tbody");
  if (!body) return;
  body.innerHTML = renderRows();
  const countEl = document.querySelector<HTMLElement>(".pool-title span");
  if (countEl) countEl.textContent = state.day ? `${String(filterStocks().length).padStart(2, "0")} / ${String(state.day.stocks.length).padStart(2, "0")}` : "—";
}
