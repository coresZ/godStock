export type Theme = "dark" | "light";
export type Period = "1m" | "15m" | "30m" | "60m" | "day" | "week" | "month" | "year";
export type ChartMode = "kline" | "timeshare";
export type ViewName = "ladder" | "pool" | "timeline" | "chart" | "strategy";
export type PoolKind = "limitUp" | "openLimit" | "limitDown";
export type StrategyTab = "firstToSecond" | "auction" | "library";

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
  prevClose?: number | null;
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
  source?: string;
  asOf?: string;
  stale?: boolean;
}

export interface StockQuote {
  code: string;
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  change: number;
  pct: number;
  volume: number;
  amount: number;
  turnover: number;
  asOf: string;
  source: string;
  stale: boolean;
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
  visible: boolean;
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

/* ————————————————— strategy ————————————————— */

export interface RuleCheck {
  key: string;
  label: string;
  passed: boolean | null;
  value: string;
  threshold: string;
  note?: string | null;
}

export interface CandidateStats {
  price: number;
  floatCap: number;
  amount: number;
  amountEstimated: boolean;
  sealAmount: number;
  sealRatio: number | null;
  firstSeal: number;
  firstSealMinute: number;
  openNum: number;
  turnoverRate: number;
  limitUp120d: number | null;
  maxStreak250d: number | null;
  maxGain20d: number | null;
  sectorName: string;
  sectorLimitUps: number;
  sectorContinuous: number;
}

export interface ScreenCandidate {
  code: string;
  name: string;
  rank: number | null;
  score: number;
  checks: RuleCheck[];
  stats: CandidateStats;
  missing: string[];
}

export interface ExcludedStock {
  code: string;
  name: string;
  failed: string[];
}

export interface HistoryStatus {
  firstDate: string;
  lastDate: string;
  days: number;
  expectedDays: number;
  syncing: boolean;
  updatedAt: number;
}

export interface ScreenResult {
  date: string;
  universe: number;
  hardPassed: number;
  candidates: ScreenCandidate[];
  excluded: ExcludedStock[];
  warnings: string[];
  history: HistoryStatus;
  hasAmount: boolean;
}

export interface StrategyProfile {
  maxPrice: number;
  maxFloatCap: number;
  minLimitCount: number;
  limitWindowDays: number;
  maxStreak: number;
  maxGain20d: number;
  minSectorLimitUps: number;
  minSectorContinuous: number;
  minSealRatio: number;
  maxOpenNum: number;
  latestFirstSealMinute: number;
  minTurnover: number;
  topN: number;
  updatedAt: number;
}

export interface AuctionRow {
  code: string;
  name: string;
  price: number;
  prevClose: number;
  open: number;
  volume: number;
  amount: number;
  turnover: number;
  auctionPct: number;
  amountRatio: number | null;
  capturedAt: number;
}

export interface AuctionResult {
  date: string;
  captured: boolean;
  capturedAt: number;
  inWindow: boolean;
  rows: AuctionRow[];
  warnings: string[];
}
