import "./styles.css";
import { api } from "./lib/api";
import { closeDropdown, initDropdowns } from "./lib/dropdown";
import { availableDates, filterStocks, findStock, neighbors, parseHash, state } from "./lib/state";
import type { ChartPrefs, ChartSelection, KlineCandle, OtherTab, Period, SearchItem, StrategyProfile, StrategyStage, StrategyTab, Theme, ViewName, WatchStock } from "./lib/types";
import { esc, fmtBytes, fmtClock, fmtMoney, fmtPct, fmtPrice, fmtShortDate, icon, pctToneClass, relTime, tierName, weekdayFromYmd } from "./lib/ui";
import { KLineChart } from "./chart";
import { TimeShareChart } from "./timeshare";
import { chartSwitchContext, indicatorSummary, normalizeChartRange, renderChartDock, renderChartHead, renderChartToolbar, renderChartView, updateChartDock } from "./views/chart";
import { renderIndices, renderRail, renderTitlebar, syncLabel } from "./views/common";
import { renderLadder } from "./views/ladder";
import { renderOther, sortedLhbBoard, updateOtherStage } from "./views/other";
import { renderPool, updatePoolStage, updatePoolTable } from "./views/pool";
import { renderStrategy, renderStrategyStage, updateStrategyStage } from "./views/strategy";
import { renderTimeline, timelineExportText } from "./views/timeline";

let chart: KLineChart | null = null;
let timeShareChart: TimeShareChart | null = null;
let intradayChart: TimeShareChart | null = null;
let intradayToken = 0;
let intradayIndex = 0;
let dayToken = 0;
let chartToken = 0;
let indicesLoading = false;
let watchQuoteLoading = false;
let timeshareRefreshing = false;
let lastDayAutoRefresh = 0;
let lastChartAutoRefresh = 0;
let strategyEnsuring = false;
let lhbEnsuring = false;
/** 首次加载还在进行时又切了日期：完成后补拉当前日期，避免丢请求。 */
let lhbPending = false;
let lhbSeatToken = 0;
let historyUnlisten: (() => void) | null = null;

type HistoryProgress = { done: number; total: number; current: string };
let overlayKind:
  | "search"
  | "settings"
  | "date"
  | "watch-add"
  | "group-dialog"
  | "group-delete"
  | "indicator"
  | "intraday"
  | "context"
  | null = null;
let overlayRoot!: HTMLElement;
let toastRoot!: HTMLElement;
let stockHover!: HTMLElement;
let hoverAnchor: { left: number; top: number; width: number; height: number; bottom: number } | null = null;
let searchTimer: number | undefined;
let booted = false;

const localToday = (): string => {
  // Exchange date is UTC+8; never derive it from the machine timezone.
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};

/* ————————————————— boot ————————————————— */

function boot(): void {
  const app = document.getElementById("app")!;
  // index.html ships a static boot card so the first paint is branded even
  // before this module is parsed. Only synthesize one when running from a bare
  // document (tests, older shells).
  if (!app.querySelector(".boot")) {
    app.innerHTML = `<div class="boot">
      <img src="./mark.svg" alt="" class="boot-mark" />
      <div class="boot-word">天梯</div>
      <div class="boot-sub">A股涨停复盘</div>
      <div class="boot-line"><span></span></div>
    </div>`;
  }
  // The native splash retires when the shell is mounted; the timeout is a
  // last-resort escape hatch if start() fails before renderShell().
  window.setTimeout(notifyReady, 9000);
  void start();
}

function notifyReady(): void {
  void api.appReady().catch(() => {
    /* browser preview has no native splash */
  });
}

function nextPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      requestAnimationFrame(() => requestAnimationFrame(finish));
    } catch {
      /* ignore */
    }
    // WebView2 may throttle rAF while a window is occluded by the splash.
    window.setTimeout(finish, 280);
  });
}

async function start(): Promise<void> {
  try {
    const settings = await api.getSettings();
    state.theme = settings.theme === "light" ? "light" : "dark";
    state.uiScale = Math.max(0.9, Math.min(1.25, Number(settings.uiScale) || 1.10));
  } catch {
    state.theme = "dark";
    state.uiScale = 1.10;
  }
  try {
    await api.setUiScale(state.uiScale);
    // WebView2 的缩放会在下一帧才反映到布局宽度，等一次重排再挂载界面。
    await nextPaint();
  } catch {
    /* browser preview has no native zoom */
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

  initDropdowns();
  document.addEventListener("dd-change", (event) => {
    const trigger = event.target as HTMLElement;
    if (trigger.dataset.ddKind === "range") {
      applyChartRange(Number(trigger.dataset.value || "120"));
      return;
    }
    if (trigger.dataset.ddKind !== "sector") return;
    state.poolKind = "limitUp";
    state.poolSector = trigger.dataset.value || "";
    updatePoolStage();
  });
  renderShell();
  bindGlobals();
  listenHistoryProgress();
  window.addEventListener("resize", syncToolbarOverflow);
  booted = true;
  window.setTimeout(notifyReady, 60);

  void loadIndices(marketSessionOpen());
  window.setInterval(() => {
    if (document.hidden) return;
    // 休市期间只读缓存：指数 / 报价 / 自选报价都不再打网络。
    if (marketSessionOpen()) {
      void loadIndices(true);
      if (state.view === "chart" && state.chartStock) void loadChartQuote(chartToken);
      void refreshWatchQuotes();
    }
    autoRefreshTick();
    maybeAutoCaptureAuction();
  }, 20000);
  await ensureCalendar();
  if (state.date) await loadDay(state.date, true);
  if (state.view === "chart" && state.chartStock) {
    await loadChart();
  }
  if (state.view === "strategy") void ensureStrategy(true);
  if (state.view === "other") void ensureOther(true);
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
  <div id="stock-hover" class="stock-hover" hidden></div>
  <div id="toast-stack" class="toast-stack" aria-live="polite"></div>`;
  overlayRoot = document.getElementById("overlay-root")!;
  toastRoot = document.getElementById("toast-stack")!;
  stockHover = document.getElementById("stock-hover")!;
  renderMain();
  updateChrome();
}

/* ————————————————— theme / chrome ————————————————— */

function applyTheme(theme: Theme, persist = true): void {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("tianti.theme", theme);
  } catch {
    /* storage is optional */
  }
  if (persist) {
    void api.setTheme(theme).catch(() => toast("主题偏好未能保存", "error"));
  }
  if (booted) {
    replaceRail();
    if (chart) {
      chart.redraw();
      chart.setConfig(state.chartPrefs);
    }
    timeShareChart?.redraw();
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
    // 首屏的指数加载发生在拿到日历之前，无法判断「缓存是否落后」；日历就绪后再校一次。
    void loadIndices(false);
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
    state.screen = null;
    state.screenError = null;
    state.auction = null;
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
    // 休市 / 过去日期只读缓存：数据已定稿，不再后台补刷网络。
    if (day.source !== "network" && shouldRefreshLive()) void refreshDay(date, token, true);
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
  if (!quiet) {
    state.sync = "loading";
    updateChrome();
    document.querySelectorAll<HTMLElement>(".section-note").forEach((el) => {
      el.innerHTML = `${icon("refresh", 13)}同步中`;
    });
  }
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
    // Background refresh must not replay the ladder entrance choreography.
    renderMain({ animate: false });
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
  if (indicesLoading) return;
  indicesLoading = true;
  let wantRefresh = false;
  try {
    const list = await api.getIndices(refreshing);
    if (list.length) {
      state.indices = list;
      updateIndicesDom();
      // 盘中照常刷新；休市启动时若缓存还停在上一次收盘，再补一次当天收盘。
      if (!refreshing && (marketSessionOpen() || indicesBehindSettled())) wantRefresh = true;
      return;
    }
    if (!refreshing) showIndicesUnavailable();
  } catch {
    if (!refreshing) showIndicesUnavailable();
  } finally {
    // 先释放 loading 标记，再补一次网络刷新（否则递归调用会被守卫吞掉）。
    indicesLoading = false;
    if (wantRefresh) void loadIndices(true);
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
  const task = loadDay(date);
  if (state.view === "strategy") void task.then(() => ensureStrategy(true));
  if (state.view === "other") void task.then(() => ensureOther(true));
}

/* ————————————————— routing ————————————————— */

function navigate(view: ViewName): void {
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
  state.strategyDetailCode = null;
  state.profileOpen = false;
  syncHash();
  renderMain();
  updateChrome();
  if (view === "strategy") void ensureStrategy();
  if (view === "other") void ensureOther();
}

/* ————————————————— strategy ————————————————— */

async function ensureStrategy(force = false): Promise<void> {
  if (state.view !== "strategy" || strategyEnsuring) return;
  strategyEnsuring = true;
  try {
    if (!state.profile) state.profile = await api.getStrategyProfile();
    state.history = await api.getHistoryStatus();
    updateStrategyStage();
    if ((state.history?.days ?? 0) >= 120 && (force || !state.screen || state.screen.date !== state.date)) {
      await runStrategyScreen();
    }
  } catch (e) {
    state.screenError = messageFrom(e, "策略配置加载失败");
    updateStrategyStage();
  } finally {
    strategyEnsuring = false;
  }
}

async function runStrategyScreen(refresh = false): Promise<void> {
  if (!state.date || state.screenLoading) return;
  state.screenLoading = true;
  state.screenError = null;
  updateStrategyStage();
  try {
    state.screen = await api.runFirstToSecond(state.date, refresh);
  } catch (e) {
    state.screenError = messageFrom(e, "策略筛选失败");
  } finally {
    state.screenLoading = false;
    updateStrategyStage();
  }
}

async function syncStrategyHistory(): Promise<void> {
  if (state.historyProgress) return;
  state.historyProgress = { done: 0, total: 250, current: "" };
  updateStrategyStage();
  try {
    state.history = await api.syncLimitHistory(250, false);
    toast("涨停历史已就绪");
    await runStrategyScreen();
  } catch (e) {
    toast(messageFrom(e, "历史回填失败"), "error");
  } finally {
    state.historyProgress = null;
    updateStrategyStage();
  }
}

async function loadStrategyAuction(): Promise<void> {
  if (state.auctionLoading) return;
  state.auctionLoading = true;
  updateStrategyStage();
  try {
    state.auction = await api.getAuction(state.date);
  } catch {
    /* The auction tab renders its own empty state. */
  } finally {
    state.auctionLoading = false;
    updateStrategyStage();
  }
}

async function captureStrategyAuction(): Promise<void> {
  if (state.auctionLoading) return;
  state.auctionLoading = true;
  updateStrategyStage();
  try {
    state.auction = await api.captureAuction(state.date);
    if (state.auction.captured) {
      toast(state.auction.inWindow ? "竞价快照已采集" : "已采集，但当前不在 09:25–09:30 窗口");
    } else {
      toast("没有可采集的竞价数据", "error");
    }
  } catch (e) {
    toast(messageFrom(e, "竞价采集失败"), "error");
  } finally {
    state.auctionLoading = false;
    updateStrategyStage();
  }
}

/** Snapshot the auction once, only while the strategy tab is watching it. */
function maybeAutoCaptureAuction(): void {
  if (state.view !== "strategy" || state.strategyTab !== "auction") return;
  if (state.auction?.captured || state.auctionLoading) return;
  if (state.date !== state.calendar?.today) return;
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const clock = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (clock >= 9 * 60 + 25 && clock <= 9 * 60 + 30) void captureStrategyAuction();
}

/* ————————————————— other · 游资动态 ————————————————— */

function onOtherView(): boolean {
  return state.view === "other";
}

/** 是否由左侧个股列表驱动的右侧明细（总榜 / 机构）。 */
function needsStockPanel(): boolean {
  return state.otherTab === "board" || state.otherTab === "org";
}

/** 让当前选中项落在本次加载的数据里；换日后旧选中项失效时回落到第一行。 */
function syncLhbSelection(): void {
  const board = state.lhbBoard;
  const agencies = state.lhbAgencies;
  const institutions = state.lhbInstitutions;
  if (needsStockPanel()) {
    const rows = state.otherTab === "org" ? institutions?.rows : sortedLhbBoard();
    if (!rows?.some((row) => row.code === state.lhbStock)) state.lhbStock = rows?.[0]?.code ?? "";
    return;
  }
  if (state.otherTab === "yyz") {
    if (!agencies?.hot.some((row) => row.tag === state.lhbTag)) state.lhbTag = agencies?.hot[0]?.tag ?? "";
    return;
  }
  if (!agencies?.rows.some((row) => row.id === state.lhbAgencyId)) state.lhbAgencyId = agencies?.rows[0]?.id ?? "";
}

/** 进入「其他」页 / 换日后拉取龙虎榜；force 时清空并重新请求。 */
async function ensureOther(force = false): Promise<void> {
  if (!onOtherView() || !state.date) return;
  if (lhbEnsuring) {
    // 已有一轮在跑：记下来，等它结束后按最新日期补一次。
    lhbPending = true;
    return;
  }
  if (!force && state.lhbBoard && state.lhbBoard.requestedDate === state.date) {
    syncLhbSelection();
    updateOtherStage();
    // 首屏只成功了一半（席位榜 / 机构榜失败）时，回到页面再补一次。
    if (!state.lhbAgencies || !state.lhbInstitutions) void loadLhbSecondary();
    return;
  }
  const targetDate = state.date;
  lhbEnsuring = true;
  state.lhbLoading = true;
  state.lhbError = null;
  state.lhbExtraError = null;
  if (force) {
    state.lhbBoard = null;
    state.lhbAgencies = null;
    state.lhbInstitutions = null;
    state.lhbDetail = null;
    state.lhbDetailKey = "";
    state.lhbSeatLog = null;
  }
  updateOtherStage();
  try {
    const board = await api.getLhbBoard(targetDate, force);
    if (!onOtherView()) return;
    if (state.date !== targetDate) {
      // 响应回来时日期已经变了：丢弃这份数据，交给 finally 补拉。
      lhbPending = true;
      return;
    }
    state.lhbBoard = board;
    state.lhbDate = board.date;
    // 默认选中「列表第一行」（按当前排序），避免右栏与左列对不上。
    if (!board.rows.some((row) => row.code === state.lhbStock)) state.lhbStock = sortedLhbBoard()[0]?.code ?? "";
    updateOtherStage();
    if (!board.rows.length) {
      state.lhbAgencies = null;
      state.lhbInstitutions = null;
      state.lhbDetail = null;
      state.lhbDetailKey = "";
      return;
    }
    await loadLhbSecondary(force);
  } catch (e) {
    if (!onOtherView()) return;
    state.lhbError = messageFrom(e, "龙虎榜数据加载失败");
    toast(state.lhbError, "error");
  } finally {
    lhbEnsuring = false;
    state.lhbLoading = false;
    if (onOtherView()) updateOtherStage();
    if (lhbPending) {
      lhbPending = false;
      if (onOtherView() && state.date !== targetDate) void ensureOther(true);
    }
  }
}

/** 席位榜 + 机构榜。两者互不阻塞：任一失败只记一条可重试的提示，不影响主榜与明细。 */
async function loadLhbSecondary(force = false): Promise<void> {
  const board = state.lhbBoard;
  if (!board || !board.rows.length || state.lhbSecondaryLoading) return;
  if (!force && state.lhbAgencies && state.lhbInstitutions) return;
  state.lhbSecondaryLoading = true;
  state.lhbExtraError = null;
  updateOtherStage();
  try {
    const [agencies, institutions] = await Promise.allSettled([
      api.getLhbAgencies(board.date, force),
      api.getLhbInstitutions(board.date, force),
    ]);
    // 期间换了日期或主榜：这份次要数据已经过期，直接丢弃。
    if (!onOtherView() || state.lhbBoard !== board) return;
    const failed: string[] = [];
    if (agencies.status === "fulfilled") state.lhbAgencies = agencies.value;
    else failed.push("席位榜");
    if (institutions.status === "fulfilled") state.lhbInstitutions = institutions.value;
    else failed.push("机构榜");
    state.lhbExtraError = failed.length ? `${failed.join(" / ")}读取失败，可点重试` : null;
    syncLhbSelection();
    updateOtherStage();
    if (needsStockPanel() && state.lhbStock) await loadLhbDetail(state.lhbStock);
  } finally {
    state.lhbSecondaryLoading = false;
    if (onOtherView()) updateOtherStage();
  }
}

/** 读取单只票的买卖席位明细，key 命中缓存则不重复请求。 */
async function loadLhbDetail(code: string): Promise<void> {
  if (!code || !state.lhbDate) return;
  const date = state.lhbDate;
  const key = `${date}|${code}`;
  if (state.lhbDetailKey === key && state.lhbDetail) return;
  state.lhbDetailLoading = true;
  updateOtherStage();
  try {
    const detail = await api.getLhbDetail(code, date);
    if (!onOtherView() || state.lhbStock !== code || state.lhbDate !== date) return;
    state.lhbDetail = detail;
    state.lhbDetailKey = key;
  } catch (e) {
    if (!onOtherView()) return;
    toast(messageFrom(e, "龙虎榜明细加载失败"), "error");
  } finally {
    state.lhbDetailLoading = false;
    if (onOtherView()) updateOtherStage();
  }
}

/** 读取单个营业部最近 30 天上榜记录（游资 / 席位两个页签共用）。 */
async function loadLhbSeatLog(seatId: string, seatName: string): Promise<void> {
  if (!seatId) return;
  const token = ++lhbSeatToken;
  state.lhbSeatLoading = true;
  state.lhbSeatName = seatName;
  state.lhbSeatLog = null;
  updateOtherStage();
  try {
    const log = await api.getLhbSeatLog(seatId, 30);
    if (!onOtherView() || token !== lhbSeatToken) return;
    state.lhbSeatLog = log;
  } catch (e) {
    if (!onOtherView() || token !== lhbSeatToken) return;
    toast(messageFrom(e, "营业部上榜记录加载失败"), "error");
  } finally {
    if (token === lhbSeatToken) {
      state.lhbSeatLoading = false;
      if (onOtherView()) updateOtherStage();
    }
  }
}

function selectLhbStock(code: string): void {
  if (!code) return;
  state.lhbStock = code;
  state.lhbSeatLog = null;
  updateOtherStage();
  void loadLhbDetail(code);
}

/** 策略面板：把当前阶段的股票一次性加入自选（复用池子的分组选择弹层）。 */
function addScreenStocksToWatch(stage: StrategyStage): void {
  const screen = state.screen;
  if (!screen || screen.date !== state.date) {
    toast("策略结果未就绪，请先运行筛选", "error");
    return;
  }
  const marketOf = (code: string): string =>
    state.day?.stocks.find((item) => item.code === code)?.market ?? (code.startsWith("6") ? "1" : "0");
  let picks: Array<{ code: string; name: string }> = [];
  let label = "当前列表";
  if (stage === "watch" || stage === "candidates") {
    const topN = state.profile && state.profile.topN > 0 ? state.profile.topN : 0;
    const list = stage === "watch" && topN > 0 ? screen.candidates.slice(0, topN) : screen.candidates;
    picks = list.map((item) => ({ code: item.code, name: item.name }));
    label = stage === "watch" ? "观察名单" : "候选池";
  } else {
    picks = (screen.stocks ?? [])
      .filter((item) => (stage === "firstBoard" ? item.firstBoard : item.hardPassed))
      .map((item) => ({ code: item.code, name: item.name }));
    label = stage === "firstBoard" ? "首板" : "硬过滤";
  }
  if (!picks.length) {
    toast("当前列表没有可以加入的股票");
    return;
  }
  void openWatchAddDialog(
    picks.map((item) => ({ code: item.code, name: item.name, market: marketOf(item.code) })),
    `把${label}加入自选`,
  );
}

function selectLhbTab(tab: OtherTab): void {
  if (state.otherTab === tab) return;
  state.otherTab = tab;
  state.lhbSeatLog = null;
  state.lhbSeatName = "";
  if (!state.lhbBoard) {
    syncLhbSelection();
    updateOtherStage();
    void ensureOther();
    return;
  }
  if ((tab === "yyz" || tab === "agency") && !state.lhbAgencies) void loadLhbSecondary();
  if (tab === "org" && !state.lhbInstitutions) void loadLhbSecondary();
  syncLhbSelection();
  updateOtherStage();
  if (needsStockPanel()) {
    if (state.lhbStock) void loadLhbDetail(state.lhbStock);
    return;
  }
  if (tab === "agency" && state.lhbAgencyId) {
    const agency = state.lhbAgencies?.rows.find((row) => row.id === state.lhbAgencyId);
    if (agency) void loadLhbSeatLog(agency.id, agency.name);
  }
}

function listenHistoryProgress(): void {
  const bus = (
    window as unknown as {
      __TAURI__?: {
        event?: {
          listen: <T>(name: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
        };
      };
    }
  ).__TAURI__?.event;
  if (!bus || historyUnlisten) return;
  void bus
    .listen<HistoryProgress>("history:progress", (event) => {
      state.historyProgress = event.payload;
      updateStrategyStage();
    })
    .then((unlisten) => {
      historyUnlisten = unlisten;
    })
    .catch(() => {
      /* Progress is optional; the command still finishes. */
    });
}

async function saveStrategyProfileFromForm(): Promise<void> {
  const form = document.getElementById("strategy-profile-form");
  if (!form) return;
  const base = state.profile;
  const read = (key: string, fallback: number): number => {
    const input = form.querySelector<HTMLInputElement>(`[data-profile-field="${key}"]`);
    const value = Number(input?.value);
    return Number.isFinite(value) ? value : fallback;
  };
  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
  const profile: StrategyProfile = {
    maxPrice: clamp(read("maxPrice", base?.maxPrice ?? 30), 0.01, 10_000),
    maxFloatCap: clamp(read("maxFloatCap", (base?.maxFloatCap ?? 20_000_000_000) / 1e8), 0.1, 100_000) * 1e8,
    minLimitCount: Math.round(clamp(read("minLimitCount", base?.minLimitCount ?? 3), 0, 100)),
    limitWindowDays: Math.round(clamp(read("limitWindowDays", base?.limitWindowDays ?? 120), 20, 250)),
    maxStreak: Math.round(clamp(read("maxStreak", base?.maxStreak ?? 4), 1, 30)),
    maxGain20d: clamp(read("maxGain20d", base?.maxGain20d ?? 60), 0, 1000),
    minSectorLimitUps: Math.round(clamp(read("minSectorLimitUps", base?.minSectorLimitUps ?? 3), 0, 200)),
    minSectorContinuous: Math.round(clamp(read("minSectorContinuous", base?.minSectorContinuous ?? 1), 0, 100)),
    minSealRatio: clamp(read("minSealRatio", (base?.minSealRatio ?? 0.1) * 100), 0, 100) / 100,
    maxOpenNum: Math.round(clamp(read("maxOpenNum", base?.maxOpenNum ?? 0), 0, 100)),
    latestFirstSealMinute: Math.round(clamp(read("latestFirstSealMinute", base?.latestFirstSealMinute ?? 30), -5, 240)),
    minTurnover: clamp(read("minTurnover", base?.minTurnover ?? 5), 0, 100),
    topN: Math.round(clamp(read("topN", base?.topN ?? 3), 1, 20)),
    updatedAt: base?.updatedAt ?? 0,
  };
  state.profileSaving = true;
  updateStrategyStage();
  try {
    state.profile = await api.saveStrategyProfile(profile);
    state.profileOpen = false;
    toast("策略参数已保存");
    await runStrategyScreen();
  } catch (e) {
    toast(messageFrom(e, "参数保存失败"), "error");
  } finally {
    state.profileSaving = false;
    updateStrategyStage();
  }
}

function strategyExportText(): string | null {
  const result = state.screen;
  if (!result) return null;
  const lines = [
    `一进二候选 · ${result.date}`,
    `首板 ${result.universe} 只 / 硬过滤通过 ${result.hardPassed} 只 / 候选 ${result.candidates.length} 只`,
    "",
    ["名次", "代码", "名称", "首封", "封单比", "开板", "换手", "流通(亿)", "近6月涨停", "近1年最高", "规则分"].join("\t"),
  ];
  for (const c of result.candidates) {
    lines.push(
      [
        c.rank ?? "-",
        c.code,
        c.name,
        fmtClock(c.stats.firstSeal),
        c.stats.sealRatio == null ? "—" : `${(c.stats.sealRatio * 100).toFixed(1)}%`,
        String(c.stats.openNum),
        `${c.stats.turnoverRate.toFixed(1)}%`,
        (c.stats.floatCap / 1e8).toFixed(1),
        c.stats.limitUp120d == null ? "—" : String(c.stats.limitUp120d),
        c.stats.maxStreak250d == null ? "—" : `${c.stats.maxStreak250d}板`,
        c.score.toFixed(0),
      ].join("\t"),
    );
  }
  lines.push("", "仅为按固定规则筛出的复盘候选，不构成投资建议。");
  return lines.join("\n");
}

async function exportStrategy(): Promise<void> {
  const text = strategyExportText();
  if (!text) {
    toast("没有可导出的候选");
    return;
  }
  const raw = state.screen?.date || state.date || "";
  const date = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw || "strategy";
  try {
    const path = await api.exportText(`一进二候选_${date}.txt`, text);
    const name = path.split(/[\\/]/).pop() || "一进二候选.txt";
    toast(`已导出：data/exports/${name}`);
  } catch (e) {
    toast(messageFrom(e, "导出失败"), "error");
  }
}

function openChart(code: string, name: string, market = "", animate = true): void {
  if (!code) return;
  if (state.view !== "chart") state.returnView = state.view;
  state.chartStock = { code, name, market, kind: "stock" };
  state.view = "chart";
  state.chartData = null;
  state.chartQuote = null;
  state.chartError = null;
  state.chartLoading = true;
  syncHash();
  renderMain({ animate });
  void loadChart();
}

function openIndexChart(secid: string, name: string): void {
  if (!secid) return;
  if (state.view !== "chart") state.returnView = state.view;
  state.chartStock = { code: secid, name, market: "", kind: "index", secid };
  state.view = "chart";
  state.chartData = null;
  state.chartQuote = null;
  state.chartError = null;
  state.chartLoading = true;
  syncHash();
  renderMain();
  void loadChart();
}

function stepChart(delta: number): void {
  const ctx = chartSwitchContext();
  if (ctx.list.length < 2 || ctx.index < 0) return;
  const next = ctx.list[(ctx.index + delta + ctx.list.length) % ctx.list.length];
  if (next && next.code !== state.chartStock?.code) openChart(next.code, next.name, next.market, false);
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
  // Only the timeshare plot may accept Tencent's tick line as a fallback: it
  // reads close alone, while the 1m K-line view must not get fake OHLC.
  const allowMinuteFallback = state.chartMode === "timeshare";
  if (stock.kind === "index") {
    return api.getIndexKline(
      stock.secid || stock.code,
      stock.name,
      period,
      refresh,
      allowMinuteFallback,
    );
  }
  return api.getKline(stock.code, period, refresh, allowMinuteFallback);
}

async function loadChartQuote(token: number): Promise<void> {
  const stock = state.chartStock;
  if (!stock) return;
  try {
    const quote =
      stock.kind === "index"
        ? await api.getIndexQuote(stock.secid || stock.code)
        : await api.getStockQuote(stock.code);
    if (token !== chartToken || !state.chartStock || state.chartStock.code !== stock.code) return;
    state.chartQuote = quote;
    if (stock.kind === "stock") {
      state.watchQuotes[stock.code] = quote;
      updateWatchQuoteDom();
    }
    updateChartHeadDom();
  } catch {
    /* K线仍然可用；报价失败不阻塞图表 */
  }
}

function persistChartViewPrefs(): void {
  try {
    localStorage.setItem("tianti.chartRanges", JSON.stringify(state.chartRanges));
    localStorage.setItem("tianti.timeshareAxis", state.timeshareAxis);
    localStorage.setItem("tianti.timeshareZoom", String(state.timeshareZoom));
  } catch {
    // Preferences are optional; ignore storage failures.
  }
}

function applyTimeshareZoom(value: number): void {
  state.timeshareZoom = Math.max(0.55, Math.min(2.2, Number.isFinite(value) ? value : 1));
  timeShareChart?.setYScale(state.timeshareZoom);
  persistChartViewPrefs();
  updateTimeshareToolbarDom();
}

function updateTimeshareToolbarDom(): void {
  document.querySelectorAll<HTMLElement>("[data-timeshare-y]").forEach((button) => {
    const mode = button.dataset.timeshareY;
    const active =
      (mode === "auto" && Math.abs(state.timeshareZoom - 1) < 0.001) ||
      (mode === "sparse" && state.timeshareZoom < 0.999) ||
      (mode === "dense" && state.timeshareZoom > 1.001);
    button.classList.toggle("active", active);
  });
  const readout = document.querySelector<HTMLElement>(".ts-y-readout");
  if (readout) readout.textContent = `×${state.timeshareZoom.toFixed(2)}`;
}

function marketSessionOpen(): boolean {
  if (state.calendar && state.calendar.isTradeDay === false) return false;
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const weekday = now.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const clock = now.getUTCHours() * 60 + now.getUTCMinutes();
  const lunchBreak = clock > 11 * 60 + 30 && clock < 13 * 60;
  return clock >= 9 * 60 + 15 && clock <= 15 * 60 && !lunchBreak;
}

/**
 * 是否值得为「当前日期」再补一次网络刷新：
 * 交易时段内照常刷新；收盘后只补拉一次，把盘中最后一份快照换成收盘定稿，
 * 之后（周末 / 节假日 / 当晚再次打开）都只读本地缓存。
 */
function shouldRefreshLive(): boolean {
  const today = state.calendar?.today;
  if (!today || state.date !== today) return false;
  if (marketSessionOpen()) return true;
  // 收盘后 15:05 再补一次：收盘瞬间的接口有时还没结算完，早于该时刻的快照视为未定稿。
  const settled = 15 * 60 + 5;
  const now = beijingClock(Date.now() / 1000);
  if (now.date !== today || now.minutes < settled) return false;
  const fetchedAt = state.day?.fetchedAt ?? 0;
  if (!fetchedAt) return true;
  const fetched = beijingClock(fetchedAt);
  return fetched.date !== today || fetched.minutes < settled;
}

/** 北京时间日期与当天分钟数（交易所时钟，和机器时区无关）。 */
function beijingClock(tsSeconds: number): { date: string; minutes: number } {
  const d = new Date((tsSeconds + 8 * 3600) * 1000);
  const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return { date, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** 最近一个「已经收盘定稿」的交易日（YYYYMMDD）；盘前/盘中使用上一个交易日。 */
function lastSettledTradeDate(): string {
  const cal = state.calendar;
  if (!cal) return "";
  const now = beijingClock(Date.now() / 1000);
  if (cal.isTradeDay !== false && now.date === cal.today && now.minutes >= 15 * 60 + 5) return cal.today;
  const dates = cal.dates.filter((d) => d < cal.today);
  return dates.length ? dates[dates.length - 1] : "";
}

/** 把各种 `2026-11-24` / `2026-11-24 16:14` / 数字串统一成 YYYYMMDD。 */
function normalizeYmd(raw: string | undefined | null): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.slice(0, 8);
}

/**
 * 缓存 K 线是否落后于「最近收盘日」：落后就补拉一次，避免收盘后一直停在盘中缓存
 * （日/周/月/年线按最后一根日期比较；1 分钟线按日期比较，盘中由节流刷新负责）。
 */
function klineCacheBehind(period: Period, latestRaw: string): boolean {
  const settled = lastSettledTradeDate();
  const latest = normalizeYmd(latestRaw);
  if (!settled || !latest) return false;
  if (period === "month") return latest.slice(0, 6) < settled.slice(0, 6);
  if (period === "year") return latest.slice(0, 4) < settled.slice(0, 4);
  return latest < settled;
}

/** 指数条是否还停在上一次会话的收盘值（休市启动时用来补一次当天收盘）。 */
function indicesBehindSettled(): boolean {
  const settled = lastSettledTradeDate();
  if (!settled || !state.indices.length) return false;
  return state.indices.some((q) => {
    const asOf = normalizeYmd(q.asOf);
    return !asOf || asOf < settled;
  });
}

/**
 * During the session the ladder pool is re-pulled quietly every minute: the
 * `time_preview` series grows and the aggregate stats change as new stocks seal.
 * The timeshare plot is refreshed on its own 1-minute feed every 30 seconds so
 * the pulsing latest point keeps moving.
 */
function autoRefreshTick(): void {
  const now = Date.now();
  const isToday = Boolean(state.date && state.calendar?.today === state.date);
  if (
    isToday &&
    state.view !== "chart" &&
    // 交易时段内每分钟静默刷新；收盘后再补拉一次收盘定稿，之后保持本地缓存。
    shouldRefreshLive() &&
    !state.refreshing &&
    now - lastDayAutoRefresh > 60000
  ) {
    lastDayAutoRefresh = now;
    void refreshDay(state.date, dayToken, true);
  }
  if (
    state.view === "chart" &&
    state.chartMode === "timeshare" &&
    state.chartStock &&
    !state.chartLoading &&
    marketSessionOpen() &&
    now - lastChartAutoRefresh > 30000
  ) {
    lastChartAutoRefresh = now;
    void refreshTimeShare(chartToken);
  }
}

async function refreshTimeShare(token: number): Promise<void> {
  if (timeshareRefreshing) return;
  const stock = state.chartStock;
  if (!stock) return;
  timeshareRefreshing = true;
  try {
    const data = await fetchChartData("1m", true);
    if (token !== chartToken || state.view !== "chart" || state.chartMode !== "timeshare" || !state.chartStock) return;
    state.chartData = data;
    state.chartError = null;
    state.chartLoading = false;
    if (!state.chartStock.name && data.name) state.chartStock.name = data.name;
    if (timeShareChart) {
      timeShareChart.setData(data.candles, state.chartQuote?.prevClose ?? data.prevClose);
      updateChartHeadDom();
    } else {
      // The first 1m request failed before the canvas existed; mount it now
      // instead of leaving an empty stage with an error card until a manual retry.
      renderMain({ animate: false });
    }
  } catch {
    /* keep the last plot; the next tick retries */
  } finally {
    timeshareRefreshing = false;
  }
}

function applyChartRange(value: number): void {
  state.chartRange = value;
  state.chartRanges[state.chartPeriod] = value;
  chart?.setRange(value);
  persistChartViewPrefs();
}

function updateChartHeadDom(): void {
  const head = document.getElementById("chart-head");
  if (head) head.innerHTML = renderChartHead();
}

async function loadChart(): Promise<void> {
  const stock = state.chartStock;
  if (!stock) return;
  const token = ++chartToken;
  const period = state.chartPeriod;
  state.chartLoading = true;
  state.chartError = null;
  renderMain({ animate: false });
  void loadChartQuote(token);
  try {
    const data = await fetchChartData(period, false);
    if (token !== chartToken) return;
    state.chartData = data;
    state.chartLoading = false;
    if (state.chartStock && !state.chartStock.name && data.name) state.chartStock.name = data.name;
    renderMain({ animate: false });
    if (data.source === "cache" && (shouldRefreshLive() || klineCacheBehind(period, data.latestDate))) {
      void refreshChart(token);
    }
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
  closeDropdown();
  const main = document.getElementById("main");
  if (!main) return;
  const scrolls = {
    ladder: document.querySelector<HTMLElement>(".ladder-main")?.scrollTop ?? 0,
    pool: document.querySelector<HTMLElement>(".pool-body")?.scrollTop ?? 0,
    side: document.querySelector<HTMLElement>(".chart-side")?.scrollTop ?? 0,
    otherList: document.querySelector<HTMLElement>(".oh-list-body")?.scrollTop ?? 0,
    otherPanel: document.querySelector<HTMLElement>(".oh-panel-body")?.scrollTop ?? 0,
  };
  chart?.destroy();
  chart = null;
  timeShareChart?.destroy();
  timeShareChart = null;
  let html = "";
  if (state.view === "pool") html = renderPool();
  else if (state.view === "timeline") html = renderTimeline();
  else if (state.view === "chart") html = renderChartView();
  else if (state.view === "strategy") html = renderStrategy();
  else if (state.view === "other") html = renderOther();
  else html = renderLadder();
  main.innerHTML = html;
  if (opts.animate === false) main.querySelector(".view")?.classList.add("no-anim");
  if (state.view === "chart" && state.chartStock && state.chartData) mountChart();
  syncToolbarOverflow();
  const ladderScroller = main.querySelector<HTMLElement>(".ladder-main");
  if (ladderScroller) ladderScroller.scrollTop = scrolls.ladder;
  const poolScroller = main.querySelector<HTMLElement>(".pool-body");
  if (poolScroller) poolScroller.scrollTop = scrolls.pool;
  const chartSide = main.querySelector<HTMLElement>(".chart-side");
  if (chartSide) chartSide.scrollTop = scrolls.side;
  const otherList = main.querySelector<HTMLElement>(".oh-list-body");
  if (otherList) otherList.scrollTop = scrolls.otherList;
  const otherPanel = main.querySelector<HTMLElement>(".oh-panel-body");
  if (otherPanel) otherPanel.scrollTop = scrolls.otherPanel;
  updateChrome();
}

const toolbarObservers = new WeakSet<HTMLElement>();

function syncToolbarOverflow(): void {
  document.querySelectorAll<HTMLElement>(".chart-toolbar-controls").forEach((el) => {
    const update = () => el.classList.toggle("is-scrollable", el.scrollWidth > el.clientWidth + 1);
    update();
    if (!toolbarObservers.has(el)) {
      toolbarObservers.add(el);
      new ResizeObserver(update).observe(el);
    }
  });
}

function mountChart(): void {
  const stage = document.getElementById("chart-stage");
  if (!stage || !state.chartData) return;
  if (state.chartMode === "timeshare") {
    if (state.chartPeriod !== "1m" || state.chartData.period !== "1m") return;
    const stock = state.chartStock;
    timeShareChart = new TimeShareChart(stage, {
      axisMode: state.timeshareAxis,
      yScale: state.timeshareZoom,
      kind: stock?.kind === "index" ? "index" : "stock",
      onYScaleChange: (value) => {
        state.timeshareZoom = value;
        persistChartViewPrefs();
        updateTimeshareToolbarDom();
      },
    });
    timeShareChart.setData(state.chartData.candles, state.chartQuote?.prevClose ?? state.chartData.prevClose);
    return;
  }
  chart = new KLineChart(stage, {
    period: state.chartPeriod,
    range: state.chartRange,
    ...state.chartPrefs,
    onCandleDblClick: (index) => openIntradayAt(index),
  });
  chart.setData(state.chartData.candles);
}

/* ————————————————— interactions ————————————————— */

function bindGlobals(): void {
  const app = document.getElementById("app")!;
  app.addEventListener("click", (e) => handleClick(e));
  app.addEventListener("input", (e) => handleInput(e));
  app.addEventListener(
    "wheel",
    (e) => {
      const controls = (e.target as HTMLElement).closest<HTMLElement>(".chart-toolbar-controls");
      if (!controls || controls.scrollWidth <= controls.clientWidth + 1) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      controls.scrollLeft += delta;
      e.preventDefault();
    },
    { passive: false },
  );
  app.addEventListener("change", (e) => handleChange(e));
  app.addEventListener("keydown", (e) => handleKeydown(e));
  app.addEventListener("contextmenu", (e) => handleContextMenu(e));
  app.addEventListener("pointerover", handleStockHover);
  app.addEventListener("pointermove", moveStockHover);
  app.addEventListener("pointerout", hideStockHover);
  window.addEventListener("scroll", hideHover, true);
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
    } else if (overlayKind === "intraday" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const total = state.chartData?.candles.length ?? 0;
      const next = intradayIndex + (e.key === "ArrowLeft" ? -1 : 1);
      if (next >= 0 && next < total) {
        e.preventDefault();
        openIntradayAt(next);
      }
    } else if (e.key === "Escape" && (state.profileOpen || state.strategyDetailCode)) {
      state.profileOpen = false;
      state.strategyDetailCode = null;
      updateStrategyStage();
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

}

function hideHover(): void {
  hoverAnchor = null;
  if (!stockHover) return;
  stockHover.hidden = true;
  stockHover.classList.remove("show");
}

function handleStockHover(e: PointerEvent): void {
  const card = (e.target as Element).closest<HTMLElement>(".stock-card");
  if (!card || overlayKind) {
    hideHover();
    return;
  }
  const s = findStock(card.dataset.stockCode || "");
  if (!s) {
    hideHover();
    return;
  }
  stockHover.innerHTML = `<div class="hover-head"><b>${esc(s.name)}</b><span>${s.code}</span><em>${esc(tierName(s.streak))}</em></div>
    <div class="hover-meta">
      <span><i>首封</i>${fmtClock(s.firstSeal)}</span>
      <span><i>封单</i>${s.sealAmount > 0 ? fmtMoney(s.sealAmount) : "—"}</span>
      <span><i>换手</i>${s.turnoverRate.toFixed(2)}%</span>
      <span><i>开板</i>${s.openNum} 次</span>
    </div>`;

  const rect = card.getBoundingClientRect();
  hoverAnchor = { left: rect.left, top: rect.top, width: rect.width, height: rect.height, bottom: rect.bottom };
  stockHover.hidden = false;
  stockHover.classList.add("show");
  positionHover();
}

function positionHover(): void {
  if (!stockHover || stockHover.hidden || !hoverAnchor) return;
  const pad = 12;
  const gap = 9;
  const w = stockHover.offsetWidth || 238;
  const h = stockHover.offsetHeight || 150;
  let left = hoverAnchor.left + hoverAnchor.width - w;
  if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
  if (left < pad) left = pad;
  let top = hoverAnchor.top - h - gap;
  if (top < 56) top = hoverAnchor.bottom + gap;
  if (top + h > window.innerHeight - pad) top = window.innerHeight - h - pad;
  stockHover.style.left = `${Math.round(left)}px`;
  stockHover.style.top = `${Math.round(top)}px`;
}

function moveStockHover(_e: PointerEvent): void {
  /* Tooltip is anchored to the card; no cursor-follow flicker. */
}

function hideStockHover(e: PointerEvent): void {
  const card = (e.target as Element).closest<HTMLElement>(".stock-card");
  if (!card) return;
  const next = e.relatedTarget as Element | null;
  if (next && card.contains(next)) return;
  hideHover();
}

function handleClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const periodMore = target.closest<HTMLElement>(".period-more");
  document.querySelectorAll<HTMLElement>(".period-more.is-open").forEach((el) => {
    if (el !== periodMore) el.classList.remove("is-open");
  });
  if (!periodMore) {
    document.querySelectorAll<HTMLElement>(".chart-toolbar-controls.is-menu-open").forEach((el) => {
      el.classList.remove("is-menu-open");
    });
  }
  const win = target.closest<HTMLElement>("[data-win]");
  if (win) {
    const action = win.dataset.win as "minimize" | "maximize" | "close";
    void api.windowControl(action);
    return;
  }
  const nav = target.closest<HTMLElement>("[data-nav]");
  if (nav) {
    navigate(nav.dataset.nav as ViewName);
    return;
  }
  const strategyTab = target.closest<HTMLElement>("[data-strategy-tab]");
  if (strategyTab) {
    const tab = strategyTab.dataset.strategyTab as StrategyTab | undefined;
    if (tab) {
      state.strategyTab = tab;
      state.strategyDetailCode = null;
      updateStrategyStage();
      if (tab === "auction") void loadStrategyAuction();
      else if (tab === "firstToSecond" && (!state.screen || state.screen.date !== state.date)) void runStrategyScreen();
    }
    return;
  }
  const strategyStage = target.closest<HTMLElement>("[data-strategy-stage]");
  if (strategyStage) {
    const stage = strategyStage.dataset.strategyStage as StrategyStage | undefined;
    if (stage && stage !== state.strategyStage) {
      state.strategyStage = stage;
      state.strategyShowExcluded = false;
      updateStrategyStage();
    }
    return;
  }
  if (target.closest("[data-strategy-run]")) {
    void runStrategyScreen();
    return;
  }
  if (target.closest("[data-strategy-prev-day]")) {
    const prev = neighbors().prev;
    if (prev) changeDate(prev);
    return;
  }
  if (target.closest("[data-history-sync]")) {
    void syncStrategyHistory();
    return;
  }
  if (target.closest("[data-open-profile]")) {
    state.profileOpen = true;
    updateStrategyStage();
    return;
  }
  if (target.closest("[data-profile-close]")) {
    state.profileOpen = false;
    updateStrategyStage();
    return;
  }
  if (target.closest("[data-profile-save]")) {
    void saveStrategyProfileFromForm();
    return;
  }
  if (target.closest("[data-strategy-refresh]")) {
    state.screen = null;
    state.screenError = null;
    void runStrategyScreen(true);
    return;
  }
  if (target.closest("[data-strategy-show-excluded]")) {
    state.strategyShowExcluded = !state.strategyShowExcluded;
    updateStrategyStage();
    return;
  }
  if (target.closest("[data-detail-close]")) {
    state.strategyDetailCode = null;
    updateStrategyStage();
    return;
  }
  if (target.closest("[data-auction-capture]")) {
    void captureStrategyAuction();
    return;
  }
  if (target.closest("[data-strategy-export]")) {
    void exportStrategy();
    return;
  }
  const otherTab = target.closest<HTMLElement>("[data-other-tab]");
  if (otherTab) {
    const tab = otherTab.dataset.otherTab as OtherTab | undefined;
    if (tab) selectLhbTab(tab);
    return;
  }
  if (target.closest("[data-lhb-refresh]")) {
    void ensureOther(true);
    return;
  }
  const lhbSort = target.closest<HTMLElement>("[data-lhb-sort]");
  if (lhbSort) {
    const key = lhbSort.dataset.lhbSort as "net" | "pct" | "seats" | undefined;
    if (key) {
      state.lhbSort = state.lhbSort.key === key ? { key, dir: state.lhbSort.dir === -1 ? 1 : -1 } : { key, dir: -1 };
      updateOtherStage();
    }
    return;
  }
  const lhbChart = target.closest<HTMLElement>("[data-lhb-chart]");
  if (lhbChart) {
    openChart(lhbChart.dataset.lhbChart || "", lhbChart.dataset.lhbChartName || "");
    return;
  }
  const lhbStock = target.closest<HTMLElement>("[data-lhb-stock]");
  if (lhbStock) {
    selectLhbStock(lhbStock.dataset.lhbStock || "");
    return;
  }
  const lhbTag = target.closest<HTMLElement>("[data-lhb-tag]");
  if (lhbTag) {
    state.lhbTag = lhbTag.dataset.lhbTag || "";
    state.lhbSeatLog = null;
    updateOtherStage();
    return;
  }
  const lhbSeat = target.closest<HTMLElement>("[data-lhb-seat]");
  if (lhbSeat) {
    void loadLhbSeatLog(lhbSeat.dataset.lhbSeat || "", lhbSeat.dataset.lhbSeatName || "");
    return;
  }
  const lhbAgency = target.closest<HTMLElement>("[data-lhb-agency]");
  if (lhbAgency) {
    state.lhbAgencyId = lhbAgency.dataset.lhbAgency || "";
    void loadLhbSeatLog(state.lhbAgencyId, lhbAgency.dataset.lhbAgencyName || "");
    return;
  }
  const screenWatch = target.closest<HTMLElement>("[data-screen-watch]");
  if (screenWatch) {
    const stage = screenWatch.dataset.screenWatch as StrategyStage | undefined;
    if (stage) addScreenStocksToWatch(stage);
    return;
  }
  const watchCandidate = target.closest<HTMLElement>("[data-candidate-watch]");
  if (watchCandidate) {
    const code = watchCandidate.dataset.candidateWatch || "";
    const stock = state.day?.stocks.find((item) => item.code === code) ?? findStock(code);
    if (stock) {
      void openWatchAddDialog([{ code: stock.code, name: stock.name, market: stock.market }], `把 ${stock.name} 加入自选`);
    }
    return;
  }
  const detailCandidate = target.closest<HTMLElement>("[data-candidate-detail]");
  if (detailCandidate) {
    state.strategyDetailCode = detailCandidate.dataset.candidateDetail || null;
    updateStrategyStage();
    return;
  }
  if (target.closest("[data-candidate-ops]")) return;
  const candidateRow = target.closest<HTMLElement>("[data-candidate-code]");
  if (candidateRow) {
    openChart(candidateRow.dataset.candidateCode!, candidateRow.dataset.candidateName || "");
    return;
  }
  const stageStock = target.closest<HTMLElement>("[data-strategy-stock]");
  if (stageStock) {
    openChart(stageStock.dataset.strategyStock!, stageStock.dataset.strategyName || "");
    return;
  }
  const indexEl = target.closest<HTMLElement>("[data-index-secid]");
  if (indexEl) {
    openIndexChart(indexEl.dataset.indexSecid!, indexEl.dataset.indexName || "指数");
    return;
  }
  const timelineOrder = target.closest<HTMLElement>("[data-timeline-order]");
  if (timelineOrder) {
    state.timelineOrder = timelineOrder.dataset.timelineOrder === "desc" ? "desc" : "asc";
    try {
      localStorage.setItem("tianti.timelineOrder", state.timelineOrder);
    } catch {
      /* storage is optional */
    }
    renderMain({ animate: false });
    return;
  }
  const axisBtn = target.closest<HTMLElement>("[data-timeshare-axis]");
  if (axisBtn) {
    const mode = axisBtn.dataset.timeshareAxis === "follow" ? "follow" : "full";
    state.timeshareAxis = mode;
    timeShareChart?.setAxisMode(mode);
    persistChartViewPrefs();
    document.querySelectorAll<HTMLElement>("[data-timeshare-axis]").forEach((el) => {
      el.classList.toggle("active", el.dataset.timeshareAxis === mode);
    });
    return;
  }
  const yBtn = target.closest<HTMLElement>("[data-timeshare-y]");
  if (yBtn) {
    const mode = yBtn.dataset.timeshareY;
    if (mode === "auto") applyTimeshareZoom(1);
    else if (mode === "sparse") applyTimeshareZoom(state.timeshareZoom * 0.8);
    else if (mode === "dense") applyTimeshareZoom(state.timeshareZoom * 1.25);
    return;
  }
  const modeBtn = target.closest<HTMLElement>('[data-chart-mode="timeshare"]');
  if (modeBtn) {
    const needData = state.chartPeriod !== "1m" || state.chartData?.period !== "1m";
    state.chartMode = "timeshare";
    if (state.chartPeriod !== "1m") state.chartPeriod = "1m";
    state.chartRange = 0;
    state.chartLoading = needData;
    renderMain({ animate: false });
    if (needData) void loadChart();
    return;
  }
  const periodBtn = target.closest<HTMLElement>("[data-chart-period]");
  if (periodBtn) {
    const p = periodBtn.dataset.chartPeriod as Period;
    const wasTimeshare = state.chartMode === "timeshare";
    state.chartMode = "kline";
    state.chartRange = normalizeChartRange(p, state.chartRanges[p] ?? state.chartRange);
    state.chartRanges[p] = state.chartRange;
    persistChartViewPrefs();
    if (p === state.chartPeriod && state.chartData?.period === p) {
      renderMain({ animate: false });
      return;
    }
    if (p !== state.chartPeriod || wasTimeshare) {
      state.chartPeriod = p;
      state.chartLoading = true;
      renderMain({ animate: false });
      void loadChart();
    }
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
  const dockTab = target.closest<HTMLElement>("[data-dock-tab]");
  if (dockTab) {
    state.chartDock = dockTab.dataset.dockTab === "insight" ? "insight" : "watch";
    updateChartDock();
    return;
  }
  const watchGroupBtn = target.closest<HTMLElement>("[data-watch-group]");
  if (watchGroupBtn) {
    state.watchGroupId = Number(watchGroupBtn.dataset.watchGroup);
    updateChartDock();
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
        `把当前列表加入自选`,
      );
      break;
    case "watch-add-current":
      if (state.chartStock?.kind === "stock") {
        openWatchAddDialog([watchStockFromSelection(state.chartStock)], "把当前股票加入自选");
      }
      break;
    case "period-menu":
      {
        const more = actionEl.closest<HTMLElement>(".period-more");
        const opened = more?.classList.toggle("is-open") === true;
        actionEl.closest<HTMLElement>(".chart-toolbar-controls")?.classList.toggle("is-menu-open", opened);
      }
      break;
    case "export-timeline":
      void exportTimeline();
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
    case "chart-prev":
      stepChart(-1);
      break;
    case "chart-next":
      stepChart(1);
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
  if (e.key === "Escape") {
    const openMenu = document.querySelector<HTMLElement>(".period-more.is-open");
    if (openMenu) {
      openMenu.classList.remove("is-open");
      openMenu.closest<HTMLElement>(".chart-toolbar-controls")?.classList.remove("is-menu-open");
    }
  }
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
    return;
  }
  const stageRow = target.closest<HTMLElement>("tr[data-strategy-stock]");
  if (stageRow && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    openChart(stageRow.dataset.strategyStock!, stageRow.dataset.strategyName || "");
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

async function exportTimeline(): Promise<void> {
  const text = timelineExportText();
  if (!text) {
    toast("没有可导出的时间轴数据");
    return;
  }
  try {
    const rawDate = state.day?.date || state.date || "";
    const date = rawDate.length === 8 ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : rawDate || "timeline";
    const path = await api.exportText(`盘口时间轴_${date}.txt`, text);
    const name = path.split(/[\\/]/).pop() || "盘口时间轴.txt";
    toast(`已导出：data/exports/${name}`);
  } catch (e) {
    toast(messageFrom(e, "导出失败"), "error");
  }
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
    if (state.chartMode !== "timeshare") {
      const note = document.querySelector<HTMLElement>(".chart-footnote span:last-child");
      if (note) note.textContent = indicatorSummary(state.chartPrefs);
    }
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
  void refreshWatchQuotes();
}

async function refreshWatchQuotes(): Promise<void> {
  if (watchQuoteLoading) return;
  const codes = new Set<string>();
  for (const group of state.watchGroups) {
    for (const stock of group.stocks) codes.add(stock.code);
  }
  const chartStock = state.chartStock;
  if (chartStock?.kind === "stock") codes.add(chartStock.code);
  if (!codes.size) return;
  watchQuoteLoading = true;
  try {
    const quotes = await api.getStockQuotes([...codes].slice(0, 80));
    for (const quote of quotes) state.watchQuotes[quote.code] = quote;
    if (chartStock?.kind === "stock") {
      const quote = quotes.find((q) => q.code === chartStock.code);
      if (quote) {
        state.chartQuote = quote;
        updateChartHeadDom();
      }
    }
    updateWatchQuoteDom();
  } catch {
    /* keep previous quotes */
  } finally {
    watchQuoteLoading = false;
  }
}

function updateWatchQuoteDom(): void {
  document.querySelectorAll<HTMLElement>(".watch-row").forEach((row) => {
    const code = row.dataset.watchCode;
    const quote = code ? state.watchQuotes[code] : null;
    const target = row.querySelector<HTMLElement>(".watch-row-quote");
    if (!quote || !target) return;
    target.textContent = `${quote.pct >= 0 ? "+" : ""}${quote.pct.toFixed(2)}%`;
    target.className = `watch-row-quote text-${quote.pct > 0 ? "up" : quote.pct < 0 ? "down" : "flat"}`;
  });
}

function updateWatchPanel(): void {
  updateChartDock();
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

const LINE_COLORS: Array<{ value: string; label: string; css: string }> = [
  { value: "brass", label: "铜金", css: "var(--brass)" },
  { value: "up", label: "朱砂", css: "var(--up)" },
  { value: "down", label: "青瓷", css: "var(--down)" },
  { value: "violet", label: "紫藤", css: "var(--violet)" },
  { value: "sky", label: "天青", css: "var(--sky)" },
  { value: "amber", label: "琥珀", css: "var(--amber)" },
];

const LINE_WIDTHS = [0.8, 1, 1.2, 1.5, 2, 2.5];
const LINE_PERIODS = [5, 13, 21, 34, 55, 89, 144, 233, 2, 3, 8];

function colorDot(color: string): string {
  const css = LINE_COLORS.find((c) => c.value === color)?.css || "var(--brass)";
  return `<i class="dd-dot" style="background:${css}"></i>`;
}

function lineDd(field: "color" | "width" | "dashed", line: ChartPrefs["maLines"][number]): string {
  let label = "";
  let options = "";
  if (field === "color") {
    const current = LINE_COLORS.find((c) => c.value === line.color) || LINE_COLORS[0];
    label = `${colorDot(current.value)}${current.label}`;
    options = LINE_COLORS.map((c) => `<button type="button" data-value="${c.value}">${colorDot(c.value)}${c.label}</button>`).join("");
  } else if (field === "width") {
    label = `${line.width}px`;
    options = LINE_WIDTHS.map((w) => `<button type="button" data-value="${w}">${w}px</button>`).join("");
  } else {
    label = line.dashed ? "虚线" : "实线";
    options = `<button type="button" data-value="0">实线</button><button type="button" data-value="1">虚线</button>`;
  }
  const value = field === "color" ? line.color : field === "width" ? line.width : line.dashed ? "1" : "0";
  return `<div class="dd line-dd">
    <button type="button" class="dd-trigger line-dd-trigger" data-dd-trigger data-dd-menu="${field === "color" ? 164 : 82}" data-field="${field}" data-value="${value}" aria-haspopup="listbox" aria-expanded="false">
      <span class="dd-label">${label}</span>${icon("chevronDown", 10)}
    </button>
    <div class="dd-options" hidden>${options}</div>
  </div>`;
}

function lineRow(kind: "ma" | "ema", line: ChartPrefs["maLines"][number]): string {
  const visible = line.visible !== false;
  return `<div class="line-row ${visible ? "" : "is-hidden"}" data-line-kind="${kind}" data-visible="${visible}">
    <button type="button" class="line-eye" data-line-toggle title="${visible ? "隐藏这条线" : "显示这条线"}" aria-label="${visible ? "隐藏" : "显示"}">${icon(visible ? "eye" : "eyeOff", 13)}</button>
    <label class="line-period"><input class="line-input mono" data-field="period" type="number" min="2" max="250" value="${line.period}" /></label>
    ${lineDd("color", line)}
    ${lineDd("width", line)}
    ${lineDd("dashed", line)}
    <button type="button" class="line-remove" data-line-remove title="删除这条线" aria-label="删除">${icon("close", 11)}</button>
  </div>`;
}

function lineEditor(kind: "ma" | "ema", label: string, enabled: boolean, lines: ChartPrefs["maLines"], desc: string): string {
  return `<section class="indicator-editor">
    <div class="indicator-editor-head">
      <label class="indicator-switch"><input type="checkbox" id="pref-${kind}" ${enabled ? "checked" : ""} /><span></span><b>${label}</b><em>${desc}</em></label>
      <span class="indicator-editor-hint">颜色 · 粗细 · 虚实 · 单线隐藏</span>
    </div>
    <div class="line-editor" data-line-editor="${kind}">
      ${lines.map((line) => lineRow(kind, line)).join("")}
    </div>
    <div class="line-editor-foot">
      <button type="button" class="line-add" data-add-line="${kind}">${icon("plus", 11)} 添加一条</button>
      <span class="line-count">${lines.length}/4</span>
    </div>
  </section>`;
}

function openIndicatorSettings(): void {
  const p = state.chartPrefs;
  closeOverlay();
  overlayKind = "indicator";
  overlayRoot.innerHTML = `<div class="overlay modal-overlay" id="indicator-overlay">
    <div class="overlay-panel indicator-modal" role="dialog" aria-label="指标参数">
      <div class="modal-head">
        <div><h2>指标参数</h2><p>线条颜色、粗细与虚实，修改后立即应用</p></div>
        <button class="modal-close" data-close-indicator aria-label="关闭">${icon("close", 15)}</button>
      </div>
      <div class="modal-body">
        ${lineEditor("ma", "MA", p.maEnabled, p.maLines, "简单移动平均")}
        ${lineEditor("ema", "EMA", p.emaEnabled, p.emaLines, "指数移动平均")}
        <section class="indicator-editor kdj-editor">
          <div class="indicator-editor-head">
            <label class="indicator-switch"><input type="checkbox" id="pref-kdj" ${p.kdjEnabled ? "checked" : ""} /><span></span><b>KDJ</b><em>随机指标</em></label>
            <span class="indicator-editor-hint">N · K · D</span>
          </div>
          <div class="kdj-inputs">
            <label>N <input class="line-input mono" id="pref-kdj-n" type="number" min="2" max="90" value="${p.kdjN}" /></label>
            <label>K <input class="line-input mono" id="pref-kdj-k" type="number" min="1" max="20" value="${p.kdjK}" /></label>
            <label>D <input class="line-input mono" id="pref-kdj-d" type="number" min="1" max="20" value="${p.kdjD}" /></label>
          </div>
        </section>
        <p class="modal-hint">最多 4 条线，至少保留 1 条；眼睛按钮可单独隐藏。参数保存到本地数据库，重启后保留。</p>
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
  const syncLineEditor = (kind: "ma" | "ema") => {
    const editor = overlay.querySelector<HTMLElement>(`[data-line-editor="${kind}"]`);
    if (!editor) return;
    const rows = Array.from(editor.querySelectorAll<HTMLElement>(".line-row"));
    const count = editor.parentElement?.querySelector<HTMLElement>(".line-count");
    if (count) count.textContent = `${rows.length}/4`;
    const add = editor.parentElement?.querySelector<HTMLButtonElement>(`[data-add-line="${kind}"]`);
    if (add) add.disabled = rows.length >= 4;
    rows.forEach((row) => {
      const remove = row.querySelector<HTMLButtonElement>("[data-line-remove]");
      if (remove) remove.disabled = rows.length <= 1;
    });
  };
  overlay.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const add = target.closest<HTMLElement>("[data-add-line]");
    if (add) {
      const kind = add.dataset.addLine as "ma" | "ema";
      const editor = overlay.querySelector<HTMLElement>(`[data-line-editor="${kind}"]`);
      if (!editor) return;
      const rows = Array.from(editor.querySelectorAll<HTMLElement>(".line-row"));
      if (rows.length >= 4) return;
      const used = new Set(rows.map((row) => Number(row.querySelector<HTMLInputElement>('[data-field="period"]')?.value)).filter((v) => Number.isFinite(v)));
      const period = LINE_PERIODS.find((v) => !used.has(v)) ?? 21;
      const palette = kind === "ma" ? ["sky", "amber", "violet", "brass"] : ["brass", "up", "down", "violet"];
      const line: ChartPrefs["maLines"][number] = {
        period,
        color: palette[rows.length % palette.length],
        width: kind === "ma" ? 1 : 1.2,
        dashed: kind === "ma",
        visible: true,
      };
      editor.insertAdjacentHTML("beforeend", lineRow(kind, line));
      syncLineEditor(kind);
      return;
    }
    const remove = target.closest<HTMLElement>("[data-line-remove]");
    if (remove) {
      const row = remove.closest<HTMLElement>(".line-row");
      const editor = row?.parentElement;
      if (!row || !editor) return;
      if (editor.querySelectorAll(".line-row").length <= 1) {
        toast("至少保留一条线", "error");
        return;
      }
      const kind = editor.dataset.lineEditor as "ma" | "ema";
      row.remove();
      syncLineEditor(kind);
      return;
    }
    const eye = target.closest<HTMLElement>("[data-line-toggle]");
    if (eye) {
      const row = eye.closest<HTMLElement>(".line-row");
      if (!row) return;
      const visible = row.dataset.visible === "false";
      if (!visible) {
        const editor = row.parentElement;
        const shown = Array.from(editor?.querySelectorAll<HTMLElement>(".line-row") ?? []).filter((item) => item.dataset.visible !== "false");
        if (shown.length <= 1 && shown[0] === row) {
          toast("至少保留一条可见线", "error");
          return;
        }
      }
      row.dataset.visible = String(visible);
      row.classList.toggle("is-hidden", !visible);
      eye.innerHTML = icon(visible ? "eye" : "eyeOff", 13);
      eye.setAttribute("title", visible ? "隐藏这条线" : "显示这条线");
      eye.setAttribute("aria-label", visible ? "隐藏" : "显示");
    }
  });
  syncLineEditor("ma");
  syncLineEditor("ema");
  overlay.querySelector("#indicator-apply")?.addEventListener("click", async () => {
    const collect = (kind: "ma" | "ema") => {
      const rows = Array.from(overlay.querySelectorAll<HTMLElement>(`[data-line-kind="${kind}"]`));
      const out: ChartPrefs["maLines"] = [];
      for (const row of rows) {
        const period = Number(row.querySelector<HTMLInputElement>('[data-field="period"]')?.value);
        if (!Number.isFinite(period) || period < 2 || period > 250) continue;
        if (out.some((line) => line.period === period)) continue;
        const color = row.querySelector<HTMLElement>('[data-field="color"]')?.dataset.value || "brass";
        const width = Number(row.querySelector<HTMLElement>('[data-field="width"]')?.dataset.value) || 1;
        const dashed = row.querySelector<HTMLElement>('[data-field="dashed"]')?.dataset.value === "1";
        out.push({ period: Math.round(period), color, width, dashed, visible: row.dataset.visible !== "false" });
      }
      return out.slice(0, 4);
    };
    const maLines = collect("ma");
    const emaLines = collect("ema");
    const maEnabled = overlay.querySelector<HTMLInputElement>("#pref-ma")!.checked;
    const emaEnabled = overlay.querySelector<HTMLInputElement>("#pref-ema")!.checked;
    if (maEnabled && !maLines.length) return toast("MA 至少保留一条 2–250 周期的线", "error");
    if (emaEnabled && !emaLines.length) return toast("EMA 至少保留一条 2–250 周期的线", "error");
    const kdjN = Number(overlay.querySelector<HTMLInputElement>("#pref-kdj-n")!.value);
    const kdjK = Number(overlay.querySelector<HTMLInputElement>("#pref-kdj-k")!.value);
    const kdjD = Number(overlay.querySelector<HTMLInputElement>("#pref-kdj-d")!.value);
    const next: ChartPrefs = {
      maEnabled,
      maLines: maLines.length ? maLines : p.maLines,
      emaEnabled,
      emaLines: emaLines.length ? emaLines : p.emaLines,
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
  closeDropdown();
  hideHover();
  if (overlayKind === "intraday") {
    intradayChart?.destroy();
    intradayChart = null;
    intradayToken++;
  }
  overlayKind = null;
  state.searchOpen = false;
  state.settingsOpen = false;
  if (overlayRoot) overlayRoot.innerHTML = "";
}

/* ————————————————— intraday overlay ————————————————— */

interface IntradaySelection {
  index: number;
  total: number;
  date: string;
  name: string;
  codeLabel: string;
  instrument: string;
  prevClose: number | null;
  candle: KlineCandle;
}

function intradaySelection(at: number): IntradaySelection | null {
  const data = state.chartData;
  const stock = state.chartStock;
  if (!data || !stock || !data.candles.length) return null;
  const index = Math.max(0, Math.min(data.candles.length - 1, at));
  const candle = data.candles[index];
  const date = candle.date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    index,
    total: data.candles.length,
    date,
    name: stock.name || data.name || stock.code,
    codeLabel: stock.kind === "index" ? stock.code.split(".").pop() || stock.code : stock.code,
    instrument: stock.kind === "index" ? stock.secid || stock.code : stock.code,
    prevClose: index > 0 ? data.candles[index - 1].close : data.prevClose ?? null,
    candle,
  };
}

function openIntradayAt(index: number): void {
  const sel = intradaySelection(index);
  if (!sel) return;

  // Switching days inside an open dialog must update only the dialog. Closing
  // and rebuilding the overlay makes the whole page flash for a frame.
  if (overlayKind === "intraday" && document.getElementById("intraday-overlay")) {
    intradayIndex = sel.index;
    intradayToken++;
    syncIntradayHead(sel);
    void loadIntraday(sel);
    return;
  }

  closeOverlay();
  overlayKind = "intraday";
  intradayIndex = sel.index;
  intradayToken++;
  const tone = pctToneClass(sel.candle.pct);
  overlayRoot.innerHTML = `<div class="overlay modal-overlay" id="intraday-overlay">
    <div class="overlay-panel intraday-panel" role="dialog" aria-label="当日分时">
      <header class="intraday-head">
        <div class="intraday-id">
          <b>${esc(sel.name)}</b>
          <span id="intraday-date">${esc(sel.codeLabel)} · ${sel.date}</span>
        </div>
        <div class="intraday-quote">
          <b id="intraday-price" class="${tone}">${fmtPrice(sel.candle.close)}</b>
          <span id="intraday-pct" class="${tone}">${fmtPct(sel.candle.pct)}</span>
        </div>
        <div class="intraday-step">
          <button class="btn-quiet" data-intraday-step="-1" title="上一交易日 (←)" ${sel.index <= 0 ? "disabled" : ""}>${icon("chevronLeft", 15)}</button>
          <button class="btn-quiet" data-intraday-step="1" title="下一交易日 (→)" ${sel.index >= sel.total - 1 ? "disabled" : ""}>${icon("chevronRight", 15)}</button>
        </div>
        <button class="intraday-close" data-intraday-close title="关闭 (Esc)" aria-label="关闭">${icon("close", 16)}</button>
      </header>
      <div class="intraday-stage" id="intraday-stage">
        <div class="intraday-loading"><span class="loader"></span><span>正在读取 ${sel.date} 的分时</span></div>
      </div>
      <footer class="intraday-foot">
        <span id="intraday-source">数据读取中</span>
        <span>双击 K 线任意一天可切换</span>
      </footer>
    </div>
  </div>`;
  const overlay = document.getElementById("intraday-overlay");
  if (!overlay) return;
  overlay.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-intraday-close]")) {
      closeOverlay();
      return;
    }
    const step = target.closest<HTMLElement>("[data-intraday-step]");
    if (step) {
      const delta = Number(step.dataset.intradayStep) || 0;
      if (delta) openIntradayAt(intradayIndex + delta);
      return;
    }
    if (target === overlay) closeOverlay();
  });
  void loadIntraday(sel);
}

/** 只改弹窗头部与左右按钮状态，不重建 DOM。 */
function syncIntradayHead(sel: IntradaySelection): void {
  const date = document.getElementById("intraday-date");
  if (date) date.textContent = `${sel.codeLabel} · ${sel.date}`;
  const tone = pctToneClass(sel.candle.pct);
  const price = document.getElementById("intraday-price");
  if (price) {
    price.textContent = fmtPrice(sel.candle.close);
    price.className = tone;
  }
  const pct = document.getElementById("intraday-pct");
  if (pct) {
    pct.textContent = fmtPct(sel.candle.pct);
    pct.className = tone;
  }
  const prev = document.querySelector<HTMLButtonElement>('[data-intraday-step="-1"]');
  const next = document.querySelector<HTMLButtonElement>('[data-intraday-step="1"]');
  if (prev) prev.disabled = sel.index <= 0;
  if (next) next.disabled = sel.index >= sel.total - 1;
  const source = document.getElementById("intraday-source");
  if (source) source.textContent = "读取中…";
}

async function loadIntraday(sel: IntradaySelection): Promise<void> {
  const stock = state.chartStock;
  if (!stock) return;
  const token = intradayToken;
  try {
    const payload = await api.getIntraday(sel.instrument, sel.date);
    if (token !== intradayToken || overlayKind !== "intraday") return;
    const stage = document.getElementById("intraday-stage");
    if (!stage) return;
    const base = sel.prevClose && sel.prevClose > 0 ? sel.prevClose : payload.prevClose ?? null;
    if (intradayChart) {
      // Keep the canvas: switching days only swaps the series in place.
      intradayChart.setData(payload.candles, base);
    } else {
      stage.innerHTML = "";
      intradayChart = new TimeShareChart(stage, {
        axisMode: "full",
        kind: stock.kind === "index" ? "index" : "stock",
      });
      intradayChart.setData(payload.candles, base);
    }
    const source = document.getElementById("intraday-source");
    if (source) {
      source.textContent =
        payload.source === "tencent"
          ? "腾讯分时点位 · 仅收盘价"
          : payload.source === "cache"
            ? "本地缓存"
            : "东方财富 1 分钟";
    }
    if (payload.warning) toast(payload.warning);
  } catch (e) {
    if (token !== intradayToken || overlayKind !== "intraday") return;
    const stage = document.getElementById("intraday-stage");
    if (!stage) return;
    intradayChart?.destroy();
    intradayChart = null;
    stage.innerHTML = `<div class="intraday-empty">
      <b>这一天的分时暂时取不到</b>
      <span>${esc(messageFrom(e, "接口没有返回当天的分钟数据"))}</span>
    </div>`;
    const source = document.getElementById("intraday-source");
    if (source) source.textContent = "没有数据";
  }
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
          <div class="setting-label" style="margin-top:18px">界面字号</div>
          <div class="scale-choice">
            <button class="scale-option ${state.uiScale < 1.06 ? "active" : ""}" data-ui-scale="1.02"><b>紧凑</b><em>102%</em></button>
            <button class="scale-option ${state.uiScale >= 1.06 && state.uiScale < 1.14 ? "active" : ""}" data-ui-scale="1.10"><b>舒适</b><em>110%</em></button>
            <button class="scale-option ${state.uiScale >= 1.14 ? "active" : ""}" data-ui-scale="1.18"><b>大字号</b><em>118%</em></button>
          </div>
          <p class="setting-hint" style="margin-top:8px">使用 WebView 系统缩放，K线会按新比例重绘，不会变模糊。</p>
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
            天梯 · A股涨停复盘　<b>v1.5.0</b><br />
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
  overlay.querySelectorAll<HTMLElement>("[data-ui-scale]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const scale = Number(btn.dataset.uiScale);
      if (!Number.isFinite(scale)) return;
      try {
        state.uiScale = await api.setUiScale(scale);
        overlay.querySelectorAll<HTMLElement>("[data-ui-scale]").forEach((b) => {
          b.classList.toggle("active", Number(b.dataset.uiScale) === state.uiScale);
        });
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        window.dispatchEvent(new Event("resize"));
        renderMain({ animate: false });
      } catch (e) {
        toast(messageFrom(e, "字号调整失败"), "error");
      }
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
