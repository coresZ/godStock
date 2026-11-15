export type Theme = "dark" | "light";
export type Period = "1m" | "15m" | "30m" | "60m" | "day" | "week" | "month" | "year";
export type ViewName = "ladder" | "pool" | "timeline" | "chart";
export type PoolKind = "limitUp" | "openLimit" | "limitDown";

export interface Stock {
  code: string;
  name: string;
  board: number;
  days: number;
  streak: number;
  highDays: string;
  price: number;
  changeRate: number;
  turnoverRate: number;
  amount: number;
  sealAmount: number;
  firstSeal: number;
  lastSeal: number;
  openNum: number;
  limitType: string;
  reason: string;
  reasonTags: string[];
  market: string;
  marketId: number;
  successRate: number;
  floatCap: number;
  isNew: boolean;
  isAgainLimit: boolean;
  spark: number[];
  sectors: string[];
  primarySector: string | null;
}

export interface Sector {
  code: string;
  name: string;
  change: number;
  limitUpNum: number;
  continuousNum: number;
  highDays: string;
  days: number;
  stockCodes: string[];
}

export interface DayStats {
  total: number;
  consecutive: number;
  firstBoard: number;
  maxStreak: number;
  oneWord: number;
  earlySeal: number;
  avgSeal: number;
  avgSuccess: number;
  openLimit: number;
  limitDown: number;
}

export interface DayPayload {
  date: string;
  weekday: string;
  stats: DayStats;
  stocks: Stock[];
  openLimit: Stock[];
  limitDown: Stock[];
  sectors: Sector[];
  fetchedAt: number;
  source: string;
  warning: string | null;
}

export interface CalendarInfo {
  today: string;
  isTradeDay: boolean;
  initialDate: string;
  dates: string[];
  source: string;
  warning: string | null;
}

export interface KlineCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  pct: number;
  turnover: number;
}

export interface KlinePayload {
  code: string;
  name: string;
  period: Period;
  candles: KlineCandle[];
  latestDate: string;
  source: string;
  warning: string | null;
}

export interface IndexQuote {
  code: string;
  name: string;
  price: number;
  change: number;
  pct: number;
  spark: number[];
}

export interface SearchItem {
  code: string;
  name: string;
  market: string;
  securityType: string;
}

export interface Settings {
  theme: Theme;
  uiScale: number;
}

export interface WatchStock {
  code: string;
  name: string;
  market: string;
}

export interface WatchGroup {
  id: number;
  name: string;
  stocks: WatchStock[];
}

export interface WatchAddResult {
  added: number;
  skipped: number;
}

export interface IndicatorLine {
  period: number;
  color: string;
  width: number;
  dashed: boolean;
}

export interface ChartPrefs {
  maEnabled: boolean;
  maLines: IndicatorLine[];
  emaEnabled: boolean;
  emaLines: IndicatorLine[];
  kdjEnabled: boolean;
  kdjN: number;
  kdjK: number;
  kdjD: number;
}

export interface ChartSelection {
  code: string;
  name: string;
  market: string;
  kind: "stock" | "index";
  secid?: string;
}

export interface DataInfo {
  dataDir: string;
  dbPath: string;
  dbBytes: number;
  dayCount: number;
  klineCount: number;
  firstDate: string;
  lastDate: string;
}
