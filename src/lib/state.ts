import type {
  AuctionResult,
  CalendarInfo,
  ChartPrefs,
  ChartSelection,
  DataInfo,
  DayPayload,
  HistoryStatus,
  IndexQuote,
  KlinePayload,
  Period,
  PoolKind,
  ScreenResult,
  SearchItem,
  Stock,
  StockQuote,
  StrategyProfile,
  StrategyTab,
  Theme,
  ViewName,
  WatchGroup,
} from "./types";

export type PoolFilter = "all" | "streak" | "first" | "oneWord" | "turnover";
export type SortKey =
  | "streak"
  | "changeRate"
  | "sealAmount"
  | "turnoverRate"
  | "firstSeal"
  | "lastSeal"
  | "openNum"
  | "amount"
  | "name";

export interface AppState {
  theme: Theme;
  uiScale: number;
  calendar: CalendarInfo | null;
  date: string;
  day: DayPayload | null;
  dayLoading: boolean;
  refreshing: boolean;
  error: string | null;
  indices: IndexQuote[];
  view: ViewName;
  returnView: Exclude<ViewName, "chart"> | "chart";
  chartStock: ChartSelection | null;
  chartPeriod: Period;
  chartMode: "kline" | "timeshare";
  chartRanges: Record<Period, number>;
  timeshareAxis: "full" | "follow";
  timeshareZoom: number;
  chartData: KlinePayload | null;
  chartQuote: StockQuote | null;
  watchQuotes: Record<string, StockQuote>;
  chartLoading: boolean;
  chartError: string | null;
  chartRange: number;
  chartPrefs: ChartPrefs;
  poolKind: PoolKind;
  poolFilter: PoolFilter;
  poolSector: string;
  poolQuery: string;
  poolSort: { key: SortKey; dir: 1 | -1 };
  watchGroups: WatchGroup[];
  watchGroupId: number | null;
  watchCollapsed: boolean;
  chartDock: "watch" | "insight";
  timelineOrder: "asc" | "desc";
  dataInfo: DataInfo | null;
  sync: "idle" | "loading" | "live" | "cache" | "error";
  lastSyncAt: number;
  searchOpen: boolean;
  settingsOpen: boolean;
  strategyTab: StrategyTab;
  screen: ScreenResult | null;
  screenLoading: boolean;
  screenError: string | null;
  history: HistoryStatus | null;
  historyProgress: { done: number; total: number; current: string } | null;
  profile: StrategyProfile | null;
  profileSaving: boolean;
  profileOpen: boolean;
  auction: AuctionResult | null;
  auctionLoading: boolean;
  strategyDetailCode: string | null;
  strategyShowExcluded: boolean;
}

const DEFAULT_CHART_RANGES: Record<Period, number> = {
  "1m": 240,
  "15m": 120,
  "30m": 120,
  "60m": 120,
  day: 120,
  week: 120,
  month: 120,
  year: 120,
};

function loadChartRanges(): Record<Period, number> {
  const ranges = { ...DEFAULT_CHART_RANGES };
  try {
    const raw = JSON.parse(localStorage.getItem("tianti.chartRanges") || "null") as Record<string, unknown> | null;
    if (raw && typeof raw === "object") {
      (Object.keys(ranges) as Period[]).forEach((key) => {
        const value = Number(raw[key]);
        if (Number.isFinite(value) && value >= 0) ranges[key] = value;
      });
    }
  } catch {
    // localStorage may be unavailable in a fresh webview; defaults are fine.
  }
  return ranges;
}

function loadTimelineOrder(): "asc" | "desc" {
  try {
    return localStorage.getItem("tianti.timelineOrder") === "desc" ? "desc" : "asc";
  } catch {
    return "asc";
  }
}

function loadTimeshareAxis(): "full" | "follow" {  try {
    return localStorage.getItem("tianti.timeshareAxis") === "follow" ? "follow" : "full";
  } catch {
    return "full";
  }
}

function loadTimeshareZoom(): number {
  try {
    const raw = localStorage.getItem("tianti.timeshareZoom");
    if (raw == null || raw === "") return 1;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0.55, Math.min(2.2, value)) : 1;
  } catch {
    return 1;
  }
}

const initialChartRanges = loadChartRanges();

export const state: AppState = {
  theme: "dark",
  uiScale: 1.10,
  calendar: null,
  date: "",
  day: null,
  dayLoading: true,
  refreshing: false,
  error: null,
  indices: [],
  view: "ladder",
  returnView: "ladder",
  chartStock: null,
  chartPeriod: "day",
  chartMode: "kline",
  chartRanges: initialChartRanges,
  timeshareAxis: loadTimeshareAxis(),
  timeshareZoom: loadTimeshareZoom(),
  chartData: null,
  chartQuote: null,
  watchQuotes: {},
  chartLoading: false,
  chartError: null,
  chartRange: initialChartRanges.day,
  chartPrefs: {
    maEnabled: false,
    maLines: [
      { period: 5, color: "sky", width: 1, dashed: true, visible: true },
      { period: 10, color: "amber", width: 1, dashed: true, visible: true },
      { period: 20, color: "violet", width: 1, dashed: true, visible: true },
      { period: 60, color: "brass", width: 1, dashed: true, visible: true },
    ],
    emaEnabled: true,
    emaLines: [
      { period: 5, color: "brass", width: 1.2, dashed: false, visible: true },
      { period: 10, color: "up", width: 1.2, dashed: false, visible: true },
      { period: 20, color: "down", width: 1.2, dashed: false, visible: true },
      { period: 60, color: "violet", width: 1.2, dashed: false, visible: true },
    ],
    kdjEnabled: true,
    kdjN: 9,
    kdjK: 3,
    kdjD: 3,
  },
  poolKind: "limitUp",
  poolFilter: "all",
  poolSector: "",
  poolQuery: "",
  poolSort: { key: "streak", dir: -1 },
  watchGroups: [],
  watchGroupId: null,
  watchCollapsed: false,
  chartDock: "watch",
  timelineOrder: loadTimelineOrder(),
  dataInfo: null,
  sync: "idle",
  lastSyncAt: 0,
  searchOpen: false,
  settingsOpen: false,
  strategyTab: "firstToSecond",
  screen: null,
  screenLoading: false,
  screenError: null,
  history: null,
  historyProgress: null,
  profile: null,
  profileSaving: false,
  profileOpen: false,
  auction: null,
  auctionLoading: false,
  strategyDetailCode: null,
  strategyShowExcluded: false,
};

export function parseHash(): { view: ViewName; code: string } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [view, code] = raw.split("/");
  if (view === "pool") return { view: "pool", code: "" };
  if (view === "timeline") return { view: "timeline", code: "" };
  if (view === "strategy") return { view: "strategy", code: "" };
  if (view === "chart" && code) return { view: "chart", code };
  return { view: "ladder", code: "" };
}

export function isToday(date: string): boolean {
  return Boolean(state.calendar && date === state.calendar.today);
}

function reviewDates(): string[] {
  const dates = state.calendar?.dates ?? [];
  const today = state.calendar?.today;
  return today ? dates.filter((d) => d <= today) : dates;
}

export function neighbors(): { prev: string | null; next: string | null } {
  const dates = reviewDates();
  if (!dates.length || !state.date) return { prev: null, next: null };
  const exact = dates.indexOf(state.date);
  if (exact >= 0) {
    return {
      prev: exact > 0 ? dates[exact - 1] : null,
      next: exact < dates.length - 1 ? dates[exact + 1] : null,
    };
  }
  const before = dates.filter((d) => d < state.date);
  const after = dates.filter((d) => d > state.date);
  return {
    prev: before.length ? before[before.length - 1] : null,
    next: after.length ? after[0] : null,
  };
}

export function availableDates(): string[] {
  return reviewDates();
}

export function currentSectorName(): string {
  if (!state.poolSector || !state.day) return "";
  const sec = state.day.sectors.find((s) => s.code === state.poolSector);
  return sec?.name ?? "";
}

export function findStock(code: string): Stock | undefined {
  return state.day?.stocks.find((s) => s.code === code);
}

export function poolStocks(): Stock[] {
  if (!state.day) return [];
  if (state.poolKind === "openLimit") return state.day.openLimit;
  if (state.poolKind === "limitDown") return state.day.limitDown;
  return state.day.stocks;
}

export function filterStocks(): Stock[] {
  const day = state.day;
  if (!day) return [];
  const q = state.poolQuery.trim().toLowerCase();
  const sector = state.poolKind === "limitUp" && state.poolSector
    ? day.sectors.find((s) => s.code === state.poolSector)?.name
    : null;
  const list = poolStocks().filter((s) => {
    if (state.poolKind === "limitUp") {
      if (state.poolFilter === "streak" && s.streak < 2) return false;
      if (state.poolFilter === "first" && s.streak > 1) return false;
      if (state.poolFilter === "oneWord" && !s.limitType.includes("一字")) return false;
      if (state.poolFilter === "turnover" && !s.limitType.includes("换手")) return false;
      if (sector && !s.sectors.includes(sector)) return false;
    }
    if (q) {
      const hit =
        s.code.includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.reason.toLowerCase().includes(q) ||
        s.sectors.some((x) => x.toLowerCase().includes(q));
      if (!hit) return false;
    }
    return true;
  });
  const { key, dir } = state.poolSort;
  list.sort((a, b) => {
    if (key === "name") return a.name.localeCompare(b.name, "zh-CN") * dir;
    const av = Number(a[key]);
    const bv = Number(b[key]);
    if (av !== bv) return (av - bv) * dir;
    return (a.streak - b.streak) * -1;
  });
  return list;
}

export function recentItems(items: SearchItem[]): SearchItem[] {
  return items.slice(0, 6);
}

export function rangeStart(candles: KlinePayload["candles"], range: number): number {
  if (!range || candles.length <= range) return 0;
  return candles.length - range;
}
