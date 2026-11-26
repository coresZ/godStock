import { state } from "../lib/state";
import type {
  IwcPlate,
  IwcStock,
  LhbAgency,
  LhbDetail,
  LhbHotMoneyTag,
  LhbInstitution,
  LhbSeat,
  LhbSeatTrade,
  LhbStock,
  OtherModule,
  OtherTab,
} from "../lib/types";
import {
  esc,
  fmtDotDate,
  fmtPct,
  icon,
  marketLabel,
  pctToneClass,
  relTime,
  weekdayFromYmd,
} from "../lib/ui";
import { renderViewHead } from "./common";
import { iwcPctClass, iwcPctText, iwcSortedStocks, iwcSortLabel } from "../lib/iwc";

/* 其他 · 游资动态：龙虎榜上榜个股、游资名号聚合、机构净买入、营业部席位。
   只做渲染与 data-* 标记，数据加载与动作分发给 main.ts。 */

/* ————————————————— meta ————————————————— */

const TABS: Array<{ key: OtherTab; label: string; hint: string }> = [
  { key: "board", label: "总榜", hint: "当日全部上榜个股与买卖席位" },
  { key: "yyz", label: "游资", hint: "按游资名号聚合的上榜席位" },
  { key: "org", label: "机构", hint: "机构专用席位净买入榜" },
  { key: "agency", label: "席位", hint: "营业部当日净额排行" },
];

const BOARD_SORT: Array<{ key: "net" | "pct" | "seats"; label: string }> = [
  { key: "net", label: "净额" },
  { key: "pct", label: "涨幅" },
  { key: "seats", label: "席位" },
];

const FOOT =
  "数据来源：公开龙虎榜接口，连板与板块由东财涨停池补充；盘后陆续更新，未发布时自动回退到最近交易日。同一席位命中多个游资名号会分别计入游资榜。仅作复盘用途，不构成投资建议。";

/** 同花顺自选模块的只读语义：登录态与数据都只在本机，绝不回写问财。 */
const IWC_FOOT =
  "数据来源：登录同花顺 / 问财后只读拉取你自己账号下的自选板块与自选股。登录态只保存在本机，不保存账号密码；同步只读，不回写问财、不修改网站上的自选。导入仅把成分股 / 自选股复制到本地自选分组，可随时删除。仅作复盘用途，不构成投资建议。";

/** 游资等级由接口 YouZiIcon 单独渲染，名号库里同名的标签不再重复展示。 */
const LEVEL_TAGS = new Set(["一线游资", "顶级游资", "知名游资"]);

/* ————————————————— small helpers ————————————————— */

function amount(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
  return `${Math.round(v)}`;
}

function signedAmount(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "—";
  return `${v > 0 ? "+" : ""}${amount(v)}`;
}

function moneyCell(v: number): string {
  const cls = pctToneClass(v);
  return `<span class="oh-money ${cls}">${signedAmount(v)}</span>`;
}

function pctCell(v: number): string {
  return `<span class="oh-pct ${pctToneClass(v)}">${fmtPct(v)}</span>`;
}

function compactDate(ymd: string): string {
  if (!ymd || ymd.length !== 8) return ymd || "—";
  return `${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

function dateWithWeekday(ymd: string): string {
  if (!ymd || ymd.length !== 8) return ymd || "—";
  return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)} ${weekdayFromYmd(ymd)}`;
}

function tagClass(tag: string): string {
  if (tag === "机构专用") return "is-org";
  return "is-hot";
}

function seatTagChips(seat: LhbSeat): string {
  const chips: string[] = [];
  const tags = seat.tags.filter((tag) => !LEVEL_TAGS.has(tag) && tag !== seat.name);
  for (const tag of tags.slice(0, 3)) {
    chips.push(`<i class="oh-tag ${tagClass(tag)}">${esc(tag)}</i>`);
  }
  if (tags.length > 3) chips.push(`<i class="oh-tag">+${tags.length - 3}</i>`);
  const level = seat.level === 1 ? "一线游资" : seat.level === 2 ? "顶级游资" : seat.level === 3 ? "知名游资" : "";
  if (level) chips.push(`<i class="oh-tag is-level">${level}</i>`);
  if (seat.assoc) chips.push(`<i class="oh-tag is-assoc">关联</i>`);
  if (seat.ydayBuy > 0) chips.push(`<i class="oh-tag is-yday">昨买${seat.ydayBuy}</i>`);
  if (seat.ydaySell > 0) chips.push(`<i class="oh-tag is-yday">昨卖${seat.ydaySell}</i>`);
  return chips.length ? `<span class="oh-seat-tags">${chips.join("")}</span>` : "";
}

function nameTagsChips(tags: string[]): string {
  const visible = tags.filter((tag) => !LEVEL_TAGS.has(tag));
  if (!visible.length) return "";
  return `<span class="oh-seat-tags">${visible.slice(0, 2).map((tag) => `<i class="oh-tag ${tagClass(tag)}">${esc(tag)}</i>`).join("")}${visible.length > 2 ? `<i class="oh-tag">+${visible.length - 2}</i>` : ""}</span>`;
}

function sumNet(rows: Array<{ netBuy: number }>): number {
  return rows.reduce((acc, row) => acc + (Number.isFinite(row.netBuy) ? row.netBuy : 0), 0);
}

/** 按当前排序规则排好的总榜，供列表与默认选中复用。 */
export function sortedLhbBoard(): LhbStock[] {
  return boardRows();
}

function boardRows(): LhbStock[] {
  const rows = state.lhbBoard?.rows ?? [];
  const { key, dir } = state.lhbSort;
  return [...rows].sort((a, b) => {
    const av = key === "pct" ? a.pct : key === "seats" ? a.seats : a.netBuy;
    const bv = key === "pct" ? b.pct : key === "seats" ? b.seats : b.netBuy;
    if (av !== bv) return (av - bv) * dir;
    return b.netBuy - a.netBuy;
  });
}

function selectedStock(): LhbStock | undefined {
  return (state.lhbBoard?.rows ?? []).find((row) => row.code === state.lhbStock);
}

function selectedOrg(): LhbInstitution | undefined {
  return (state.lhbInstitutions?.rows ?? []).find((row) => row.code === state.lhbStock);
}

function selectedTag(): LhbHotMoneyTag | undefined {
  return state.lhbAgencies?.hot.find((item) => item.tag === state.lhbTag);
}

function selectedAgency(): LhbAgency | undefined {
  return state.lhbAgencies?.rows.find((item) => item.id === state.lhbAgencyId);
}

/* ————————————————— module switch ————————————————— */

const MODULES: Array<{ key: OtherModule; label: string; hint: string }> = [
  { key: "lhb", label: "游资动态", hint: "龙虎榜上榜个股 · 游资席位 · 机构动向" },
  { key: "iwc", label: "同花顺自选", hint: "登录同花顺 / 问财后只读同步自己的自选板块与自选股" },
];

function renderModuleSwitch(): string {
  const active = MODULES.find((item) => item.key === state.otherModule) ?? MODULES[0];
  return `<div class="oh-module-switch">
    <div class="seg oh-modules" role="tablist" aria-label="其他页模块">
      ${MODULES.map(
        (item) => `<button role="tab" aria-selected="${item.key === state.otherModule}" class="${item.key === state.otherModule ? "active" : ""}" data-other-module="${item.key}" title="${item.hint}">${item.label}</button>`,
      ).join("")}
    </div>
    <span class="oh-module-hint">${active.hint}</span>
    ${state.otherModule === "iwc" ? `<span class="oh-module-badge">${icon("eye", 11)}<span>只读同步</span></span>` : ""}
  </div>`;
}

/* ————————————————— shell ————————————————— */

export function renderOther(): string {
  return `<section class="view view-other">
    ${renderViewHead()}
    <div id="other-stage">${renderOtherStage()}</div>
  </section>`;
}

export function renderOtherStage(): string {
  const isIwc = state.otherModule === "iwc";
  return `<div class="oh-scroll" data-stage-module="${state.otherModule}">
    ${renderModuleSwitch()}
    ${isIwc ? renderIwcStage() : renderLhbStage()}
  </div>
  <div class="oh-foot"><span>${icon("info", 12)}</span><span>${isIwc ? IWC_FOOT : FOOT}</span></div>`;
}

/** 游资动态模块：保持原有三块骨架不加改动。 */
function renderLhbStage(): string {
  return `${renderBar()}
  ${renderTabsRow()}
  <div class="oh-workbench">${renderListColumn()}${renderPanelColumn()}</div>`;
}

/** 供 main.ts 局部刷新：保留滚动位置（整页 / 左列 / 右面板），并兼容两个模块。 */
export function updateOtherStage(): void {
  const old = document.getElementById("other-stage");
  if (!old) return;
  const oldModule = old.querySelector<HTMLElement>(".oh-scroll")?.dataset.stageModule ?? "";
  const sameModule = oldModule === state.otherModule;
  const listTop = sameModule ? old.querySelector<HTMLElement>(".oh-list-body")?.scrollTop ?? 0 : 0;
  const panelTop = sameModule ? old.querySelector<HTMLElement>(".oh-panel-body")?.scrollTop ?? 0 : 0;
  const next = document.createElement("div");
  next.id = "other-stage";
  next.innerHTML = renderOtherStage();
  old.replaceWith(next);
  if (!sameModule) return;
  const list = next.querySelector<HTMLElement>(".oh-list-body");
  if (list) list.scrollTop = listTop;
  const panel = next.querySelector<HTMLElement>(".oh-panel-body");
  if (panel) panel.scrollTop = panelTop;
}

/* ————————————————— head ————————————————— */

function renderBar(): string {
  const board = state.lhbBoard;
  const agencies = state.lhbAgencies;
  const orgs = state.lhbInstitutions;
  const hotRows = (agencies?.rows ?? []).filter((row) => row.tags.some((tag) => !LEVEL_TAGS.has(tag) && tag !== "机构专用"));
  const hotNet = hotRows.reduce((acc, row) => acc + row.net, 0);
  const orgNet = (orgs?.rows ?? []).reduce((acc, row) => acc + row.netBuy, 0);
  const total = board?.rows.length ?? 0;
  const loading = state.lhbLoading && !board;
  const busySecondary = state.lhbLoading || state.lhbSecondaryLoading;
  const pendingAgencies = !agencies && !loading;
  const pendingOrgs = !orgs && !loading;

  const syncText = board
    ? `${fmtDotDate(board.date)} ${board.source === "cache" ? "缓存" : "接口"} · ${relTime(board.fetchedAt)}`
    : "等待数据";

  const metric = (label: string, value: string, unit: string, tone: string, pending = false) => `<div class="oh-metric">
      <span>${label}</span>
      <span class="oh-metric-value"><b class="${pending ? "is-pending" : tone}">${value}</b>${unit ? `<em>${unit}</em>` : ""}</span>
    </div>`;

  const hotValue = pendingAgencies ? (busySecondary ? "读取中" : "—") : signedAmount(hotNet);
  const hotUnit = pendingAgencies ? "" : `${hotRows.length} 家`;
  const orgValue = pendingOrgs ? (busySecondary ? "读取中" : "—") : signedAmount(orgNet);

  return `<div class="oh-bar">
    <div class="oh-bar-copy">
      <h2>游资动态</h2>
      <p><span class="oh-kicker">其他</span>龙虎榜上榜个股 · 游资席位 · 机构动向</p>
    </div>
    <div class="oh-metrics">
      ${metric("上榜个股", loading ? "—" : String(total), loading ? "" : "只", "")}
      ${metric("龙虎榜净买入", loading ? "—" : signedAmount(sumNet(board?.rows ?? [])), "", pctToneClass(sumNet(board?.rows ?? [])))}
      ${metric("游资净买入", hotValue, hotUnit, pendingAgencies ? "" : pctToneClass(hotNet), pendingAgencies)}
      ${metric("机构净买入", orgValue, "", pendingOrgs ? "" : pctToneClass(orgNet), pendingOrgs)}
    </div>
    <div class="oh-bar-actions">
      <span class="oh-sync">${esc(syncText)}</span>
      <button class="chip oh-refresh ${state.lhbLoading ? "is-busy" : ""}" data-lhb-refresh title="重新拉取龙虎榜数据" aria-label="刷新龙虎榜数据">
        ${icon("refresh", 12)}<span>${state.lhbLoading ? "刷新中" : "刷新"}</span>
      </button>
    </div>
  </div>`;
}

function renderTabsRow(): string {
  const board = state.lhbBoard;
  const tab = state.otherTab;
  const active = TABS.find((item) => item.key === tab) ?? TABS[0];
  const dateChip = board
    ? board.fallback
      ? `<span class="oh-date-chip is-warn" title="请求日 ${fmtDotDate(board.requestedDate)} 暂无数据，已回退">${fmtDotDate(board.date)} · 回退</span>`
      : `<span class="oh-date-chip">${dateWithWeekday(board.date)}</span>`
    : "";
  return `<div class="oh-tabs-row">
    <div class="seg oh-tabs" role="tablist" aria-label="游资动态分组">
      ${TABS.map(
        (item) => `<button role="tab" aria-selected="${item.key === tab}" class="${item.key === tab ? "active" : ""}" data-other-tab="${item.key}" title="${item.hint}">${item.label}</button>`,
      ).join("")}
    </div>
    <span class="oh-tab-hint">${active.hint}</span>
    <div class="oh-tabs-meta">
      ${state.lhbExtraError ? `<button class="chip oh-retry" data-lhb-refresh title="重新读取席位榜与机构榜">${icon("refresh", 11)}<span>重试</span></button>` : ""}
      ${dateChip}
      <span>${board ? `${board.rows.length} 只上榜` : ""}</span>
    </div>
  </div>`;
}

/* ————————————————— list column ————————————————— */

function renderListColumn(): string {
  if (state.lhbError && !state.lhbBoard) {
    return `<div class="oh-col oh-list-col"><div class="oh-empty is-error">
      <b>龙虎榜数据未加载</b>
      <span>${esc(state.lhbError)}</span>
      <button class="chip" data-lhb-refresh>${icon("refresh", 12)}<span>重试</span></button>
    </div></div>`;
  }
  if (!state.lhbBoard) return `<div class="oh-col oh-list-col">${renderListSkeleton()}</div>`;
  if (!state.lhbBoard.rows.length) {
    return `<div class="oh-col oh-list-col"><div class="oh-empty">
      <b>该日期暂无龙虎榜数据</b>
      <span>${esc(state.lhbBoard.warning || "龙虎榜在盘后陆续更新；可用上方日期切换上一交易日后再看。")}</span>
      <button class="chip" data-lhb-refresh>${icon("refresh", 12)}<span>重新拉取</span></button>
    </div></div>`;
  }
  const head = renderListHead();
  const pending = secondaryPending();
  if (pending) return `<div class="oh-col oh-list-col">${pending}</div>`;
  const rows =
    state.otherTab === "yyz"
      ? renderYyzRows()
      : state.otherTab === "org"
        ? renderOrgRows()
        : state.otherTab === "agency"
          ? renderAgencyRows()
          : renderBoardRows();
  return `<div class="oh-col oh-list-col">
    ${head}
    <div class="oh-list-body">${rows}</div>
  </div>`;
}

/** 席位榜 / 机构榜尚未到手时的占位：读取中给骨架，失败给可重试空态。 */
function secondaryPending(): string | null {
  const needAgencies = state.otherTab === "yyz" || state.otherTab === "agency";
  const needOrgs = state.otherTab === "org";
  if (!needAgencies && !needOrgs) return null;
  const ready = needAgencies ? Boolean(state.lhbAgencies) : Boolean(state.lhbInstitutions);
  if (ready) return null;
  if (state.lhbSecondaryLoading || state.lhbLoading) return renderListSkeleton();
  const label = needAgencies ? "席位榜" : "机构榜";
  return `<div class="oh-empty">
      <b>${label}未加载</b>
      <span>${esc(state.lhbExtraError || "数据源暂时没有返回，可重试一次。")}</span>
      <button class="chip" data-lhb-refresh>${icon("refresh", 12)}<span>重试</span></button>
    </div>`;
}

function renderListHead(): string {
  if (state.otherTab === "board") {
    const { key, dir } = state.lhbSort;
    return `<div class="oh-col-head">
      <span class="oh-col-title">上榜个股<em>${state.lhbBoard?.rows.length ?? 0}</em></span>
      <div class="oh-sort">
        ${BOARD_SORT.map(
          (item) => `<button data-lhb-sort="${item.key}" class="${key === item.key ? "is-active" : ""}" title="按${item.label}排序">${item.label}${key === item.key ? `<i>${dir === -1 ? "↓" : "↑"}</i>` : ""}</button>`,
        ).join("")}
      </div>
    </div>`;
  }
  if (state.otherTab === "yyz") {
    return `<div class="oh-col-head">
      <span class="oh-col-title">游资名号<em>${state.lhbAgencies?.hot.length ?? 0}</em></span>
      <span class="oh-col-note">按净额排序</span>
    </div>`;
  }
  if (state.otherTab === "org") {
    return `<div class="oh-col-head">
      <span class="oh-col-title">机构净买入<em>${state.lhbInstitutions?.rows.length ?? 0}</em></span>
      <span class="oh-col-note">按净额排序</span>
    </div>`;
  }
  return `<div class="oh-col-head">
    <span class="oh-col-title">营业部<em>${state.lhbAgencies?.rows.length ?? 0}</em></span>
    <span class="oh-col-note">按净额排序</span>
  </div>`;
}

function renderBoardRows(): string {
  const rows = boardRows();
  if (!rows.length) return `<div class="oh-empty"><b>暂无上榜个股</b><span>换一个交易日再看。</span></div>`;
  return rows
    .map((row) => {
      const active = row.code === state.lhbStock ? " is-active" : "";
      return `<button class="oh-row${active}" data-lhb-stock="${esc(row.code)}" title="查看 ${esc(row.name)} 的买卖席位">
        <span class="oh-row-main">
          <span class="oh-row-name">${esc(row.name)}${row.board ? `<i class="oh-tag is-board">${esc(row.board)}</i>` : ""}</span>
          <span class="oh-row-sub"><span class="oh-code">${esc(row.code)}</span>${row.sector ? ` · ${esc(row.sector)}` : ""}${row.seats > 0 ? ` · 席位 ${row.seats}` : ""}</span>
        </span>
        <span class="oh-row-num">
          ${pctCell(row.pct)}
          <span class="oh-row-net">净额 ${moneyCell(row.netBuy)}</span>
        </span>
      </button>`;
    })
    .join("");
}

function renderYyzRows(): string {
  const rows = state.lhbAgencies?.hot ?? [];
  if (!rows.length) {
    return `<div class="oh-empty"><b>当日无游资名号上榜</b><span>${esc(state.lhbAgencies?.warning || "本地游资名号库未命中当日上榜席位，可切到「席位」看全部营业部。")}</span></div>`;
  }
  return rows
    .map((row) => {
      const active = row.tag === state.lhbTag ? " is-active" : "";
      return `<button class="oh-row${active}" data-lhb-tag="${esc(row.tag)}" title="查看 ${esc(row.tag)} 的上榜席位">
        <span class="oh-row-main">
          <span class="oh-row-name">${esc(row.tag)}<i class="oh-tag is-hot">${row.seats.length} 席</i></span>
          <span class="oh-row-sub">买入 ${amount(row.buy)} · 卖出 ${amount(row.sell)}</span>
        </span>
        <span class="oh-row-num">${moneyCell(row.net)}<span class="oh-row-net">净额</span></span>
      </button>`;
    })
    .join("");
}

function renderOrgRows(): string {
  const rows = state.lhbInstitutions?.rows ?? [];
  if (!rows.length) {
    return `<div class="oh-empty"><b>当日无机构上榜个股</b><span>${esc(state.lhbInstitutions?.warning || "机构专用席位没有出现在当日龙虎榜中。")}</span></div>`;
  }
  return rows
    .map((row) => {
      const active = row.code === state.lhbStock ? " is-active" : "";
      return `<button class="oh-row${active}" data-lhb-stock="${esc(row.code)}" title="查看 ${esc(row.name)} 的机构与营业部席位">
        <span class="oh-row-main">
          <span class="oh-row-name">${esc(row.name)}${row.board ? `<i class="oh-tag is-board">${esc(row.board)}</i>` : ""}</span>
          <span class="oh-row-sub"><span class="oh-code">${esc(row.code)}</span>${row.sector ? ` · ${esc(row.sector)}` : ""} · 机构 ${row.orgCount}</span>
        </span>
        <span class="oh-row-num">${pctCell(row.pct)}<span class="oh-row-net">净额 ${moneyCell(row.netBuy)}</span></span>
      </button>`;
    })
    .join("");
}

function renderAgencyRows(): string {
  const rows = state.lhbAgencies?.rows ?? [];
  if (!rows.length) return `<div class="oh-empty"><b>当日无营业部上榜</b><span>${esc(state.lhbAgencies?.warning || "换一个交易日再看。")}</span></div>`;
  return rows
    .map((row) => {
      const active = row.id === state.lhbAgencyId ? " is-active" : "";
      return `<button class="oh-row${active}" data-lhb-agency="${esc(row.id)}" data-lhb-agency-name="${esc(row.name)}" title="查看 ${esc(row.name)} 的近期上榜记录">
        <span class="oh-row-main">
          <span class="oh-row-name">${esc(row.name)}</span>
          <span class="oh-row-sub">${nameTagsChips(row.tags) || `<span>买入 ${amount(row.buy)} · 卖出 ${amount(row.sell)}</span>`}</span>
        </span>
        <span class="oh-row-num">${moneyCell(row.net)}<span class="oh-row-net">净额</span></span>
      </button>`;
    })
    .join("");
}

function renderListSkeleton(): string {
  const row = `<div class="oh-sk-row"><span class="sk sk-metric"></span><span class="sk sk-index"></span></div>`;
  const label = state.otherTab === "yyz" ? "游资名号" : state.otherTab === "org" ? "机构净买入" : state.otherTab === "agency" ? "营业部" : "上榜个股";
  return `<div class="oh-col-head"><span class="oh-col-title">${label}<em>—</em></span><span class="oh-col-note">读取中</span></div>
    <div class="oh-list-body">${row.repeat(9)}</div>`;
}

/* ————————————————— panel column ————————————————— */

function renderPanelColumn(): string {
  if (!state.lhbBoard) return `<div class="oh-col oh-panel-col">${renderPanelSkeleton()}</div>`;
  if (!state.lhbBoard.rows.length) {
    return `<div class="oh-col oh-panel-col"><div class="oh-empty"><b>暂无明细</b><span>该日期没有龙虎榜数据，右侧明细为空。</span></div></div>`;
  }
  if (secondaryPending()) {
    const busy = state.lhbSecondaryLoading || state.lhbLoading;
    return `<div class="oh-col oh-panel-col">${
      busy
        ? `<div class="oh-loading">${icon("activity", 13)}<span>正在读取席位榜与机构榜…</span></div>`
        : `<div class="oh-empty"><b>数据未加载</b><span>${esc(state.lhbExtraError || "可点上方的重试按钮。")}</span></div>`
    }</div>`;
  }
  if (state.otherTab === "yyz") return `<div class="oh-col oh-panel-col">${renderTagPanel()}</div>`;
  if (state.otherTab === "agency") return `<div class="oh-col oh-panel-col">${renderAgencyPanel()}</div>`;
  return `<div class="oh-col oh-panel-col">${renderStockPanel()}</div>`;
}

function renderPanelSkeleton(): string {
  return `<div class="oh-panel-head"><div class="oh-panel-title"><span class="sk sk-metric"></span></div><span class="oh-panel-sub">读取中…</span></div>
    <div class="oh-panel-body">${`<div class="oh-sk-block"><span class="sk sk-metric"></span><span class="sk sk-index"></span></div>`.repeat(4)}</div>`;
}

function renderStockPanel(): string {
  const stock = state.otherTab === "org" ? selectedOrg() : selectedStock();
  if (!stock) {
    return `<div class="oh-empty"><b>选择左侧个股</b><span>点一行查看当日买入 / 卖出席位与上榜理由。</span></div>`;
  }
  const detail = state.lhbDetailKey === `${state.lhbDate}|${stock.code}` ? state.lhbDetail : null;
  const loading = state.lhbDetailLoading && !detail;
  const pct = Number.isFinite(detail?.pct ?? NaN) ? detail!.pct : stock.pct;
  const institution = state.otherTab === "org" ? selectedOrg() : undefined;
  const meta = detail
    ? [`${institution ? "龙虎榜净买入" : "净买入"} ${signedAmount(detail.netBuy)}`, `关联营业部 ${detail.seatCount || "—"}`, `换手 ${detail.turnoverRate.toFixed(2)}%`, `流通 ${detail.circulation.toFixed(1)} 亿`]
    : "seats" in stock
      ? [`净买入 ${signedAmount(stock.netBuy)}`, `席位 ${stock.seats}`, `换手 ${stock.turnoverRate.toFixed(2)}%`, `流通 ${(stock.floatCap / 1e8).toFixed(1)} 亿`]
      : [`机构净买入 ${signedAmount(stock.netBuy)}`, `机构 ${stock.orgCount}`, `换手 ${stock.turnoverRate.toFixed(2)}%`];

  return `<div class="oh-panel-head">
      <div class="oh-panel-title">
        <h3>${esc(stock.name)}</h3>
        <span class="oh-panel-code">${esc(stock.code)}</span>
        ${pctCell(pct)}
        ${stock.board ? `<i class="oh-tag is-board">${esc(stock.board)}</i>` : ""}
        ${stock.sector ? `<span class="oh-panel-sector">${esc(stock.sector)}</span>` : ""}
      </div>
      <div class="oh-panel-actions">
        ${institution ? `<span class="oh-org-sum">机构净买入 ${moneyCell(institution.netBuy)}</span>` : ""}
        <button class="chip" data-lhb-chart="${esc(stock.code)}" data-lhb-chart-name="${esc(stock.name)}" title="打开 ${esc(stock.name)} 的 K 线">${icon("chart", 12)}<span>K线</span></button>
      </div>
    </div>
    <div class="oh-panel-meta">${meta.map((item) => `<span>${item}</span>`).join("")}</div>
    <div class="oh-panel-body">${renderDetailBody(detail, loading, stock)}</div>`;
}

function renderDetailBody(detail: LhbDetail | null, loading: boolean, stock: LhbStock | LhbInstitution): string {
  if (loading) {
    return `<div class="oh-loading">${icon("activity", 13)}<span>正在读取 ${esc(stock.name)} 的上榜明细…</span></div>`;
  }
  if (!detail) {
    return `<div class="oh-empty is-panel"><b>暂无明细</b><span>该日期没有这只票的席位数据，可能不是当日上榜个股。</span></div>`;
  }
  if (!detail.blocks.length) {
    return `<div class="oh-empty is-panel"><b>暂无上榜明细</b><span>${esc(detail.warning || "该日期没有这只票的席位数据，可能不是当日上榜个股。")}</span></div>`;
  }
  const reasons = Array.from(new Set(detail.blocks.flatMap((block) => block.reasons)));
  const sections = detail.blocks
    .map((block, index) => {
      const showReasons = index === 0 && reasons.length;
      const buySum = block.buy.reduce((acc, seat) => acc + seat.net, 0);
      const sellSum = block.sell.reduce((acc, seat) => acc + seat.net, 0);
      return `${showReasons ? `<div class="oh-reasons">${reasons.map((reason) => `<span class="oh-reason">${esc(reason)}</span>`).join("")}</div>` : ""}
      ${renderSeatSection("买入营业部", block.buy, block.buyTotal, buySum, "buy")}
      ${renderSeatSection("卖出营业部", block.sell, block.sellTotal, sellSum, "sell")}`;
    })
    .join("");
  const onTime = detail.onTime.slice(0, 10);
  return `${sections}
    <div class="oh-ontime">
      <span class="oh-ontime-label">近期上榜</span>
      <div class="oh-ontime-list">${onTime.length ? onTime.map((date) => `<span class="oh-date">${compactDate(date)}</span>`).join("") : `<span class="oh-date">无</span>`}</div>
    </div>`;
}

function renderSeatSection(
  title: string,
  seats: LhbSeat[],
  total: number,
  netSum: number,
  kind: "buy" | "sell",
): string {
  if (!seats.length) {
    return `<div class="oh-section"><span class="oh-section-title ${kind}">${title}</span><span class="oh-section-note">暂无</span></div>`;
  }
  return `<div class="oh-section">
    <div class="oh-section-head">
      <span class="oh-section-title ${kind}">${title}</span>
      <span class="oh-section-note">${kind === "buy" ? "买入" : "卖出"}合计 ${amount(total)} · 净额 ${signedAmount(netSum)}</span>
    </div>
    <table class="oh-table">
      <thead><tr><th class="oh-c-rank">#</th><th class="oh-c-seat">营业部席位</th><th class="oh-c-money">买入</th><th class="oh-c-money">卖出</th><th class="oh-c-money">净额</th></tr></thead>
      <tbody>
        ${seats
          .map(
            (seat, index) => `<tr>
              <td class="oh-c-rank">${index + 1}</td>
              <td class="oh-c-seat"><span class="oh-seat-name" title="${esc(seat.name)}">${esc(seat.name)}</span>${seatTagChips(seat)}</td>
              <td class="oh-c-money">${amount(seat.buy)}</td>
              <td class="oh-c-money">${amount(seat.sell)}</td>
              <td class="oh-c-money">${moneyCell(seat.net)}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  </div>`;
}

function renderTagPanel(): string {
  const tag = selectedTag();
  if (!tag) {
    return `<div class="oh-empty"><b>选择一个游资名号</b><span>左列按当日净额排序；点开后可以看到该名号下的所有上榜席位。</span></div>`;
  }
  const seatRows = tag.seats
    .map(
      (seat, index) => `<tr class="oh-seat-row ${seat.id === state.lhbSeatLog?.seatId ? "is-active" : ""}" data-lhb-seat="${esc(seat.id)}" data-lhb-seat-name="${esc(seat.name)}">
        <td class="oh-c-rank">${index + 1}</td>
        <td class="oh-c-seat"><span class="oh-seat-name" title="${esc(seat.name)}">${esc(seat.name)}</span></td>
        <td class="oh-c-money">${amount(seat.buy)}</td>
        <td class="oh-c-money">${amount(seat.sell)}</td>
        <td class="oh-c-money">${moneyCell(seat.net)}</td>
      </tr>`,
    )
    .join("");
  return `<div class="oh-panel-head">
      <div class="oh-panel-title">
        <h3>${esc(tag.tag)}</h3>
        <i class="oh-tag is-hot">${tag.seats.length} 席</i>
        <span class="oh-panel-sector">游资名号</span>
      </div>
      <div class="oh-panel-actions"><span class="oh-sync">点席位看近期上榜记录</span></div>
    </div>
    <div class="oh-panel-meta"><span>买入 ${amount(tag.buy)}</span><span>卖出 ${amount(tag.sell)}</span><span>净额 ${signedAmount(tag.net)}</span></div>
    <div class="oh-panel-body">
      <div class="oh-section">
        <div class="oh-section-head"><span class="oh-section-title">上榜席位</span><span class="oh-section-note">净额由高到低</span></div>
        <table class="oh-table">
          <thead><tr><th class="oh-c-rank">#</th><th class="oh-c-seat">营业部席位</th><th class="oh-c-money">买入</th><th class="oh-c-money">卖出</th><th class="oh-c-money">净额</th></tr></thead>
          <tbody>${seatRows}</tbody>
        </table>
      </div>
      ${renderSeatLogSection()}
    </div>`;
}

function renderAgencyPanel(): string {
  const agency = selectedAgency();
  if (!agency) {
    return `<div class="oh-empty"><b>选择一个营业部</b><span>左列是当日上榜营业部净额排行；点开后自动读取近期上榜记录。</span></div>`;
  }
  return `<div class="oh-panel-head">
      <div class="oh-panel-title">
        <h3>${esc(agency.name)}</h3>
      </div>
      <div class="oh-panel-actions"><span class="oh-sync">关联 ${agency.joinCount} 只上榜个股</span></div>
    </div>
    <div class="oh-panel-meta"><span>买入 ${amount(agency.buy)}</span><span>卖出 ${amount(agency.sell)}</span><span>净额 ${signedAmount(agency.net)}</span>${agency.tags.length ? `<span class="oh-meta-tags">${nameTagsChips(agency.tags)}</span>` : ""}</div>
    <div class="oh-panel-body">${renderSeatLogSection()}</div>`;
}

function renderSeatLogSection(): string {
  if (state.lhbSeatLoading) {
    return `<div class="oh-loading">${icon("activity", 13)}<span>正在读取 ${esc(state.lhbSeatName)} 的近期上榜记录…</span></div>`;
  }
  const log = state.lhbSeatLog;
  if (!log) {
    return `<div class="oh-section"><div class="oh-section-head"><span class="oh-section-title">近期上榜记录</span><span class="oh-section-note">选择席位后加载</span></div></div>`;
  }
  if (!log.rows.length) {
    return `<div class="oh-section"><div class="oh-section-head"><span class="oh-section-title">近期上榜记录</span><span class="oh-section-note">最近 200 条</span></div>
      <p class="oh-section-empty">${esc(log.warning || "该席位近期没有上榜记录。")}</p></div>`;
  }
  const trades = mergeSeatTrades(log.rows);
  const buySum = trades.reduce((acc, row) => acc + row.buy, 0);
  const sellSum = trades.reduce((acc, row) => acc + row.sell, 0);
  const dates = trades.map((row) => row.date).sort();
  const range = seatRange(dates);
  const cap = log.truncated ? ` · 仅显示最近 ${log.rows.length} 条` : "";
  return `<div class="oh-section">
    <div class="oh-section-head">
      <span class="oh-section-title">近期上榜记录</span>
      <span class="oh-section-note" title="${esc(state.lhbSeatName || "")} · 覆盖 ${range} · 合并后 ${trades.length} 段${cap} · 净额 ${signedAmount(buySum - sellSum)}">覆盖 ${range} · 合并 ${trades.length} 段${cap} · 净额 ${signedAmount(buySum - sellSum)}</span>
    </div>
    <table class="oh-table is-trades">
      <thead><tr><th class="oh-c-date">日期</th><th class="oh-c-stock">个股</th><th class="oh-c-money">涨幅</th><th class="oh-c-money">买入</th><th class="oh-c-money">卖出</th><th class="oh-c-money">净额</th></tr></thead>
      <tbody>${trades.map(renderSeatLogRow).join("")}</tbody>
    </table>
  </div>`;
}

/**
 * 席位记录整理：
 * 1) 上游同一条记录会重复出现（同一日期/代码/买卖金额/D3），先按签名去重；
 * 2) 同一天同一只票若同时有「当日榜」与「三日榜」，只保留当日榜，避免两套口径相加；
 * 3) 其余记录按「日期 + 代码」合并金额，三日榜记录在日期下标注「3日」。
 */
function mergeSeatTrades(rows: LhbSeatTrade[]): LhbSeatTrade[] {
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    const sig = `${row.date}|${row.code}|${row.buy}|${row.sell}|${row.threeDay ? 1 : 0}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  const groups = new Map<string, LhbSeatTrade[]>();
  for (const row of unique) {
    const key = `${row.date}|${row.code}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const merged: LhbSeatTrade[] = [];
  for (const list of groups.values()) {
    const daily = list.filter((row) => !row.threeDay);
    const keep = daily.length ? daily : list;
    const first = keep[0];
    let buy = 0;
    let sell = 0;
    for (const row of keep) {
      buy += row.buy;
      sell += row.sell;
    }
    merged.push({ ...first, buy, sell, net: buy - sell, threeDay: daily.length === 0 });
  }
  return merged.sort((a, b) => (a.date === b.date ? b.net - a.net : b.date.localeCompare(a.date)));
}

/** 覆盖区间：同年显示 MM.DD–MM.DD，跨年时带上年份避免歧义。 */
function seatRange(dates: string[]): string {
  if (!dates.length) return "—";
  const from = dates[0];
  const to = dates[dates.length - 1];
  if (from.slice(0, 4) === to.slice(0, 4)) return `${compactDate(from)}–${compactDate(to)}`;
  return `${from.slice(0, 4)}.${from.slice(4, 6)}.${from.slice(6, 8)}–${to.slice(0, 4)}.${to.slice(4, 6)}.${to.slice(6, 8)}`;
}

function renderSeatLogRow(row: LhbSeatTrade): string {
  return `<tr>
    <td class="oh-c-date">${compactDate(row.date)}${row.threeDay ? `<i class="oh-tag is-yday oh-3d">3日</i>` : ""}</td>
    <td class="oh-c-stock"><span class="oh-stock-name">${esc(row.name)}</span><span class="oh-code">${esc(row.code)}</span></td>
    <td class="oh-c-money">${pctCell(row.pct)}</td>
    <td class="oh-c-money">${amount(row.buy)}</td>
    <td class="oh-c-money">${amount(row.sell)}</td>
    <td class="oh-c-money">${moneyCell(row.net)}</td>
  </tr>`;
}

/* ————————————————— 同花顺自选 · helpers ————————————————— */

function maskIwcUserId(raw: string | null | undefined): string {
  const id = String(raw ?? "").trim();
  if (!id) return "";
  if (id.includes("*")) return id;
  if (id.length <= 2) return `${id.slice(0, 1)}***`;
  if (id.length <= 6) return `${id.slice(0, 1)}***${id.slice(-1)}`;
  return `${id.slice(0, 3)}****${id.slice(-2)}`;
}

function iwcLoggedIn(): boolean {
  return state.iwcAuth?.iwcLoggedIn === true;
}

/** 板块按 sort 升序（同 sort 用 sn 兜底），与面板里展示的「排序」一致。 */
function iwcPlateRows(): IwcPlate[] {
  return [...(state.iwcSnapshot?.plates ?? [])].sort((a, b) =>
    a.sort === b.sort ? a.sn.localeCompare(b.sn) : a.sort - b.sort,
  );
}

function iwcSelfStockRows(): IwcStock[] {
  return state.iwcSnapshot?.selfStocks ?? [];
}

function selectedIwcPlate(): IwcPlate | undefined {
  const plates = iwcPlateRows();
  return plates.find((plate) => plate.sn === state.iwcPlateSn) ?? plates[0];
}

function iwcSyncSummary(): string {
  if (state.iwcSyncing) return "正在同步问财自选…";
  if (state.iwcSnapshot?.syncedAt) return `最后同步 ${relTime(state.iwcSnapshot.syncedAt)}`;
  return iwcLoggedIn() ? "尚未同步" : "登录后可同步";
}

/* ————————————————— 同花顺自选 · shell ————————————————— */

function renderIwcStage(): string {
  return `${renderIwcBar()}
  ${renderIwcTabs()}
  ${renderIwcNotices()}
  ${renderIwcBody()}`;
}

function renderIwcBar(): string {
  const auth = state.iwcAuth;
  const logged = iwcLoggedIn();
  const pending = state.iwcLoginPending;
  const syncing = state.iwcSyncing;
  const userId = maskIwcUserId(auth?.userId ?? state.iwcSnapshot?.userId);
  const authText = !auth && state.iwcLoading ? "读取登录态…" : logged ? "问财已登录" : "问财未登录";

  return `<div class="oh-bar iwc-bar">
    <div class="oh-bar-copy">
      <h2>同花顺自选</h2>
      <p><span class="oh-kicker">其他</span>只读同步问财自选板块与自选股 · 不保存账号密码</p>
    </div>
    <div class="iwc-status">
      <span class="iwc-state ${logged ? "is-on" : ""}"><i class="iwc-dot"></i>${authText}</span>
      ${auth ? `<span class="iwc-state is-ghost ${auth.thsLoggedIn ? "is-on" : ""}">同花顺${auth.thsLoggedIn ? "已登录" : "未登录"}</span>` : ""}
      ${userId ? `<span class="iwc-user" title="问财账号（脱敏）">${esc(userId)}</span>` : ""}
      <span class="oh-sync">${esc(iwcSyncSummary())}</span>
    </div>
    <div class="oh-bar-actions iwc-actions">
      <button class="chip iwc-login" data-iwc-login ${pending ? "disabled" : ""} title="${logged ? "重新打开同花顺登录窗口" : "打开同花顺 / 问财登录窗口"}">
        ${icon("eye", 12)}<span>${pending ? "等待登录…" : logged ? "重新登录" : "登录同花顺"}</span>
      </button>
      <button class="chip iwc-sync ${syncing ? "is-busy" : ""}" data-iwc-sync ${!logged || syncing ? "disabled" : ""} title="${logged ? "从问财只读拉取自选板块与自选股" : "登录后才能同步"}">
        ${icon("refresh", 12)}<span>${syncing ? "同步中" : "同步"}</span>
      </button>
      <button class="chip iwc-logout" data-iwc-logout ${!logged ? "disabled" : ""} title="退出登录并清除本机登录态">
        ${icon("close", 12)}<span>退出</span>
      </button>
    </div>
  </div>`;
}

function renderIwcTabs(): string {
  const plates = iwcPlateRows();
  const selfStocks = iwcSelfStockRows();
  const memberCount = plates.reduce((sum, plate) => sum + plate.members.length, 0);
  const tab = state.iwcTab;
  const hint =
    tab === "self"
      ? `${selfStocks.length} 只自选股 · 扁平列表，点行打开 K 线`
      : `${plates.length} 个自选板块 · ${memberCount} 只成分股`;
  const snapshot = state.iwcSnapshot;
  return `<div class="oh-tabs-row">
    <div class="seg oh-tabs iwc-tabs" role="tablist" aria-label="同花顺自选分组">
      <button role="tab" aria-selected="${tab === "plates"}" class="${tab === "plates" ? "active" : ""}" data-iwc-tab="plates" title="按板块分组查看问财自选">自选板块<em class="iwc-tab-count">${plates.length}</em></button>
      <button role="tab" aria-selected="${tab === "self"}" class="${tab === "self" ? "active" : ""}" data-iwc-tab="self" title="问财自选股的扁平列表">自选股<em class="iwc-tab-count">${selfStocks.length}</em></button>
    </div>
    <span class="oh-tab-hint">${hint}</span>
    <div class="oh-tabs-meta">
      ${snapshot && snapshot.syncedAt ? `<span class="oh-date-chip" title="最近一次同步时间">${relTime(snapshot.syncedAt)}</span>` : ""}
    </div>
  </div>`;
}

/** 错误条 + 同步提示（warnings 逐条列出，可折叠）。 */
function renderIwcNotices(): string {
  const parts: string[] = [];
  if (state.iwcError) {
    parts.push(`<div class="banner error iwc-banner">${icon("activity", 13)}<span>${esc(state.iwcError)}</span>${
      iwcLoggedIn()
        ? `<button class="banner-action" data-iwc-sync title="重新同步自选">重试同步</button>`
        : `<button class="banner-action" data-iwc-login title="重新打开登录窗口">登录重试</button>`
    }</div>`);
  }
  const warnings = state.iwcSnapshot?.warnings ?? [];
  if (warnings.length) {
    parts.push(`<details class="iwc-warnings" open>
      <summary>${icon("info", 12)}<span>同步提示 ${warnings.length} 条</span>${icon("chevronDown", 12, "iwc-warnings-caret")}</summary>
      <ul class="iwc-warnings-list">${warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>
    </details>`);
  }
  return parts.length ? `<div class="iwc-notices">${parts.join("")}</div>` : "";
}

/* ————————————————— 同花顺自选 · body ————————————————— */

function renderIwcBody(): string {
  if (!iwcLoggedIn()) return renderIwcLoginGate();
  if (state.iwcLoading && !state.iwcSnapshot) {
    return renderIwcSingle(`<div class="oh-loading">${icon("activity", 13)}<span>正在读取同花顺自选…</span></div>`);
  }
  if (!state.iwcSnapshot) return renderIwcIdle();
  return state.iwcTab === "self" ? renderIwcSelfPanel() : renderIwcPlatesWorkbench();
}

/** 单栏骨架：登录引导 / 加载 / 空态共用。 */
function renderIwcSingle(inner: string): string {
  return `<div class="oh-workbench is-single"><div class="oh-col">${inner}</div></div>`;
}

function renderIwcLoginGate(): string {
  const pending = state.iwcLoginPending;
  if (state.iwcLoading && !state.iwcAuth) {
    return renderIwcSingle(`<div class="oh-loading">${icon("activity", 13)}<span>正在读取同花顺登录状态…</span></div>`);
  }
  return renderIwcSingle(`<div class="oh-empty iwc-gate">
    <b>登录同花顺 / 问财后同步自选</b>
    <span>登录后可以只读同步你自己账号下的自选板块（板块名 + 成分股）和自选股列表。天梯不保存问财账号密码，同步不会回写问财，也不会修改你网站上的自选。</span>
    <span>登录在同花顺官方页面完成，登录态只留在本机；随时可以点「退出」清除。</span>
    <button class="chip" data-iwc-login ${pending ? "disabled" : ""}>${icon("eye", 12)}<span>${pending ? "等待登录…" : "登录同花顺"}</span></button>
    ${pending ? `<span class="iwc-gate-note">已打开登录窗口，登录成功后会自动读取自选…</span>` : ""}
  </div>`);
}

function renderIwcIdle(): string {
  return renderIwcSingle(`<div class="oh-empty">
    <b>还没有同步过自选</b>
    <span>点右上角「同步」从问财拉取当前的自选板块与自选股。同步是只读的：只拉取你自己账号的内容，不保存密码、不回写问财。</span>
    <button class="chip" data-iwc-sync ${state.iwcSyncing ? "disabled" : ""}>${icon("refresh", 12)}<span>${state.iwcSyncing ? "同步中" : "立即同步"}</span></button>
  </div>`);
}

function renderIwcPlatesWorkbench(): string {
  const plates = iwcPlateRows();
  if (!plates.length) {
    return renderIwcSingle(`<div class="oh-empty">
      <b>暂无自选板块</b>
      <span>你问财账号下的自选板块为空。去问财网站创建板块后再点「同步」，板块与成分股就会出现在这里。</span>
      <button class="chip" data-iwc-sync ${state.iwcSyncing ? "disabled" : ""}>${icon("refresh", 12)}<span>${state.iwcSyncing ? "同步中" : "重新同步"}</span></button>
    </div>`);
  }
  const selected = selectedIwcPlate() ?? plates[0];
  return `<div class="oh-workbench">
    <div class="oh-col oh-list-col">
      <div class="oh-col-head">
        <span class="oh-col-title">自选板块<em>${plates.length}</em></span>
        <span class="oh-col-note">按问财排序</span>
      </div>
      <div class="oh-list-body">${plates.map((plate) => renderIwcPlateRow(plate, selected.sn)).join("")}</div>
    </div>
    <div class="oh-col oh-panel-col">${renderIwcPlatePanel(selected)}</div>
  </div>`;
}

function renderIwcPlateRow(plate: IwcPlate, selectedSn: string): string {
  const active = plate.sn === selectedSn ? " is-active" : "";
  const condition = plate.condition.trim();
  const dynamic = condition
    ? `<i class="oh-tag is-board" title="动态条件：${esc(condition)}">动态</i>`
    : "";
  return `<button class="oh-row${active}" data-iwc-plate="${esc(plate.sn)}" title="查看「${esc(plate.name)}」的成分股">
    <span class="oh-row-main">
      <span class="oh-row-name">${esc(plate.name)}${dynamic}</span>
      <span class="oh-row-sub">${plate.members.length} 只成分股${plate.sort ? ` · 排序 ${plate.sort}` : ""}${condition ? ` · ${esc(condition)}` : ""}</span>
    </span>
    <span class="oh-row-num">${icon("chevronRight", 13)}</span>
  </button>`;
}

function renderIwcPlatePanel(plate: IwcPlate | undefined): string {
  if (!plate) {
    return `<div class="oh-empty"><b>选择左侧板块</b><span>点一个自选板块查看它的成分股。</span></div>`;
  }
  const condition = plate.condition.trim();
  const members = iwcSortedStocks(plate.members);
  const syncedAt = state.iwcSnapshot?.syncedAt ?? 0;
  const meta = [
    condition ? `动态条件：${esc(condition)}` : "静态板块",
    `成分股 ${members.length} 只`,
    plate.sort ? `排序 ${plate.sort}` : "",
    syncedAt ? `同步于 ${relTime(syncedAt)}` : "",
  ].filter(Boolean);

  return `<div class="oh-panel-head">
      <div class="oh-panel-title">
        <h3>${esc(plate.name)}</h3>
        ${condition ? `<i class="oh-tag is-board" title="${esc(condition)}">动态</i>` : ""}
        <span class="oh-panel-code">SN ${esc(plate.sn)}</span>
      </div>
      <div class="oh-panel-actions">
        <button class="chip" data-iwc-sort title="切换成分股排序：默认 / 涨幅高→低 / 低→高">${icon("activity", 12)}<span>${iwcSortLabel()}</span></button>
        <button class="chip" data-iwc-import="plate:${esc(plate.sn)}" ${members.length ? "" : "disabled"} title="把「${esc(plate.name)}」的 ${members.length} 只成分股加入本地自选">
          ${icon("download", 12)}<span>导入自选</span>
        </button>
      </div>
    </div>
    <div class="oh-panel-meta">${meta.map((item) => `<span>${item}</span>`).join("")}</div>
    <div class="oh-panel-body">${
      members.length
        ? renderIwcStockTable(members)
        : `<div class="oh-empty is-panel"><b>该板块暂无成分股</b><span>问财上的动态板块可能暂时没有命中的股票，稍后再同步试试。</span></div>`
    }</div>`;
}

function renderIwcSelfPanel(): string {
  const stocks = iwcSelfStockRows();
  if (!stocks.length) {
    return renderIwcSingle(`<div class="oh-empty">
      <b>暂无自选股</b>
      <span>你问财账号下的自选股列表为空。在问财网站上添加股票后再点「同步」，就会出现在这里。</span>
      <button class="chip" data-iwc-sync ${state.iwcSyncing ? "disabled" : ""}>${icon("refresh", 12)}<span>${state.iwcSyncing ? "同步中" : "重新同步"}</span></button>
    </div>`);
  }
  const syncedAt = state.iwcSnapshot?.syncedAt ?? 0;
  return `<div class="oh-workbench is-single">
    <div class="oh-col iwc-self-col">
      <div class="oh-panel-head">
        <div class="oh-panel-title">
          <h3>自选股</h3>
          <span class="oh-panel-code">${stocks.length} 只</span>
        </div>
        <div class="oh-panel-actions">
          ${syncedAt ? `<span class="oh-sync">同步于 ${relTime(syncedAt)}</span>` : ""}
          <button class="chip" data-iwc-sort title="切换自选股排序：默认 / 涨幅高→低 / 低→高">${icon("activity", 12)}<span>${iwcSortLabel()}</span></button>
          <button class="chip" data-iwc-import="self" title="把这 ${stocks.length} 只自选股加入本地自选分组">
            ${icon("download", 12)}<span>导入自选</span>
          </button>
        </div>
      </div>
      <div class="oh-panel-body">${renderIwcStockTable(iwcSortedStocks(stocks))}</div>
    </div>
  </div>`;
}

/* ————————————————— 同花顺自选 · 股票表 ————————————————— */

function renderIwcStockTable(stocks: IwcStock[]): string {
  return `<table class="oh-table iwc-stock-table">
    <thead><tr>
      <th class="oh-c-rank">#</th>
      <th class="iwc-c-code">代码</th>
      <th class="oh-c-stock">名称</th>
      <th class="iwc-c-market">市场</th>
      <th class="iwc-c-pct">涨幅</th>
      <th class="iwc-c-act">操作</th>
    </tr></thead>
    <tbody>${stocks.map((stock, index) => renderIwcStockRow(stock, index)).join("")}</tbody>
  </table>`;
}

function renderIwcStockRow(stock: IwcStock, index: number): string {
  const attrs = `data-stock-code="${esc(stock.code)}" data-stock-name="${esc(stock.name || stock.code)}" data-iwc-stock="${esc(stock.code)}" data-iwc-name="${esc(stock.name)}" data-iwc-market="${esc(stock.market)}"`;
  const active = state.chartStock?.code === stock.code ? " is-active" : "";
  return `<tr class="iwc-stock-row${active}" ${attrs} title="查看 ${esc(stock.name)} 的 K 线">
    <td class="oh-c-rank">${index + 1}</td>
    <td class="iwc-c-code">${esc(stock.code)}</td>
    <td class="oh-c-stock"><span class="oh-stock-name">${esc(stock.name)}</span></td>
    <td class="iwc-c-market">${marketLabel(stock.market, stock.code)}</td>
    <td class="iwc-c-pct ${iwcPctClass(stock.code)}">${iwcPctText(stock.code)}</td>
    <td class="iwc-c-act"><button class="chip iwc-chart" ${attrs} title="打开 ${esc(stock.name)} 的 K 线">${icon("chart", 11)}<span>K线</span></button></td>
  </tr>`;
}
