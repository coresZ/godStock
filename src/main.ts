import "./styles.css";
import { api } from "./lib/api";
import { availableDates, neighbors, parseHash, state } from "./lib/state";
import type { SearchItem, Theme } from "./lib/types";
import { esc, fmtBytes, fmtShortDate, icon, relTime, weekdayFromYmd } from "./lib/ui";
import { KLineChart } from "./chart";
import { renderChartView } from "./views/chart";
import { renderIndices, renderRail, renderTitlebar, syncLabel } from "./views/common";
import { renderLadder } from "./views/ladder";
import { renderPool, updatePoolTable } from "./views/pool";

let chart: KLineChart | null = null;
let dayToken = 0;
let chartToken = 0;
let overlayKind: "search" | "settings" | "date" | null = null;
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

  const route = parseHash();
  state.view = route.view;
  state.returnView = route.view === "chart" ? "ladder" : route.view;
  if (route.code) {
    state.chartStock = { code: route.code, name: "", market: "" };
    state.chartLoading = true;
  }

  renderShell();
  bindGlobals();
  booted = true;

  void loadIndices(false);
  await ensureCalendar();
  if (state.date) await loadDay(state.date, true);
  if (state.view === "chart" && state.chartStock) {
    await loadChart(state.chartStock.code);
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
    chart?.redraw();
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
  const suffix = state.view === "chart" && state.chartStock ? `/${state.chartStock.code}` : "";
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

function navigate(view: "ladder" | "pool" | "chart"): void {
  if (view === "chart") {
    if (!state.chartStock) {
      openSearch();
      return;
    }
    state.view = "chart";
    syncHash();
    renderMain();
    updateChrome();
    if (!state.chartData && !state.chartLoading) void loadChart(state.chartStock.code);
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
  state.chartStock = { code, name, market };
  state.view = "chart";
  state.chartData = null;
  state.chartError = null;
  state.chartLoading = true;
  syncHash();
  renderMain();
  void loadChart(code);
}

function chartBack(): void {
  const back = state.returnView === "chart" ? "ladder" : state.returnView;
  state.view = back;
  syncHash();
  renderMain();
  updateChrome();
}

async function loadChart(code: string): Promise<void> {
  const token = ++chartToken;
  const period = state.chartPeriod;
  state.chartLoading = true;
  state.chartError = null;
  renderMain();
  try {
    const data = await api.getKline(code, period, false);
    if (token !== chartToken) return;
    state.chartData = data;
    state.chartLoading = false;
    if (state.chartStock && !state.chartStock.name && data.name) state.chartStock.name = data.name;
    renderMain();
    if (data.source === "cache") void refreshChart(token);
  } catch (e) {
    if (token !== chartToken) return;
    state.chartLoading = false;
    state.chartError = messageFrom(e, "K线加载失败");
    renderMain();
  }
}

async function refreshChart(token: number): Promise<void> {
  const stock = state.chartStock;
  if (!stock) return;
  const period = state.chartPeriod;
  try {
    const data = await api.getKline(stock.code, period, true);
    if (token !== chartToken) return;
    const old = state.chartData;
    const changed =
      !old ||
      old.candles.length !== data.candles.length ||
      old.latestDate !== data.latestDate ||
      old.candles[old.candles.length - 1]?.close !== data.candles[data.candles.length - 1]?.close;
    state.chartData = data;
    if (changed) renderMain();
    if (data.warning) toast(data.warning, "error");
  } catch {
    /* cache remains usable */
  }
}

function renderMain(): void {
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
  else if (state.view === "chart") html = renderChartView();
  else html = renderLadder();
  main.innerHTML = html;
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
    showEma: state.chartEma,
    showKdj: state.chartKdj,
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
  document.querySelector(".titlebar-drag")?.addEventListener("dblclick", () => {
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
    renderMain();
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
    navigate(nav.dataset.nav as "ladder" | "pool" | "chart");
    return;
  }
  const periodBtn = target.closest<HTMLElement>("[data-chart-period]");
  if (periodBtn) {
    const p = periodBtn.dataset.chartPeriod as "day" | "week" | "month";
    if (p !== state.chartPeriod) {
      state.chartPeriod = p;
      state.chartData = null;
      state.chartLoading = true;
      renderMain();
      if (state.chartStock) void loadChart(state.chartStock.code);
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
    if (key === "ema") state.chartEma = !state.chartEma;
    if (key === "kdj") state.chartKdj = !state.chartKdj;
    indicator.classList.toggle("active", key === "ema" ? state.chartEma : state.chartKdj);
    indicator.setAttribute("aria-pressed", String(key === "ema" ? state.chartEma : state.chartKdj));
    chart?.setOptions({ showEma: state.chartEma, showKdj: state.chartKdj });
    return;
  }
  const sort = target.closest<HTMLElement>("[data-sort]");
  if (sort) {
    const key = sort.dataset.sort as typeof state.poolSort.key;
    if (state.poolSort.key === key) state.poolSort.dir = state.poolSort.dir === 1 ? -1 : 1;
    else state.poolSort = { key, dir: key === "name" ? 1 : -1 };
    renderMain();
    return;
  }
  const stockEl = target.closest<HTMLElement>("[data-stock-code]");
  if (stockEl) {
    const code = stockEl.dataset.stockCode!;
    const name = stockEl.dataset.stockName || "";
    openChart(code, name);
    return;
  }
  const sector = target.closest<HTMLElement>("[data-sector-code]");
  if (sector) {
    state.poolSector = sector.dataset.sectorCode || "";
    state.view = "pool";
    syncHash();
    renderMain();
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
      renderMain();
      break;
    case "pool-clear-sector":
      state.poolSector = "";
      renderMain();
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
      if (state.chartStock) {
        state.chartData = null;
        void loadChart(state.chartStock.code);
      }
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
