import type {
  AuctionResult,
  CalendarInfo,
  ChartPrefs,
  DataInfo,
  DayPayload,
  HistoryStatus,
  IndexQuote,
  KlinePayload,
  StockQuote,
  Period,
  ScreenResult,
  SearchItem,
  Settings,
  StrategyProfile,
  Theme,
  WatchAddResult,
  WatchGroup,
  WatchStock,
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
  appReady: () => call<void>("app_ready"),
  getCalendar: (refresh = false) => call<CalendarInfo>("get_calendar", { refresh }),
  getDay: (date: string, refresh = false) => call<DayPayload>("get_day", { date, refresh }),
  getKline: (code: string, period: Period, refresh = false, allowMinuteFallback = false) =>
    call<KlinePayload>("get_kline", { code, period, refresh, allowMinuteFallback }),
  getIndexKline: (
    secid: string,
    name: string,
    period: Period,
    refresh = false,
    allowMinuteFallback = false,
  ) =>
    call<KlinePayload>("get_index_kline", {
      secid,
      name,
      period,
      refresh,
      allowMinuteFallback,
    }),
  getIndices: (refresh = false) => call<IndexQuote[]>("get_indices", { refresh }),
  getStockQuote: (code: string) => call<StockQuote>("get_stock_quote", { code }),
  getStockQuotes: (codes: string[]) => call<StockQuote[]>("get_stock_quotes", { codes }),
  getIndexQuote: (secid: string) => call<StockQuote>("get_index_quote", { secid }),
  searchStocks: (query: string) => call<SearchItem[]>("search_stocks", { query }),
  recentStocks: () => call<SearchItem[]>("recent_stocks"),
  getSettings: () => call<Settings>("get_settings"),
  setTheme: (theme: Theme) => call<void>("set_theme", { theme }),
  setUiScale: (scale: number) => call<number>("set_ui_scale", { scale }),
  exportText: (filename: string, content: string) =>
    call<string>("export_text", { filename, content }),
  getDataInfo: () => call<DataInfo>("get_data_info"),
  clearCache: () => call<void>("clear_cache"),
  getHistoryStatus: () => call<HistoryStatus>("get_history_status"),
  syncLimitHistory: (days: number, refresh = false) =>
    call<HistoryStatus>("sync_limit_history", { days, refresh }),
  getStrategyProfile: () => call<StrategyProfile>("get_strategy_profile"),
  saveStrategyProfile: (profile: StrategyProfile) =>
    call<StrategyProfile>("save_strategy_profile", { profile }),
  runFirstToSecond: (date: string, refresh = false) =>
    call<ScreenResult>("run_first_to_second", { date, refresh }),
  captureAuction: (date: string) => call<AuctionResult>("capture_auction", { date }),
  getAuction: (date: string) => call<AuctionResult>("get_auction", { date }),
  getWatchGroups: () => call<WatchGroup[]>("get_watch_groups"),
  createWatchGroup: (name: string) => call<number>("create_watch_group", { name }),
  renameWatchGroup: (id: number, name: string) => call<void>("rename_watch_group", { id, name }),
  deleteWatchGroup: (id: number) => call<void>("delete_watch_group", { id }),
  addWatchStocks: (groupId: number, stocks: WatchStock[]) =>
    call<WatchAddResult>("add_watch_stocks", { groupId, stocks }),
  removeWatchStock: (groupId: number, code: string) =>
    call<void>("remove_watch_stock", { groupId, code }),
  getChartPrefs: () => call<ChartPrefs>("get_chart_prefs"),
  saveChartPrefs: (prefs: ChartPrefs) => call<void>("save_chart_prefs", { prefs }),
  windowControl: (action: "drag" | "minimize" | "maximize" | "close") =>
    call<void>("window_control", { action }),
  openDataDir: () => call<void>("open_data_dir"),
};

export const isTauri = () => Boolean(tauri());
