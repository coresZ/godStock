export type Theme = "dark" | "light";
export type Period = "1m" | "15m" | "30m" | "60m" | "day" | "week" | "month" | "year";
export type ChartMode = "kline" | "timeshare";
export type ViewName = "ladder" | "pool" | "timeline" | "chart" | "strategy" | "other";
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

export interface IntradayPayload {
  code: string;
  name: string;
  date: string;
  candles: KlineCandle[];
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

export type StrategyStage = "firstBoard" | "hardPassed" | "candidates" | "watch";

/** 涨停池里一只票当前所处阶段，供漏斗点击后展示。 */
export interface ScreenStock {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  board: number;
  firstSeal: number;
  score: number;
  rank: number | null;
  firstBoard: boolean;
  hardPassed: boolean;
  candidate: boolean;
  failed: string[];
  pending: boolean;
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
  stocks: ScreenStock[];
  candidates: ScreenCandidate[];
  excluded: ExcludedStock[];
  warnings: string[];
  history: HistoryStatus;
  hasAmount: boolean;
  /** 直接命中「同日期 + 同参数 + 同历史覆盖」的缓存 */
  cached: boolean;
  /** 结果生成时间（unix 秒），用于界面展示缓存新鲜度 */
  computedAt: number;
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

/* ————————————————— other · 模块切换 ————————————————— */

/** 「其他」页的两个模块：游资动态（龙虎榜） / 同花顺自选（问财只读同步）。 */
export type OtherModule = "lhb" | "iwc";

/* ————————————————— other · 游资动态（龙虎榜） ————————————————— */

export type OtherTab = "board" | "yyz" | "org" | "agency";
export type LhbSource = "network" | "cache";
export type LhbSortKey = "net" | "pct" | "seats";

/** 龙虎榜买 / 卖席位。金额单位：元；tags 来自本地游资名号库。 */
export interface LhbSeat {
  id: string;
  name: string;
  buy: number;
  sell: number;
  net: number;
  tags: string[];
  /** 0 无 · 1 一线游资 · 2 顶级游资 · 3 知名游资（接口 YouZiIcon） */
  level: number;
  /** 关联席位（接口 AssocIcon） */
  assoc: boolean;
  /** 昨日上榜买 / 卖次数（接口 ytdbusin），0 表示无 */
  ydayBuy: number;
  ydaySell: number;
}

/** 一只票当日可能因多个上榜理由各有一组买卖席位。 */
export interface LhbReasonBlock {
  reasons: string[];
  buyTotal: number;
  sellTotal: number;
  buy: LhbSeat[];
  sell: LhbSeat[];
}

export interface LhbDetail {
  code: string;
  name: string;
  /** YYYYMMDD */
  date: string;
  pct: number;
  turnoverRate: number;
  /** 流通市值（亿元） */
  circulation: number;
  netBuy: number;
  seatCount: number;
  /** 近期上榜日期，新 → 旧，YYYYMMDD */
  onTime: string[];
  blocks: LhbReasonBlock[];
  source: LhbSource;
  fetchedAt: number;
  warning: string | null;
}

export interface LhbStock {
  code: string;
  name: string;
  pct: number;
  netBuy: number;
  seats: number;
  turnover: number;
  turnoverRate: number;
  floatCap: number;
  marketCap: number;
  /** “5板” / “3天2板” / “首板” / ""（东财涨停池补充，失败为空） */
  board: string;
  sector: string;
}

export interface LhbBoard {
  /** 前端请求的日期，YYYYMMDD */
  requestedDate: string;
  /** 实际有数据的日期，YYYYMMDD；无数据回退时与 requestedDate 不同 */
  date: string;
  fallback: boolean;
  rows: LhbStock[];
  source: LhbSource;
  fetchedAt: number;
  warning: string | null;
}

export interface LhbAgency {
  id: string;
  name: string;
  buy: number;
  sell: number;
  net: number;
  /** 关联个股数（接口 JoinNum） */
  joinCount: number;
  tags: string[];
}

export interface LhbHotSeat {
  id: string;
  name: string;
  buy: number;
  sell: number;
  net: number;
}

/** 按游资名号聚合的席位榜（同一席位命中多个名号时分别计入）。 */
export interface LhbHotMoneyTag {
  tag: string;
  buy: number;
  sell: number;
  net: number;
  seats: LhbHotSeat[];
}

export interface LhbAgencies {
  date: string;
  rows: LhbAgency[];
  hot: LhbHotMoneyTag[];
  source: LhbSource;
  fetchedAt: number;
  warning: string | null;
}

export interface LhbInstitution {
  code: string;
  name: string;
  pct: number;
  netBuy: number;
  /** 上榜机构数（接口 JoinNum） */
  orgCount: number;
  turnover: number;
  turnoverRate: number;
  board: string;
  sector: string;
}

export interface LhbInstitutions {
  date: string;
  rows: LhbInstitution[];
  source: LhbSource;
  fetchedAt: number;
  warning: string | null;
}

export interface LhbSeatTrade {
  /** YYYYMMDD */
  date: string;
  code: string;
  name: string;
  pct: number;
  buy: number;
  sell: number;
  net: number;
  /** 该条记录来自「三日榜」(D3=1)，与当日榜口径不同 */
  threeDay: boolean;
}

/** 单个营业部最近 N 天的上榜个股记录。 */
export interface LhbSeatLog {
  seatId: string;
  rows: LhbSeatTrade[];
  days: number;
  /** 上游返回的原始记录数（可能大于 rows.length） */
  total: number;
  /** rows 是否被上游上限截断（目前最多 200 条） */
  truncated: boolean;
  source: LhbSource;
  fetchedAt: number;
  warning: string | null;
}

/* ————————————————— other · 同花顺自选（问财只读同步） ————————————————— */

/** 登录态：问财 / 同花顺各自是否已登录，userId 由后端脱敏或原样返回。 */
export interface IwcAuthStatus {
  iwcLoggedIn: boolean;
  thsLoggedIn: boolean;
  userId: string;
}

/** 自选股 / 板块成分股。market："1" 沪市 · "0" 深市。 */
export interface IwcStock {
  code: string;
  market: string;
  name: string;
}

/** 问财自选板块。condition 非空表示动态条件板块（成分股随条件变化）。 */
export interface IwcPlate {
  sn: string;
  name: string;
  condition: string;
  sort: number;
  members: IwcStock[];
}

/** 一次只读同步的完整结果；syncedAt 为 unix 秒。 */
export interface IwcSnapshot {
  plates: IwcPlate[];
  selfStocks: IwcStock[];
  syncedAt: number;
  userId: string;
  warnings: string[];
}
