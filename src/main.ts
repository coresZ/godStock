import "./styles.css";
import { api } from "./lib/api";
import { availableDates, filterStocks, neighbors, parseHash, state } from "./lib/state";
import type { ChartPrefs, ChartSelection, Period, SearchItem, Theme, WatchStock } from "./lib/types";
import { esc, fmtBytes, fmtShortDate, icon, relTime, weekdayFromYmd } from "./lib/ui";
import { KLineChart } from "./chart";
import { indicatorSummary, renderChartToolbar, renderChartView, renderWatchPanel } from "./views/chart";
import { renderIndices, renderRail, renderTitlebar, syncLabel } from "./views/common";
import { renderLadder } from "./views/ladder";
import { renderPool, updatePoolStage, updatePoolTable } from "./views/pool";
import { renderTimeline } from "./views/timeline";

let chart: KLineChart | null = null;
let dayToken = 0;
let chartToken = 0;
let overlayKind:
  | "search"
  | "settings"
  | "date"
  | "watch-add"
  | "group-dialog"
  | "group-delete"
  | "indicator"
  | "context"
  | null = null;
let overlayRoot!: HTMLElement;
let toastRoot!: HTMLElement;
let searchTimer: number | undefined;
let booted = false;

const localToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};

/* ————————————————— boot ————————————————— */

function boot(): void {
  const app = document.getElementById("app")!;
  app.innerHTML = `<div class="boot">
    <img src="./mark.svg" alt="" class="boot-mark" />
    <div class="boot-word">天梯</div>
    <div class="boot-sub">A股涨停复盘</div>
    <div class="boot-line"><span></span></div>
  </div>`;
  void start();
}

async function start(): Promise<void> {
  try {
    const settings = await api.getSettings();
    state.theme = settings.theme === "light" ? "light" : "dark";
  } catch {
    state.theme = "dark";
  }
  applyTheme(state.theme, false);

  void loadChartPrefs();
  void loadWatchlist();
  const route = parseHash();
  state.view = route.view;
  state.returnView = route.view === "chart" ? "ladder" : route.view;
  if (route.code) {
    if (route.code.startsWith("IDX-")) {
      const secid = route.code.slice(4);
      state.chartStock = { code: secid, name: "", market: "", kind: "index", secid };
    } else {
      state.chartStock = { code: route.code, name: "", market: "", kind: "stock" };
    }
    state.chartLoading = true;
  }

  renderShell();
  bindGlobals();
  booted = true;

  void loadIndices(false);
  await ensureCalendar();
  if (state.date) await loadDay(state.date, true);
  if (state.view === "chart" && state.chartStock) {
    await loadChart();
  }
  window.setTimeout(() => {
    document.querySelector(".ladder")?.classList.remove("is-entering");
  }, 2000);
}

function renderShell(): void {
  const app = document.getElementById("app")!;
  app.innerHTML = `<div class="window">
    ${renderTitlebar()}
    <div class="app-body">
      ${renderRail()}
      <main class="main" id="main"></main>
    </div>
  </div>
  <div id="overlay-root"></div>
  <div id="toast-stack" class="toast-stack" aria-live="polite"></div>`;
  overlayRoot = document.getElementById("overlay-root")!;
  toastRoot = document.getElementById("toast-stack")!;
  renderMain();
  updateChrome();
}

/* ————————————————— theme / chrome ————————————————— */

function applyTheme(theme: Theme, persist = true): void {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  if (persist) {
    void api.setTheme(theme).catch(() => toast("主题偏好未能保存", "error"));
  }
  if (booted) {
    replaceRail();
    if (chart) {
      chart.redraw();
      chart.setConfig(state.chartPrefs);
    }
  }
}

function replaceRail(): void {
  const current = document.querySelector(".rail");
  if (!current) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = renderRail();
  current.replaceWith(tmp.firstElementChild!);
}

function toggleTheme(): void {
  applyTheme(state.theme === "dark" ? "light" : "dark");
}

function updateChrome(): void {
  document.querySelectorAll<HTMLElement>(".rail-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.nav === state.view);
  });
  const sync = document.getElementById("sync-state");
  const text = document.getElementById("sync-text");
  if (sync) {
    sync.classList.remove("is-live", "is-error", "is-loading");
    if (state.sync === "live") sync.classList.add("is-live");
    else if (state.sync === "error") sync.classList.add("is-error");
    else if (state.sync === "loading") sync.classList.add("is-loading");
  }
  if (text) text.textContent = syncLabel();
}

function syncHash(): void {
  let suffix = "";
  if (state.view === "chart" && state.chartStock) {
    suffix = state.chartStock.kind === "index" ? `/IDX-${state.chartStock.secid || state.chartStock.code}` : `/${state.chartStock.code}`;
  }
  const hash = `#/${state.view}${suffix}`;
  if (window.location.hash !== hash) history.replaceState(null, "", hash);
}

/* ————————————————— calendar / day ————————————————— */

async function ensureCalendar(): Promise<void> {
  try {
    const cal = await api.getCalendar(false);
    state.calendar = cal;
    if (!state.date) state.date = cal.initialDate || cal.dates[cal.dates.length - 1] || cal.today;
    renderMain();
    if (cal.source !== "network") void refreshCalendar();
  } catch (e) {
    state.date = state.date || localToday();
    state.sync = "error";
    renderMain();
    toast(messageFrom(e, "交易日历未连接，暂以本地日期启动"), "error");
  }
}

async function refreshCalendar(): Promise<void> {
  try {
    const cal = await api.getCalendar(true);
    state.calendar = cal;
    if (!state.date) state.date = cal.initialDate || cal.today;
    if (state.view !== "chart") renderMain();
    else updateChrome();
  } catch {
    /* quietly keep local calendar */
  }
}

async function loadDay(date: string, initial = false): Promise<void> {
  if (!date) return;
  const token = ++dayToken;
  const same = state.day?.date === date ? state.day : null;
  const changed = state.date !== date;
  state.date = date;
  if (changed) {
    state.poolSector = "";
    state.poolQuery = "";
    state.poolFilter = "all";
    state.poolKind = "limitUp";
    state.poolSort = { key: "streak", dir: -1 };
  }
  state.day = same;
  state.dayLoading = !same;
  state.error = null;
  state.sync = "loading";
  if (changed) state.refreshing = false;
  renderMain();
  updateChrome();

  try {
    const day = await api.getDay(date, false);
    if (token !== dayToken) return;
    state.day = day;
    state.dayLoading = false;
    state.error = null;
    state.sync = day.source === "network" ? "live" : "cache";
    state.lastSyncAt = day.fetchedAt;
    renderMain();
    updateChrome();
    if (day.source !== "network") void refreshDay(date, token, true);
  } catch (e) {
    if (token !== dayToken) return;
    state.dayLoading = false;
    state.error = messageFrom(e, "涨停数据加载失败");
    state.sync = "error";
    renderMain();
    updateChrome();
    if (!state.day) toast(state.error, "error");
  }
}

async function refreshDay(date: string, token: number, quiet = false): Promise<void> {
  if (state.refreshing) return;
  state.refreshing = true;
  state.sync = "loading";
  updateChrome();
  document.querySelectorAll<HTMLElement>(".section-note").forEach((el) => {
    el.innerHTML = `${icon("refresh", 13)}同步中`;
  });
  try {
    const day = await api.getDay(date, true);
    if (token !== dayToken) {
      state.refreshing = false;
      return;
    }
    state.day = day;
    state.dayLoading = false;
    state.error = null;
    state.sync = day.warning ? "cache" : "live";
    state.lastSyncAt = day.fetchedAt;
    state.refreshing = false;
    renderMain();
    updateChrome();
    if (day.warning && !quiet) toast(day.warning, "error");
  } catch (e) {
    if (token !== dayToken) {
      state.refreshing = false;
      return;
    }
    state.refreshing = false;
    state.sync = state.day ? "cache" : "error";
    updateChrome();
    const note = document.querySelector<HTMLElement>(".section-note");
    if (note && state.day) note.innerHTML = `${icon("refresh", 13)}${relTime(state.day.fetchedAt)}`;
    if (!quiet && !state.day) toast(messageFrom(e, "刷新失败"), "error");
  }
}

async function loadIndices(refreshing: boolean): Promise<void> {
  try {
    const list = await api.getIndices(refreshing);
    if (list.length) {
      state.indices = list;
      updateIndicesDom();
      if (!refreshing) void loadIndices(true);
      return;
    }
    if (!refreshing) showIndicesUnavailable();
  } catch {
    if (!refreshing) showIndicesUnavailable();
  }
}

function updateIndicesDom(): void {
  const el = document.querySelector<HTMLElement>(".indices");
  if (el) el.innerHTML = renderIndices();
}

function showIndicesUnavailable(): void {
  const el = document.querySelector<HTMLElement>(".indices");
  if (!el || state.indices.length) return;
  el.innerHTML = ["上证", "深证", "创业板"]
    .map(
      (name) => `<div class="index"><div class="index-copy"><span class="index-name">${name}</span><span class="index-value" style="color:var(--faint)">—</span></div></div>`,
    )
    .join("");
}

function changeDate(date: string | null | undefined): void {
  if (!date || date === state.date) return;
  if (state.view === "chart") return;
  closeOverlay();
  void loadDay(date);
}

/* ————————————————— routing ————————————————— */

function navigate(view: "ladder" | "pool" | "timeline" | "chart"): void {
  if (view === "chart") {
    if (!state.chartStock) {
      openSearch();
      return;
    }
    state.view = "chart";
    syncHash();
    renderMain();
    updateChrome();
    if (!state.chartData && !state.chartLoading) void loadChart();
    return;
  }
  if (state.view !== "chart") state.returnView = view;
  state.view = view;
  syncHash();
  renderMain();
  updateChrome();
}

function openChart(code: string, name: string, market = ""): void {
  if (!code) return;
  if (state.view !== "chart") state.returnView = state.view;
  state.chartStock = { code, name, market, kind: "stock" };
  state.view = "chart";
  state.chartData = null;
  state.chartError = null;
  state.chartLoading = true;
  syncHash();
  renderMain();
  void loadChart();
}

function openIndexChart(secid: string, name: string): void {
  if (!secid) return;
  if (state.view !== "chart") state.returnView = state.view;
  state.chartStock = { code: secid, name, market: "", kind: "index", secid };
  state.view = "chart";
  state.chartData = null;
  state.chartError = null;
  state.chartLoading = true;
  syncHash();
  renderMain();
  void loadChart();
}

function chartBack(): void {
  const back = state.returnView === "chart" ? "ladder" : state.returnView;
  state.view = back === "timeline" ? "timeline" : back;
  syncHash();
  renderMain();
  updateChrome();
}

async function fetchChartData(period: Period, refresh: boolean) {
  const stock = state.chartStock!;
  if (stock.kind === "index") {
    return api.getIndexKline(stock.secid || stock.code, stock.name, period, refresh);
  }
  return api.getKline(stock.code, period, refresh);
}

async function loadChart(): Promise<void> {
  const stock = state.chartStock;
  if (!stock) return;
  const token = ++chartToken;
  const period = state.chartPeriod;
  state.chartLoading = true;
  state.chartError = null;
  renderMain({ animate: false });
  try {
    const data = await fetchChartData(period, false);
    if (token !== chartToken) return;
    state.chartData = data;
    state.chartLoading = false;
    if (state.chartStock && !state.chartStock.name && data.name) state.chartStock.name = data.name;
    renderMain({ animate: false });
    if (data.source === "cache") void refreshChart(token);
  } catch (e) {
    if (token !== chartToken) return;
    state.chartLoading = false;
    state.chartError = messageFrom(e, "K线加载失败");
    renderMain({ animate: false });
    if (!state.chartData) toast(state.chartError, "error");
  }
}

async function refreshChart(token: number): Promise<void> {
  const stock = state.chartStock;
  if (!stock) return;
  const period = state.chartPeriod;
  try {
    const data = await fetchChartData(period, true);
    if (token !== chartToken) return;
    const old = state.chartData;
    const changed =
      !old ||
      old.candles.length !== data.candles.length ||
      old.latestDate !== data.latestDate ||
      old.candles[old.candles.length - 1]?.close !== data.candles[data.candles.length - 1]?.close;
    state.chartData = data;
    if (changed) renderMain({ animate: false });
    if (data.warning) toast(data.warning, "error");
  } catch {
    /* cache remains usable */
  }
}

function renderMain(opts: { animate?: boolean } = {}): void {
  const main = document.getElementById("main");
  if (!main) return;
  const scrolls = {
    ladder: document.querySelector<HTMLElement>(".ladder-main")?.scrollTop ?? 0,
    pool: document.querySelector<HTMLElement>(".pool-body")?.scrollTop ?? 0,
    side: document.querySelector<HTMLElement>(".chart-side")?.scrollTop ?? 0,
  };
  chart?.destroy();
  chart = null;
  let html = "";
  if (state.view === "pool") html = renderPool();
  else if (state.view === "timeline") html = renderTimeline();
  else if (state.view === "chart") html = renderChartView();
  else html = renderLadder();
  main.innerHTML = html;
  if (opts.animate === false) main.querySelector(".view")?.classList.add("no-anim");
  if (state.view === "chart" && state.chartStock && state.chartData) mountChart();
  const ladderScroller = main.querySelector<HTMLElement>(".ladder-main");
  if (ladderScroller) ladderScroller.scrollTop = scrolls.ladder;
  const poolScroller = main.querySelector<HTMLElement>(".pool-body");
  if (poolScroller) poolScroller.scrollTop = scrolls.pool;
  const chartSide = main.querySelector<HTMLElement>(".chart-side");
  if (chartSide) chartSide.scrollTop = scrolls.side;
  updateChrome();
}

function mountChart(): void {
  const stage = document.getElementById("chart-stage");
  if (!stage || !state.chartData) return;
  chart = new KLineChart(stage, {
    period: state.chartPeriod,
    range: state.chartRange,
    ...state.chartPrefs,
  });
  chart.setData(state.chartData.candles);
}

/* ————————————————— interactions ————————————————— */

function bindGlobals(): void {
  const app = document.getElementById("app")!;
  app.addEventListener("click", (e) => handleClick(e));
  app.addEventListener("input", (e) => handleInput(e));
  app.addEventListener("change", (e) => handleChange(e));
  app.addEventListener("keydown", (e) => handleKeydown(e));
  app.addEventListener("contextmenu", (e) => handleContextMenu(e));
  const titlebar = document.querySelector<HTMLElement>(".titlebar");
  const interactive = (target: HTMLElement) => Boolean(target.closest("button,input,a,.titlebar-search,.window-controls"));
  titlebar?.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement;
    if (e.button !== 0 || interactive(target)) return;
    e.preventDefault();
    void api.windowControl("drag").catch(() => {});
  });
  titlebar?.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement;
    if (interactive(target)) return;
    void api.windowControl("maximize");
  });
  window.setInterval(() => {
    updateChrome();
    const note = document.querySelector<HTMLElement>(".section-note");
    if (note && state.day && !state.refreshing) {
      note.innerHTML = `${icon("refresh", 13)}${relTime(state.day.fetchedAt)}`;
    }
  }, 30000);
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (!overlayKind) openSearch();
    } else if (e.key === "Escape" && overlayKind) {
      closeOverlay();
    } else if (!overlayKind && state.view !== "chart" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const next = e.key === "ArrowLeft" ? neighbors().prev : neighbors().next;
      if (next) {
        e.preventDefault();
        changeDate(next);
      }
    }
  });
}

const poolSearchDebounced = (() => {
  let timer: number | undefined;
  return () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => updatePoolTable(), 120);
  };
})();

function handleInput(e: Event): void {
  const target = e.target as HTMLElement;
  if (target.matches("[data-pool-search]")) {
    state.poolQuery = (target as HTMLInputElement).value;
    poolSearchDebounced();
  }
}

function handleChange(e: Event): void {
  const target = e.target as HTMLSelectElement;
  if (target.matches("[data-pool-sector]")) {
    state.poolSector = target.value;
    state.poolKind = "limitUp";
    updatePoolStage();
  }
}

function handleClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const win = target.closest<HTMLElement>("[data-win]");
  if (win) {
    const action = win.dataset.win as "minimize" | "maximize" | "close";
    void api.windowControl(action);
    return;
  }
  const nav = target.closest<HTMLElement>("[data-nav]");
  if (nav) {
    navigate(nav.dataset.nav as "ladder" | "pool" | "timeline" | "chart");
    return;
  }
  const indexEl = target.closest<HTMLElement>("[data-index-secid]");
  if (indexEl) {
    openIndexChart(indexEl.dataset.indexSecid!, indexEl.dataset.indexName || "指数");
    return;
  }
  const periodBtn = target.closest<HTMLElement>("[data-chart-period]");
  if (periodBtn) {
    const p = periodBtn.dataset.chartPeriod as Period;
    if (p !== state.chartPeriod) {
      state.chartPeriod = p;
      state.chartLoading = true;
      renderMain({ animate: false });
      void loadChart();
    }
    return;
  }
  const rangeBtn = target.closest<HTMLElement>("[data-chart-range]");
  if (rangeBtn) {
    const value = Number(rangeBtn.dataset.chartRange || "120");
    state.chartRange = value;
    document.querySelectorAll<HTMLElement>("[data-chart-range]").forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.chartRange) === value);
    });
    chart?.setRange(value);
    return;
  }
  const indicator = target.closest<HTMLElement>("[data-indicator]");
  if (indicator) {
    const key = indicator.dataset.indicator;
    if (key === "ma") state.chartPrefs.maEnabled = !state.chartPrefs.maEnabled;
    if (key === "ema") state.chartPrefs.emaEnabled = !state.chartPrefs.emaEnabled;
    if (key === "kdj") state.chartPrefs.kdjEnabled = !state.chartPrefs.kdjEnabled;
    const active = key === "ma" ? state.chartPrefs.maEnabled : key === "ema" ? state.chartPrefs.emaEnabled : state.chartPrefs.kdjEnabled;
    indicator.classList.toggle("active", active);
    indicator.setAttribute("aria-pressed", String(active));
    chart?.setConfig(state.chartPrefs);
    document.querySelectorAll<HTMLElement>(".chart-footnote span:last-child").forEach((el) => {
      el.textContent = indicatorSummary(state.chartPrefs);
    });
    void api.saveChartPrefs(state.chartPrefs).catch(() => toast("指标参数未能保存", "error"));
    return;
  }
  const timelineMark = target.closest<HTMLElement>("[data-timeline-minute]");
  if (timelineMark) {
    const minute = timelineMark.dataset.timelineMinute;
    const group = document.querySelector<HTMLElement>(`.tl-log-group[data-minute="${minute}"]`);
    if (group) {
      group.scrollIntoView({ block: "center", behavior: "smooth" });
      group.classList.add("is-flash");
      window.setTimeout(() => group.classList.remove("is-flash"), 1600);
    }
    return;
  }
  const kindBtn = target.closest<HTMLElement>("[data-pool-kind]");
  if (kindBtn) {
    const kind = kindBtn.dataset.poolKind as typeof state.poolKind;
    if (kind !== state.poolKind) {
      state.poolKind = kind;
      state.poolFilter = "all";
      state.poolSector = "";
      state.poolSort = kind === "limitUp" ? { key: "streak", dir: -1 } : kind === "openLimit" ? { key: "changeRate", dir: -1 } : { key: "changeRate", dir: 1 };
      updatePoolStage();
    }
    return;
  }
  const sort = target.closest<HTMLElement>("[data-sort]");
  if (sort) {
    const key = sort.dataset.sort as typeof state.poolSort.key;
    if (state.poolSort.key === key) state.poolSort.dir = state.poolSort.dir === 1 ? -1 : 1;
    else state.poolSort = { key, dir: key === "name" ? 1 : -1 };
    updatePoolStage();
    return;
  }
  const stockEl = target.closest<HTMLElement>("[data-stock-code]");
  if (stockEl) {
    openChart(stockEl.dataset.stockCode!, stockEl.dataset.stockName || "");
    return;
  }
  const watchGroupBtn = target.closest<HTMLElement>("[data-watch-group]");
  if (watchGroupBtn) {
    state.watchGroupId = Number(watchGroupBtn.dataset.watchGroup);
    updateWatchPanel();
    return;
  }
  const sector = target.closest<HTMLElement>("[data-sector-code]");
  if (sector) {
    state.poolKind = "limitUp";
    state.poolSector = sector.dataset.sectorCode || "";
    state.view = "pool";
    syncHash();
    renderMain({ animate: false });
    return;
  }
  const actionEl = target.closest<HTMLElement>("[data-action]");
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  switch (action) {
    case "search":
      openSearch();
      break;
    case "settings":
      openSettings();
      break;
    case "theme":
      toggleTheme();
      break;
    case "date-menu":
      openDateMenu();
      break;
    case "date-prev":
      changeDate(neighbors().prev);
      break;
    case "date-next":
      changeDate(neighbors().next);
      break;
    case "pool-filter":
      state.poolFilter = (actionEl.dataset.value as typeof state.poolFilter) || "all";
      updatePoolStage();
      break;
    case "pool-clear-sector":
      state.poolSector = "";
      updatePoolStage();
      break;
    case "batch-watch":
      openWatchAddDialog(
        filterStocks().map((s) => ({ code: s.code, name: s.name, market: s.market })),
        `把当前列表（${filterStocks().length} 只）加入自选`,
      );
      break;
    case "watch-add-current":
      if (state.chartStock?.kind === "stock") {
        openWatchAddDialog([watchStockFromSelection(state.chartStock)], "把当前股票加入自选");
      }
      break;
    case "watch-toggle":
      state.watchCollapsed = !state.watchCollapsed;
      updateWatchPanel();
      break;
    case "watch-create-group":
      openGroupDialog("create");
      break;
    case "watch-rename":
      openGroupDialog("rename");
      break;
    case "watch-delete":
      openGroupDelete();
      break;
    case "indicator-settings":
      openIndicatorSettings();
      break;
    case "retry-day":
    case "refresh-day":
      if (state.day) void refreshDay(state.date, dayToken);
      else void loadDay(state.date);
      break;
    case "chart-back":
      chartBack();
      break;
    case "chart-retry":
      if (state.chartStock) void loadChart();
      break;
    default:
      break;
  }
}

function handleKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement;
  if (e.key === "Escape" && overlayKind) {
    closeOverlay();
    return;
  }
  if ((target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") && !overlayKind) return;
  if (overlayKind) return;
  if (target instanceof HTMLCanvasElement) return;
  const row = target.closest<HTMLElement>("tr[data-stock-code]");
  if (row && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    openChart(row.dataset.stockCode!, row.dataset.stockName || "");
  }
}

/* ————————————————— toast ————————————————— */

function toast(message: string, type: "" | "error" = ""): void {
  if (!toastRoot) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === "error" ? "info" : "check", 14)}<span>${esc(message)}</span>`;
  toastRoot.appendChild(el);
  window.setTimeout(() => {
    el.classList.add("is-out");
    window.setTimeout(() => el.remove(), 280);
  }, 4200);
}

function messageFrom(e: unknown, fallback: string): string {
  if (typeof e === "string") return e;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

/* ————————————————— chart prefs / watchlist ————————————————— */

async function loadChartPrefs(): Promise<void> {
  try {
    state.chartPrefs = await api.getChartPrefs();
  } catch {
    /* defaults are fine */
  }
  if (state.view === "chart") {
    const tb = document.getElementById("chart-toolbar");
    if (tb) tb.innerHTML = renderChartToolbar();
    chart?.setConfig(state.chartPrefs);
    const note = document.querySelector<HTMLElement>(".chart-footnote span:last-child");
    if (note) note.textContent = indicatorSummary(state.chartPrefs);
  }
}

async function loadWatchlist(): Promise<void> {
  try {
    const groups = await api.getWatchGroups();
    state.watchGroups = groups;
    if (!state.watchGroupId || !groups.some((g) => g.id === state.watchGroupId)) {
      state.watchGroupId = groups[0]?.id ?? null;
    }
  } catch {
    /* keep previous */
  }
  updateWatchPanel();
}

function updateWatchPanel(): void {
  const old = document.querySelector<HTMLElement>(".watch-panel");
  if (!old) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = renderWatchPanel();
  old.replaceWith(tmp.firstElementChild!);
}

function watchStockFromSelection(sel: ChartSelection): WatchStock {
  const market = sel.market || (sel.code.startsWith("6") ? "1" : "0");
  return { code: sel.code, name: sel.name, market };
}

async function openWatchAddDialog(inputStocks: WatchStock[], title: string): Promise<void> {
  if (!inputStocks.length) {
    toast("没有可以加入的股票");
    return;
  }
  if (!state.watchGroups.length) await loadWatchlist();
  if (!state.watchGroups.length) {
    toast("请先新建一个自选分组", "error");
    return;
  }
  closeOverlay();
  overlayKind = "watch-add";
  const seen = new Set<string>();
  const stocks = inputStocks.filter((s) => {
    if (!s.code || seen.has(s.code)) return false;
    seen.add(s.code);
    return true;
  });
  const first = state.watchGroups.find((g) => g.id === state.watchGroupId) ?? state.watchGroups[0];
  overlayRoot.innerHTML = `<div class="overlay modal-overlay" id="watch-add-overlay">
    <div class="overlay-panel small-modal" role="dialog" aria-label="加入自选">
      <div class="modal-head">
        <div><h2>加入自选</h2><p>${esc(title)} · ${stocks.length} 只</p></div>
        <button class="modal-close" data-close-add aria-label="关闭">${icon("close", 15)}</button>
      </div>
      <div class="modal-body">
        <div class="setting-label">选择分组</div>
        <div class="group-picker">
          ${state.watchGroups
            .map(
              (g) => `<label class="group-option">
                <input type="radio" name="watch-target" value="${g.id}" ${g.id === first.id ? "checked" : ""} />
                <span class="group-radio"></span>
                <span class="group-option-name">${esc(g.name)}</span>
                <span class="group-option-count">${g.stocks.length} 只</span>
              </label>`,
            )
            .join("")}
        </div>
        <p class="modal-hint">同一分组内会自动去重；一只股票可以加入多个分组。</p>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close-add>取消</button>
        <button class="btn primary" id="watch-add-confirm">加入</button>
      </div>
    </div>
  </div>`;
  const overlay = document.getElementById("watch-add-overlay")!;
  const close = () => closeOverlay();
  overlay.querySelectorAll<HTMLElement>("[data-close-add]").forEach((b) => b.addEventListener("click", close));
  overlay.addEventListener("mousedown", (ev) => {
    if (ev.target === overlay) close();
  });
  overlay.querySelector<HTMLElement>("#watch-add-confirm")?.addEventListener("click", async () => {
    const selected = overlay.querySelector<HTMLInputElement>("input[name='watch-target']:checked");
    if (!selected) {
      toast("请选择分组");
      return;
    }
    const btn = overlay.querySelector<HTMLButtonElement>("#watch-add-confirm")!;
    btn.disabled = true;
    btn.textContent = "加入中";
    try {
      const result = await api.addWatchStocks(Number(selected.value), stocks);
      closeOverlay();
      await loadWatchlist();
      const skipped = result.skipped > 0 ? `，跳过 ${result.skipped} 只重复` : "";
      toast(`已加入 ${result.added} 只${skipped}`);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "加入";
      toast(messageFrom(e, "加入自选失败"), "error");
    }
  });
}

function openGroupDialog(mode: "create" | "rename"): void {
  const active = state.watchGroups.find((g) => g.id === state.watchGroupId);
  if (mode === "rename" && !active) return;
  closeOverlay();
  overlayKind = "group-dialog";
  const title = mode === "create" ? "新建分组" : "重命名分组";
  overlayRoot.innerHTML = `<div class="overlay modal-overlay" id="group-dialog-overlay">
    <div class="overlay-panel small-modal" role="dialog" aria-label="${title}">
      <div class="modal-head">
        <div><h2>${title}</h2><p>名称最多 20 个字</p></div>
        <button class="modal-close" data-close-group aria-label="关闭">${icon("close", 15)}</button>
      </div>
      <div class="modal-body">
        <input class="text-input" id="group-name-input" maxlength="20" placeholder="例如：核心观察" value="${mode === "rename" && active ? esc(active.name) : ""}" />
      </div>
      <div class="modal-foot">
        <button class="btn" data-close-group>取消</button>
        <button class="btn primary" id="group-confirm">${mode === "create" ? "新建" : "保存"}</button>
      </div>
    </div>
  </div>`;
  const overlay = document.getElementById("group-dialog-overlay")!;
  const input = overlay.querySelector<HTMLInputElement>("#group-name-input")!;
  overlay.querySelectorAll<HTMLElement>("[data-close-group]").forEach((b) => b.addEventListener("click", closeOverlay));
  overlay.addEventListener("mousedown", (ev) => {
    if (ev.target === overlay) closeOverlay();
  });
  const submit = async () => {
    const name = input.value.trim();
    if (!name) {
      toast("请输入分组名称");
      input.focus();
      return;
    }
    const btn = overlay.querySelector<HTMLButtonElement>("#group-confirm")!;
    btn.disabled = true;
    try {
      if (mode === "create") {
        const id = await api.createWatchGroup(name);
        state.watchGroupId = id;
      } else if (active) {
        await api.renameWatchGroup(active.id, name);
      }
      closeOverlay();
      await loadWatchlist();
      toast(mode === "create" ? "分组已创建" : "分组已重命名");
    } catch (e) {
      btn.disabled = false;
      toast(messageFrom(e, "保存失败"), "error");
    }
  };
  overlay.querySelector("#group-confirm")?.addEventListener("click", submit);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") void submit();
  });
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function openGroupDelete(): void {
  const active = state.watchGroups.find((g) => g.id === state.watchGroupId);
  if (!active) return;
  closeOverlay();
  overlayKind = "group-delete";
  overlayRoot.innerHTML = `<div class="overlay modal-overlay" id="group-delete-overlay">
    <div class="overlay-panel small-modal" role="dialog" aria-label="删除分组">
      <div class="modal-head">
        <div><h2>删除分组</h2><p>此操作不可撤销</p></div>
        <button class="modal-close" data-close-delete aria-label="关闭">${icon("close", 15)}</button>
      </div>
      <div class="modal-body">
        <p class="confirm-text">确定删除「<b>${esc(active.name)}</b>」？分组内的 ${active.stocks.length} 只股票会从该分组移除，但不影响其他分组。</p>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close-delete>取消</button>
        <button class="btn danger" id="group-delete-confirm">确认删除</button>
      </div>
    </div>
  </div>`;
  const overlay = document.getElementById("group-delete-overlay")!;
  overlay.querySelectorAll<HTMLElement>("[data-close-delete]").forEach((b) => b.addEventListener("click", closeOverlay));
  overlay.addEventListener("mousedown", (ev) => {
    if (ev.target === overlay) closeOverlay();
  });
  overlay.querySelector("#group-delete-confirm")?.addEventListener("click", async () => {
    try {
      await api.deleteWatchGroup(active.id);
      state.watchGroupId = null;
      closeOverlay();
      await loadWatchlist();
      toast("分组已删除");
    } catch (e) {
      toast(messageFrom(e, "删除失败"), "error");
    }
  });
}

function openIndicatorSettings(): void {
  const p = state.chartPrefs;
  closeOverlay();
  overlayKind = "indicator";
  overlayRoot.innerHTML = `<div class="overlay modal-overlay" id="indicator-overlay">
    <div class="overlay-panel indicator-modal" role="dialog" aria-label="指标参数">
      <div class="modal-head">
        <div><h2>指标参数</h2><p>MA / EMA / KDJ · 修改后立即应用到当前 K 线</p></div>
        <button class="modal-close" data-close-indicator aria-label="关闭">${icon("close", 15)}</button>
      </div>
      <div class="modal-body">
        <div class="indicator-group">
          <label class="indicator-switch"><input type="checkbox" id="pref-ma" ${p.maEnabled ? "checked" : ""} /><span></span><b>MA</b><em>简单移动平均</em></label>
          <input class="text-input mono" id="pref-ma-periods" value="${p.maPeriods.join(", ")}" placeholder="5, 10, 20, 60" />
        </div>
        <div class="indicator-group">
          <label class="indicator-switch"><input type="checkbox" id="pref-ema" ${p.emaEnabled ? "checked" : ""} /><span></span><b>EMA</b><em>指数移动平均</em></label>
          <input class="text-input mono" id="pref-ema-periods" value="${p.emaPeriods.join(", ")}" placeholder="5, 10, 20, 60" />
        </div>
        <div class="indicator-group kdj-row">
          <label class="indicator-switch"><input type="checkbox" id="pref-kdj" ${p.kdjEnabled ? "checked" : ""} /><span></span><b>KDJ</b><em>随机指标</em></label>
          <div class="kdj-inputs">
            <label>N <input class="text-input mono" id="pref-kdj-n" type="number" min="2" max="90" value="${p.kdjN}" /></label>
            <label>K <input class="text-input mono" id="pref-kdj-k" type="number" min="1" max="20" value="${p.kdjK}" /></label>
            <label>D <input class="text-input mono" id="pref-kdj-d" type="number" min="1" max="20" value="${p.kdjD}" /></label>
          </div>
        </div>
        <p class="modal-hint">周期写为逗号分隔数字，例如 5, 10, 20, 60；最多 4 条。参数保存在本地数据库。</p>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close-indicator>取消</button>
        <button class="btn primary" id="indicator-apply">应用</button>
      </div>
    </div>
  </div>`;
  const overlay = document.getElementById("indicator-overlay")!;
  overlay.querySelectorAll<HTMLElement>("[data-close-indicator]").forEach((b) => b.addEventListener("click", closeOverlay));
  overlay.addEventListener("mousedown", (ev) => {
    if (ev.target === overlay) closeOverlay();
  });
  overlay.querySelector("#indicator-apply")?.addEventListener("click", async () => {
    const parsePeriods = (id: string) => {
      const el = overlay.querySelector<HTMLInputElement>(id)!;
      const values = el.value
        .split(/[,\s，]+/)
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v >= 2 && v <= 250);
      return [...new Set(values)].slice(0, 4);
    };
    const maPeriods = parsePeriods("#pref-ma-periods");
    const emaPeriods = parsePeriods("#pref-ema-periods");
    const maEnabled = overlay.querySelector<HTMLInputElement>("#pref-ma")!.checked;
    const emaEnabled = overlay.querySelector<HTMLInputElement>("#pref-ema")!.checked;
    if (maEnabled && !maPeriods.length) return toast("MA 周期至少填写一个 2–250 的数字", "error");
    if (emaEnabled && !emaPeriods.length) return toast("EMA 周期至少填写一个 2–250 的数字", "error");
    const kdjN = Number(overlay.querySelector<HTMLInputElement>("#pref-kdj-n")!.value);
    const kdjK = Number(overlay.querySelector<HTMLInputElement>("#pref-kdj-k")!.value);
    const kdjD = Number(overlay.querySelector<HTMLInputElement>("#pref-kdj-d")!.value);
    const next: ChartPrefs = {
      maEnabled,
      maPeriods: maPeriods.length ? maPeriods : p.maPeriods,
      emaEnabled,
      emaPeriods: emaPeriods.length ? emaPeriods : p.emaPeriods,
      kdjEnabled: overlay.querySelector<HTMLInputElement>("#pref-kdj")!.checked,
      kdjN: Number.isFinite(kdjN) ? Math.max(2, Math.min(90, Math.round(kdjN))) : 9,
      kdjK: Number.isFinite(kdjK) ? Math.max(1, Math.min(20, Math.round(kdjK))) : 3,
      kdjD: Number.isFinite(kdjD) ? Math.max(1, Math.min(20, Math.round(kdjD))) : 3,
    };
    state.chartPrefs = next;
    chart?.setConfig(next);
    const tb = document.getElementById("chart-toolbar");
    if (tb) tb.innerHTML = renderChartToolbar();
    const note = document.querySelector<HTMLElement>(".chart-footnote span:last-child");
    if (note) note.textContent = indicatorSummary(next);
    closeOverlay();
    try {
      await api.saveChartPrefs(next);
      toast("指标参数已应用");
    } catch (e) {
      toast(messageFrom(e, "指标参数保存失败"), "error");
    }
  });
}

function handleContextMenu(e: MouseEvent): void {
  if (overlayKind) return;
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-stock-code]");
  if (!el) return;
  e.preventDefault();
  const code = el.dataset.stockCode!;
  const name = el.dataset.stockName || code;
  const currentGroupId = Number(el.dataset.watchGroup || state.watchGroupId || 0);
  const stock = watchStockFromSelection({ code, name, market: "", kind: "stock" });
  closeOverlay();
  overlayKind = "context";
  const groups = state.watchGroups
    .map((g) => {
      const member = g.stocks.some((s) => s.code === code);
      return `<button class="context-item ${member ? "is-member" : ""}" data-context-group="${g.id}" ${member ? "disabled" : ""}>
        <span>${esc(g.name)}</span><em>${member ? "已在" : "加入"}</em>
      </button>`;
    })
    .join("");
  const inActive = state.watchGroups.find((g) => g.id === currentGroupId)?.stocks.some((s) => s.code === code);
  overlayRoot.innerHTML = `<div class="context-layer" id="context-layer">
    <div class="context-menu" style="left:0;top:0">
      <div class="context-head"><b>${esc(name)}</b><span>${code}</span></div>
      <div class="context-label">分配到分组</div>
      <div class="context-groups">${groups || `<div class="context-empty">还没有分组</div>`}</div>
      <div class="context-sep"></div>
      <button class="context-item" data-context-create>${icon("plus", 12)} 新建分组</button>
      ${inActive && currentGroupId ? `<button class="context-item danger" data-context-remove="${currentGroupId}">从当前分组移除</button>` : ""}
    </div>
  </div>`;
  const layer = document.getElementById("context-layer")!;
  const menu = layer.querySelector<HTMLElement>(".context-menu")!;
  const w = menu.offsetWidth || 210;
  const h = menu.offsetHeight || 250;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, e.clientX))}px`;
  menu.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, e.clientY))}px`;
  layer.addEventListener("mousedown", (ev) => {
    if (ev.target === layer) closeOverlay();
  });
  layer.querySelectorAll<HTMLElement>("[data-context-group]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.hasAttribute("disabled")) return;
      try {
        const groupId = Number(btn.dataset.contextGroup);
        const result = await api.addWatchStocks(groupId, [stock]);
        closeOverlay();
        await loadWatchlist();
        toast(result.added ? "已加入分组" : "该分组已包含此股票");
      } catch (err) {
        toast(messageFrom(err, "操作失败"), "error");
      }
    });
  });
  layer.querySelector("[data-context-create]")?.addEventListener("click", () => {
    closeOverlay();
    openGroupDialog("create");
  });
  layer.querySelector<HTMLElement>("[data-context-remove]")?.addEventListener("click", async (ev) => {
    const groupId = Number((ev.currentTarget as HTMLElement).dataset.contextRemove);
    try {
      await api.removeWatchStock(groupId, code);
      closeOverlay();
      await loadWatchlist();
      toast("已从分组移除");
    } catch (err) {
      toast(messageFrom(err, "移除失败"), "error");
    }
  });
}

/* ————————————————— overlays ————————————————— */

function closeOverlay(): void {
  if (!overlayKind) return;
  overlayKind = null;
  state.searchOpen = false;
  state.settingsOpen = false;
  if (overlayRoot) overlayRoot.innerHTML = "";
}

function openSearch(): void {
  closeOverlay();
  overlayKind = "search";
  state.searchOpen = true;
  let items: SearchItem[] = [];
  let active = 0;
  let query = "";
  let seq = 0;
  let loading = false;

  overlayRoot.innerHTML = `<div class="overlay" id="search-overlay">
    <div class="overlay-panel search-panel" role="dialog" aria-label="搜索股票">
      <div class="search-row">
        ${icon("search", 19)}
        <input class="search-input" id="search-input" type="text" placeholder="搜索代码、名称或拼音首字母" autocomplete="off" spellcheck="false" />
        <span class="search-esc">ESC</span>
      </div>
      <div class="search-results" id="search-results"></div>
      <div class="search-foot">
        <span class="keyhint"><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span class="keyhint"><kbd>↵</kbd> 打开K线</span>
        <span class="spacer"></span>
        <span>实时行情来自东方财富</span>
      </div>
    </div>
  </div>`;
  const overlay = document.getElementById("search-overlay")!;
  const input = document.getElementById("search-input") as HTMLInputElement;
  const results = document.getElementById("search-results")!;

  const renderResults = () => {
    if (!query) {
      const recent = items;
      if (!recent.length) {
        results.innerHTML = `<div class="search-empty"><b>搜索一只股票</b>输入代码或公司名称，查看 K 线、EMA 与 KDJ。<br /><kbd>Ctrl</kbd> + <kbd>K</kbd> 随时呼出</div>`;
        return;
      }
      results.innerHTML = `<div class="search-section-label">最近查看</div>${recent
        .map(
          (it, i) => `<button class="search-item ${i === active ? "active" : ""}" data-search-index="${i}">
            <span class="search-item-code">${it.code}</span>
            <span class="search-item-name">${esc(it.name || "—")}</span>
            <span class="search-item-type">${esc(it.securityType || (it.code.startsWith("6") ? "沪A" : "深A"))}</span>
            ${icon("arrowUpRight", 14)}
          </button>`,
        )
        .join("")}`;
      return;
    }
    if (loading) {
      results.innerHTML = `<div class="search-empty"><b>正在检索</b>从行情服务取回匹配的股票。</div>`;
      return;
    }
    if (!items.length) {
      results.innerHTML = `<div class="search-empty"><b>没有匹配结果</b>换一个代码或名称试试。</div>`;
      return;
    }
    results.innerHTML = `<div class="search-section-label">搜索结果 · ${items.length}</div>${items
      .map(
        (it, i) => `<button class="search-item ${i === active ? "active" : ""}" data-search-index="${i}">
          <span class="search-item-code">${it.code}</span>
          <span class="search-item-name">${esc(it.name || "—")}</span>
          <span class="search-item-type">${esc(it.securityType || (it.code.startsWith("6") ? "沪A" : "深A"))}</span>
          ${icon("arrowUpRight", 14)}
        </button>`,
      )
      .join("")}`;
  };

  const pick = (index: number) => {
    const item = items[index];
    if (!item) return;
    closeOverlay();
    openChart(item.code, item.name, item.market);
  };

  const searchNow = () => {
    const q = input.value.trim();
    query = q;
    window.clearTimeout(searchTimer);
    if (!q) {
      loading = false;
      active = 0;
      void loadRecent();
      return;
    }
    loading = true;
    active = 0;
    const my = ++seq;
    renderResults();
    searchTimer = window.setTimeout(async () => {
      try {
        const res = await api.searchStocks(q);
        if (my !== seq || query !== q) return;
        items = res;
      } catch {
        if (my === seq) items = [];
      }
      loading = false;
      renderResults();
    }, 170);
  };

  const loadRecent = async () => {
    try {
      items = await api.recentStocks();
    } catch {
      items = [];
    }
    if (overlayKind !== "search" || query) return;
    active = 0;
    renderResults();
  };

  input.addEventListener("input", searchNow);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!items.length) return;
      active = (active + 1) % items.length;
      renderResults();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      active = (active - 1 + items.length) % items.length;
      renderResults();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!loading) pick(active);
    }
  });
  results.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-search-index]");
    if (!el) return;
    pick(Number(el.dataset.searchIndex));
  });
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeOverlay();
  });
  input.focus();
  renderResults();
  void loadRecent();
}

function openSettings(): void {
  closeOverlay();
  overlayKind = "settings";
  state.settingsOpen = true;
  overlayRoot.innerHTML = `<div class="overlay modal-overlay" id="settings-overlay">
    <div class="overlay-panel settings-panel" role="dialog" aria-label="设置">
      <div class="modal-head">
        <div><h2>设置</h2><p>外观、本地数据与缓存</p></div>
        <button class="modal-close" data-settings-close aria-label="关闭">${icon("close", 15)}</button>
      </div>
      <div class="modal-body">
        <div class="setting-section">
          <div class="setting-label">外观</div>
          <div class="theme-choice">
            <button class="theme-option ${state.theme === "dark" ? "active" : ""}" data-theme-choice="dark">${icon("moon", 15)} 深色 · 墨夜</button>
            <button class="theme-option ${state.theme === "light" ? "active" : ""}" data-theme-choice="light">${icon("sun", 15)} 浅色 · 宣纸</button>
          </div>
        </div>
        <div class="setting-section">
          <div class="setting-label">本地数据</div>
          <div class="data-path" id="data-path">正在读取…</div>
          <div class="data-grid">
            <div class="data-cell"><label>交易日</label><span id="data-days">—</span></div>
            <div class="data-cell"><label>K线记录</label><span id="data-klines">—</span></div>
            <div class="data-cell"><label>数据库</label><span id="data-size">—</span></div>
          </div>
          <div class="setting-row" style="margin-top:10px">
            <button class="btn-quiet" data-open-data>${icon("folder", 13)} 打开数据目录</button>
            <button class="btn-quiet danger" data-clear-cache>${icon("trash", 13)} 清理行情缓存</button>
            <span class="setting-hint">行情与K线均写入本地 SQLite，不含 JSON 文件。</span>
          </div>
          <div class="clear-confirm" id="clear-confirm" hidden>
            <span>将删除本地涨停与K线缓存，设置保留。确定继续？</span>
            <span class="spacer"></span>
            <button class="btn-quiet" data-clear-cancel>取消</button>
            <button class="btn-quiet danger" data-clear-confirm>清理</button>
          </div>
        </div>
        <div class="setting-section">
          <div class="setting-label">关于</div>
          <div class="about-text">
            天梯 · A股涨停复盘　<b>v1.0</b><br />
            涨停与板块数据来自同花顺公开接口，K线来自东方财富公开接口。<br />
            所有数据仅用于学习复盘，不构成投资建议。快捷键：<b>Ctrl K</b> 搜索，<b>← →</b> 切换交易日，<b>Esc</b> 关闭浮层。
          </div>
        </div>
      </div>
      <div class="modal-foot"><button class="btn" data-settings-close>完成</button></div>
    </div>
  </div>`;
  const overlay = document.getElementById("settings-overlay")!;
  const confirmBox = document.getElementById("clear-confirm") as HTMLElement;
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeOverlay();
  });
  overlay.querySelectorAll<HTMLElement>("[data-settings-close]").forEach((btn) =>
    btn.addEventListener("click", closeOverlay),
  );
  overlay.querySelectorAll<HTMLElement>("[data-theme-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const theme = btn.dataset.themeChoice as Theme;
      applyTheme(theme);
      overlay.querySelectorAll<HTMLElement>("[data-theme-choice]").forEach((b) => {
        b.classList.toggle("active", b.dataset.themeChoice === theme);
      });
    });
  });
  overlay.querySelector("[data-open-data]")?.addEventListener("click", () => {
    void api.openDataDir().catch(() => toast("无法打开数据目录", "error"));
  });
  overlay.querySelector("[data-clear-cache]")?.addEventListener("click", () => {
    confirmBox.hidden = false;
  });
  overlay.querySelector("[data-clear-cancel]")?.addEventListener("click", () => {
    confirmBox.hidden = true;
  });
  overlay.querySelector("[data-clear-confirm]")?.addEventListener("click", async () => {
    const btn = overlay.querySelector<HTMLElement>("[data-clear-confirm]")!;
    btn.textContent = "清理中";
    try {
      await api.clearCache();
      state.day = null;
      state.chartData = null;
      closeOverlay();
      toast("行情缓存已清理");
      if (state.view === "chart") navigate("ladder");
      await loadDay(state.date, true);
    } catch (e) {
      btn.textContent = "清理";
      toast(messageFrom(e, "清理失败"), "error");
    }
  });

  void api
    .getDataInfo()
    .then((info) => {
      state.dataInfo = info;
      const path = document.getElementById("data-path");
      if (path) path.textContent = info.dataDir;
      const days = document.getElementById("data-days");
      if (days) days.textContent = `${info.dayCount} 天`;
      const kl = document.getElementById("data-klines");
      if (kl) kl.textContent = info.klineCount.toLocaleString("zh-CN");
      const size = document.getElementById("data-size");
      if (size) size.textContent = fmtBytes(info.dbBytes);
    })
    .catch(() => {
      const path = document.getElementById("data-path");
      if (path) path.textContent = "数据目录读取失败";
    });
}

function openDateMenu(): void {
  closeOverlay();
  overlayKind = "date";
  const trigger = document.querySelector<HTMLElement>(".date-trigger");
  if (!trigger) return;
  const dates = availableDates();
  const current = state.date;
  const today = state.calendar?.today;
  const rect = trigger.getBoundingClientRect();
  overlayRoot.innerHTML = `<div class="popover-layer" id="date-overlay">
    <div class="date-popover" style="top:${Math.round(rect.bottom + 8)}px;left:${Math.round(rect.left)}px" role="dialog" aria-label="选择交易日">
      <div class="date-popover-head"><span>交易日 ${dates.length ? `· ${dates.length} 天` : ""}</span>${dates.length ? `<button class="date-latest" data-latest-date>最新</button>` : ""}</div>
      ${
        dates.length
          ? dates
              .map(
                (d) => `<button class="date-option ${d === current ? "active" : ""}" data-date="${d}">
                  <span class="ymd">${fmtShortDate(d)}</span>
                  <span>${weekdayFromYmd(d)}</span>
                  ${d === today ? `<span class="today-mark">今天</span>` : ""}
                  <span class="weekday">${d.slice(0, 4)}</span>
                </button>`,
              )
              .join("")
          : `<div class="search-empty"><b>交易日历未就绪</b>重新连接后即可选择日期。<br /><button class="btn-quiet" data-action="refresh-calendar" style="margin-top:8px">重新连接</button></div>`
      }
    </div>
  </div>`;
  const layer = document.getElementById("date-overlay")!;
  const pop = layer.querySelector<HTMLElement>(".date-popover")!;
  const maxLeft = window.innerWidth - 248;
  if (parseFloat(pop.style.left) > maxLeft) pop.style.left = `${Math.max(10, maxLeft)}px`;
  const popRect = pop.getBoundingClientRect();
  if (popRect.bottom > window.innerHeight - 12) {
    pop.style.top = `${Math.max(10, window.innerHeight - popRect.height - 12)}px`;
  }
  layer.addEventListener("mousedown", (e) => {
    if (e.target === layer) closeOverlay();
  });
  pop.querySelectorAll<HTMLElement>("[data-date]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = btn.dataset.date!;
      closeOverlay();
      changeDate(d);
    });
  });
  pop.querySelector("[data-latest-date]")?.addEventListener("click", () => {
    const latest = state.calendar?.initialDate;
    closeOverlay();
    changeDate(latest);
  });
  pop.querySelector("[data-action='refresh-calendar']")?.addEventListener("click", async () => {
    closeOverlay();
    try {
      const cal = await api.getCalendar(true);
      state.calendar = cal;
      toast("交易日历已更新");
      renderMain();
    } catch {
      toast("交易日历仍未连接", "error");
    }
  });
  requestAnimationFrame(() => {
    const active = pop.querySelector<HTMLElement>(".date-option.active");
    if (active) pop.scrollTop = Math.max(0, active.offsetTop - pop.clientHeight / 2);
  });
}

/* ————————————————— start ————————————————— */

boot();
