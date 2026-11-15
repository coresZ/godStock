import type {
  CalendarInfo,
  DataInfo,
  DayPayload,
  IndexQuote,
  KlinePayload,
  Period,
  SearchItem,
  Settings,
  Theme,
} from "./types";

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
      };
    };
  }
}

const tauri = () => window.__TAURI__?.core?.invoke;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = tauri();
  if (invoke) return invoke<T>(cmd, args);
  if (import.meta.env.DEV) {
    const mock = await import("./mockApi");
    return mock.mockInvoke<T>(cmd, args);
  }
  throw new Error("应用桥接未就绪，请重新启动天梯");
}

export const api = {
  getCalendar: (refresh = false) => call<CalendarInfo>("get_calendar", { refresh }),
  getDay: (date: string, refresh = false) => call<DayPayload>("get_day", { date, refresh }),
  getKline: (code: string, period: Period, refresh = false) =>
    call<KlinePayload>("get_kline", { code, period, refresh }),
  getIndices: (refresh = false) => call<IndexQuote[]>("get_indices", { refresh }),
  searchStocks: (query: string) => call<SearchItem[]>("search_stocks", { query }),
  recentStocks: () => call<SearchItem[]>("recent_stocks"),
  getSettings: () => call<Settings>("get_settings"),
  setTheme: (theme: Theme) => call<void>("set_theme", { theme }),
  getDataInfo: () => call<DataInfo>("get_data_info"),
  clearCache: () => call<void>("clear_cache"),
  windowControl: (action: "minimize" | "maximize" | "close") =>
    call<void>("window_control", { action }),
  openDataDir: () => call<void>("open_data_dir"),
};

export const isTauri = () => Boolean(tauri());
