import type {
  CalendarInfo,
  ChartPrefs,
  ChartSelection,
  DataInfo,
  DayPayload,
  IndexQuote,
  KlinePayload,
  Period,
  PoolKind,
  SearchItem,
  Stock,
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
  chartData: KlinePayload | null;
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
  dataInfo: DataInfo | null;
  sync: "idle" | "loading" | "live" | "cache" | "error";
  lastSyncAt: number;
  searchOpen: boolean;
  settingsOpen: boolean;
}

export const state: AppState = {
  theme: "dark",
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
  chartData: null,
  chartLoading: false,
  chartError: null,
  chartRange: 120,
  chartPrefs: {
    maEnabled: false,
    maPeriods: [5, 10, 20, 60],
    emaEnabled: true,
    emaPeriods: [5, 10, 20, 60],
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
  dataInfo: null,
  sync: "idle",
  lastSyncAt: 0,
  searchOpen: false,
  settingsOpen: false,
};

export function parseHash(): { view: ViewName; code: string } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [view, code] = raw.split("/");
  if (view === "pool") return { view: "pool", code: "" };
  if (view === "timeline") return { view: "timeline", code: "" };
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
