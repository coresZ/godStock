import type {
  AuctionResult,
  AuctionRow,
  CalendarInfo,
  CandidateStats,
  DataInfo,
  DayPayload,
  ExcludedStock,
  HistoryStatus,
  IndexQuote,
  KlinePayload,
  RuleCheck,
  ScreenCandidate,
  ScreenResult,
  SearchItem,
  StrategyProfile,
} from "./types";
import { mockCalendar, mockDay, mockIndices, mockKlines, mockRecent } from "./mock";

const delay = (ms = 220) => new Promise((r) => setTimeout(r, ms));

/* ————————————————— strategy mock (dev only) ————————————————— */

interface MockStock {
  code: string;
  name: string;
  streak: number;
  price: number;
  floatCap: number;
  turnoverRate: number;
  sealAmount: number;
  openNum: number | null;
  primarySector: string | null;
  sectors: string[];
}

interface MockSector {
  name: string;
  limitUpNum: number;
  continuousNum: number;
}

const dayStocks = mockDay.stocks as unknown as MockStock[];
const daySectors = mockDay.sectors as unknown as MockSector[];

const STRATEGY_DEFAULTS: StrategyProfile = {
  maxPrice: 30,
  maxFloatCap: 2e10,
  minLimitCount: 3,
  limitWindowDays: 120,
  maxStreak: 4,
  maxGain20d: 60,
  minSectorLimitUps: 3,
  minSectorContinuous: 1,
  minSealRatio: 0.1,
  maxOpenNum: 0,
  latestFirstSealMinute: 30,
  minTurnover: 5,
  topN: 3,
  updatedAt: 0,
};

let strategyProfile: StrategyProfile = {
  ...STRATEGY_DEFAULTS,
  updatedAt: Date.now() - 86_400_000,
};

let historyStatus: HistoryStatus = {
  firstDate: "20251119",
  lastDate: "20261118",
  days: 250,
  expectedDays: 250,
  syncing: false,
  updatedAt: Date.now() - 3_600_000,
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function clockOf(minute: number): string {
  const total = 570 + minute;
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** 竞价/首封分钟 → 当日时间戳（北京时间 09:30 = 570 分钟）。 */
function stampAt(date: string, minute: number): number {
  const y = Number(date.slice(0, 4));
  const mo = Number(date.slice(4, 6)) - 1;
  const d = Number(date.slice(6, 8));
  return Math.floor(Date.UTC(y, mo, d, 1, 30 + minute, 0) / 1000);
}

function normalizeDate(value: unknown): string {
  const raw = String(value ?? "").replace(/-/g, "");
  return /^\d{8}$/.test(raw) ? raw : mockDay.date;
}

function findStock(code: string): MockStock | undefined {
  return dayStocks.find((s) => s.code === code);
}

function sectorTally(name: string): { limitUps: number; continuous: number } {
  const hit = name ? daySectors.find((s) => s.name === name) : undefined;
  return { limitUps: hit?.limitUpNum ?? 0, continuous: hit?.continuousNum ?? 0 };
}

interface ScreenSeed {
  code: string;
  sealRatio: number | null;
  firstSealMinute: number;
  openNum: number;
  turnover: number;
  limitUp120d: number;
  maxStreak250d: number;
  maxGain20d: number;
  sector: string;
  missingAmount?: boolean;
  estimatedAmount?: boolean;
}

/** 8 只候选：4 只全通过、1 只因成交额缺失为 unknown、3 只分别踩到不同红线。 */
const SCREEN_SEEDS: ScreenSeed[] = [
  { code: "600715", sealRatio: 0.164, firstSealMinute: 1, openNum: 0, turnover: 10.9, limitUp120d: 9, maxStreak250d: 3, maxGain20d: 41.6, sector: "文化传媒概念" },
  { code: "002425", sealRatio: 0.142, firstSealMinute: 5, openNum: 0, turnover: 13.7, limitUp120d: 6, maxStreak250d: 2, maxGain20d: 55.4, sector: "文化传媒概念" },
  { code: "002685", sealRatio: 0.128, firstSealMinute: -5, openNum: 0, turnover: 11.1, limitUp120d: 11, maxStreak250d: 4, maxGain20d: 48.2, sector: "芯片概念" },
  { code: "603767", sealRatio: 0.118, firstSealMinute: 12, openNum: 0, turnover: 7.0, limitUp120d: 5, maxStreak250d: 2, maxGain20d: 44.9, sector: "新能源汽车" },
  { code: "002520", sealRatio: null, firstSealMinute: 6, openNum: 0, turnover: 24.8, limitUp120d: 7, maxStreak250d: 5, maxGain20d: 52.4, sector: "新能源汽车", missingAmount: true },
  { code: "002905", sealRatio: 0.061, firstSealMinute: 2, openNum: 0, turnover: 6.4, limitUp120d: 4, maxStreak250d: 3, maxGain20d: 36.8, sector: "文化传媒概念", estimatedAmount: true },
  { code: "605318", sealRatio: 0.052, firstSealMinute: 96, openNum: 0, turnover: 8.6, limitUp120d: 2, maxStreak250d: 2, maxGain20d: 63.7, sector: "" },
  { code: "603103", sealRatio: 0.042, firstSealMinute: 3, openNum: 0, turnover: 6.3, limitUp120d: 2, maxStreak250d: 3, maxGain20d: 39.4, sector: "文化传媒概念" },
];

const EXCLUDED_STOCKS: ExcludedStock[] = [
  {
    code: "600977",
    name: "中国电影",
    failed: ["流通市值 318.3 亿 > 200.0 亿", "开板 6 次 > 0 次", "首封 10:08 晚于 10:00"],
  },
  {
    code: "001393",
    name: "维通利",
    failed: ["股价 43.14 元 > 30.00 元", "首封 11:05 晚于 10:00"],
  },
  {
    code: "002739",
    name: "儒意电影",
    failed: ["流通市值 209.2 亿 > 200.0 亿", "首封 10:39 晚于 10:00"],
  },
  {
    code: "002124",
    name: "天邦食品",
    failed: ["开板 4 次 > 0 次", "首封 10:21 晚于 10:00"],
  },
];

function buildCandidate(seed: ScreenSeed, rule: StrategyProfile, date: string): ScreenCandidate {
  const stock = findStock(seed.code);
  const price = round2(stock?.price ?? 10);
  const floatCap = Math.round(stock?.floatCap ?? 5_000_000_000);
  const turnover = round2(seed.turnover);
  const amount = seed.missingAmount ? 0 : Math.round((turnover / 100) * floatCap);
  const sealRatio = seed.missingAmount ? null : seed.sealRatio;
  const sealAmount = seed.missingAmount
    ? Math.round(stock?.sealAmount ?? 0)
    : Math.round(amount * (sealRatio ?? 0));
  const sector = sectorTally(seed.sector);
  const ratioPct = sealRatio == null ? 0 : sealRatio * 100;
  const score = Math.max(
    12,
    Math.min(
      99.5,
      round1(
        60 +
          Math.min(20, seed.limitUp120d * 1.8) +
          Math.min(14, ratioPct * 0.7) +
          Math.min(10, turnover * 0.45) -
          seed.openNum * 5 -
          Math.max(0, seed.firstSealMinute) * 0.22 -
          Math.max(0, seed.maxGain20d - 45) * 0.25,
      ),
    ),
  );

  const checks: RuleCheck[] = [
    {
      key: "price",
      label: "股价",
      passed: price <= rule.maxPrice,
      value: `${price.toFixed(2)} 元`,
      threshold: `≤ ${rule.maxPrice.toFixed(2)} 元`,
    },
    {
      key: "floatCap",
      label: "流通市值",
      passed: floatCap <= rule.maxFloatCap,
      value: `${round1(floatCap / 1e8)} 亿`,
      threshold: `≤ ${round1(rule.maxFloatCap / 1e8)} 亿`,
    },
    {
      key: "limitCount",
      label: `近 ${rule.limitWindowDays} 日涨停`,
      passed: seed.limitUp120d >= rule.minLimitCount,
      value: `${seed.limitUp120d} 次`,
      threshold: `≥ ${rule.minLimitCount} 次`,
    },
    {
      key: "overheat",
      label: "近 20 日最大涨幅",
      passed: seed.maxGain20d <= rule.maxGain20d,
      value: `${round1(seed.maxGain20d)}%`,
      threshold: `≤ ${round1(rule.maxGain20d)}%`,
    },
    {
      key: "sector",
      label: "板块强度",
      passed: sector.limitUps >= rule.minSectorLimitUps && sector.continuous >= rule.minSectorContinuous,
      value: seed.sector ? `${seed.sector} ${sector.limitUps} 家 / ${sector.continuous} 连板` : "未归类（无板块归属）",
      threshold: `涨停 ≥ ${rule.minSectorLimitUps} 且连板 ≥ ${rule.minSectorContinuous}`,
    },
    {
      key: "firstSeal",
      label: "首封时间",
      passed: seed.firstSealMinute <= rule.latestFirstSealMinute,
      value: clockOf(seed.firstSealMinute),
      threshold: `≤ ${clockOf(rule.latestFirstSealMinute)}`,
    },
    {
      key: "openNum",
      label: "开板次数",
      passed: seed.openNum <= rule.maxOpenNum,
      value: `${seed.openNum} 次`,
      threshold: `≤ ${rule.maxOpenNum} 次`,
    },
    {
      key: "sealRatio",
      label: "封单比",
      passed: sealRatio == null ? null : sealRatio >= rule.minSealRatio,
      value: sealRatio == null ? "—" : `${round1(ratioPct)}%`,
      threshold: `≥ ${round1(rule.minSealRatio * 100)}%`,
      note: sealRatio == null ? "成交额缺失，封单比未计算" : null,
    },
    {
      key: "turnover",
      label: "换手率",
      passed: turnover >= rule.minTurnover,
      value: `${round1(turnover)}%`,
      threshold: `≥ ${round1(rule.minTurnover)}%`,
    },
  ];

  const stats: CandidateStats = {
    price,
    floatCap,
    amount,
    amountEstimated: seed.estimatedAmount === true && !seed.missingAmount,
    sealAmount,
    sealRatio,
    firstSeal: stampAt(date, seed.firstSealMinute),
    firstSealMinute: seed.firstSealMinute,
    openNum: seed.openNum,
    turnoverRate: turnover,
    limitUp120d: seed.limitUp120d,
    maxStreak250d: seed.maxStreak250d,
    maxGain20d: seed.maxGain20d,
    sectorName: seed.sector || "未归类",
    sectorLimitUps: sector.limitUps,
    sectorContinuous: sector.continuous,
  };

  return {
    code: seed.code,
    name: stock?.name ?? seed.code,
    rank: null,
    score,
    checks,
    stats,
    missing: seed.missingAmount ? ["成交额"] : [],
  };
}

function buildScreen(date: string): ScreenResult {
  const all = SCREEN_SEEDS.map((seed) => buildCandidate(seed, strategyProfile, date));
  const hardKeys = new Set(["price", "floatCap", "limitCount", "overheat", "sector"]);
  const hardPassed = all.filter((c) =>
    c.checks.filter((ch) => hardKeys.has(ch.key)).every((ch) => ch.passed === true),
  ).length;
  const candidates = all.filter((c) => c.checks.every((ch) => ch.passed === true));
  [...candidates]
    .sort((a, b) => b.score - a.score)
    .forEach((c, index) => {
      c.rank = index + 1;
    });
  const missingAmount = all.filter((c) => c.missing.includes("成交额"));

  return {
    date,
    universe: dayStocks.filter((s) => s.streak <= 1).length,
    hardPassed,
    candidates: [...candidates].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)),
    excluded: EXCLUDED_STOCKS,
    warnings: [
      `历史涨停库覆盖 ${historyStatus.firstDate}–${historyStatus.lastDate}，共 ${historyStatus.days} 个交易日`,
      ...missingAmount.map((c) => `${c.code} ${c.name} 缺少成交额，封单比按数据不足处理`),
    ],
    history: { ...historyStatus },
    hasAmount: true,
  };
}

interface AuctionSeed {
  code: string;
  pct: number;
  ratio: number;
}

/** 竞价 6 行：auctionPct 1.7%–6.2%，amountRatio 0.09–0.17，竞价换手 0.6%–1.7%。 */
const AUCTION_SEEDS: AuctionSeed[] = [
  { code: "600715", pct: 0.021, ratio: 0.12 },
  { code: "002425", pct: 0.035, ratio: 0.09 },
  { code: "002685", pct: 0.048, ratio: 0.15 },
  { code: "603767", pct: 0.017, ratio: 0.13 },
  { code: "002819", pct: 0.062, ratio: 0.17 },
  { code: "000595", pct: 0.029, ratio: 0.11 },
];

function buildAuction(date: string): AuctionResult {
  const capturedAt = Date.now();
  const rows: AuctionRow[] = AUCTION_SEEDS.map((seed) => {
    const stock = findStock(seed.code);
    const floatCap = Math.round(stock?.floatCap ?? 5_000_000_000);
    const prevClose = round2(stock?.price ?? 10);
    const dayAmount = Math.round(((stock?.turnoverRate ?? 6) / 100) * floatCap);
    const amount = Math.round(dayAmount * seed.ratio);
    const price = round2(prevClose * (1 + seed.pct));
    return {
      code: seed.code,
      name: stock?.name ?? seed.code,
      price,
      prevClose,
      open: price,
      volume: Math.max(1, Math.round(amount / price)),
      amount,
      turnover: round2((amount / floatCap) * 100),
      auctionPct: round1(seed.pct * 100),
      amountRatio: round2(seed.ratio),
      capturedAt,
    };
  });

  return {
    date,
    captured: true,
    capturedAt,
    inWindow: true,
    rows,
    warnings: [],
  };
}

export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await delay(cmd === "get_kline" || cmd === "get_day" ? 460 : 160);
  switch (cmd) {
    case "get_calendar":
      return mockCalendar as T;
    case "get_day": {
      const d = mockDay as unknown as DayPayload;
      return {
        ...d,
        stats: { ...d.stats, openLimit: 0, limitDown: 0 },
        openLimit: [],
        limitDown: [],
        source: args?.refresh ? "network" : "cache",
      } as T;
    }
    case "get_kline":
    case "get_index_kline": {
      const period = (args?.period as string) || "day";
      const key = period in mockKlines ? period : "day";
      return mockKlines[key] as T;
    }
    case "get_indices":
      return mockIndices as T;
    case "get_stock_quotes": {
      const codes = (args?.codes as string[] | undefined) ?? [];
      return codes.map((code) => {
        const stock = mockDay.stocks.find((s) => s.code === code);
        const price = stock?.price ?? 10;
        const pct = stock?.changeRate ?? 0;
        return {
          code,
          symbol: code.startsWith("6") ? `sh${code}` : `sz${code}`,
          name: stock?.name ?? code,
          price,
          prevClose: price,
          open: price,
          high: price,
          low: price,
          change: 0,
          pct,
          volume: 0,
          amount: stock?.amount ?? 0,
          turnover: stock?.turnoverRate ?? 0,
          asOf: new Date().toISOString(),
          source: "mock",
          stale: false,
        };
      }) as T;
    }
    case "get_stock_quote":
    case "get_index_quote": {
      const code = String(args?.code ?? args?.secid ?? "").replace(/^[01]\./, "");
      const stock = mockDay.stocks.find((s) => s.code === code) ?? mockDay.stocks[0];
      const price = stock?.price ?? 10;
      const pct = stock?.changeRate ?? 0;
      const prevClose = pct === -100 ? price : price / (1 + pct / 100);
      return {
        code: stock?.code ?? code,
        symbol: code.startsWith("6") ? `sh${code}` : `sz${code}`,
        name: stock?.name ?? "指数",
        price,
        prevClose,
        open: prevClose,
        high: Math.max(price, prevClose),
        low: Math.min(price, prevClose),
        change: price - prevClose,
        pct,
        volume: 0,
        amount: stock?.amount ?? 0,
        turnover: stock?.turnoverRate ?? 0,
        asOf: new Date().toISOString(),
        source: "mock",
        stale: false,
      } as T;
    }
    case "search_stocks": {
      const q = String(args?.query ?? "").trim();
      if (!q) return [] as T;
      const all = [
        ...mockRecent,
        ...mockDay.stocks.map((s) => ({ code: s.code, name: s.name, market: s.market, securityType: "A股" })),
      ];
      const seen = new Set<string>();
      return all
        .filter((s) => s.code.includes(q) || s.name.includes(q))
        .filter((s) => (seen.has(s.code) ? false : (seen.add(s.code), true)))
        .slice(0, 9) as T;
    }
    case "recent_stocks":
      return mockRecent as T;
    case "get_settings":
      return {
        theme: (localStorage.getItem("tianti-theme") as "dark" | "light") || "dark",
        uiScale: Number(localStorage.getItem("tianti-ui-scale") || "1.10"),
      } as T;
    case "set_theme":
      localStorage.setItem("tianti-theme", String(args?.theme));
      return undefined as T;
    case "set_ui_scale":
      localStorage.setItem("tianti-ui-scale", String(args?.scale));
      return Number(args?.scale || 1.10) as T;
    case "export_text":
      return `D:\\source\\godStock\\release\\data\\exports\\${String(args?.filename || "export.txt")}` as T;
    case "get_watch_groups":
      return [
        {
          id: 1,
          name: "我的自选",
          stocks: [
            { code: "600519", name: "贵州茅台", market: "1" },
            { code: "002520", name: "日发精机", market: "0" },
          ],
        },
      ] as T;
    case "create_watch_group":
      return 2 as T;
    case "rename_watch_group":
    case "delete_watch_group":
    case "remove_watch_stock":
    case "save_chart_prefs":
      return undefined as T;
    case "add_watch_stocks":
      return { added: 1, skipped: 0 } as T;
    case "get_chart_prefs":
      return {
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
      } as T;
    case "get_data_info":
      return {
        dataDir: "D:\\source\\godStock\\release\\data",
        dbPath: "D:\\source\\godStock\\release\\data\\tianti.db",
        dbBytes: 128_450_560,
        dayCount: 42,
        klineCount: 184_320,
        firstDate: "20260901",
        lastDate: "20261113",
      } as DataInfo as T;
    case "clear_cache":
      return undefined as T;
    case "get_history_status":
      return { ...historyStatus } as T;
    case "sync_limit_history": {
      const requested = Number(args?.days);
      const expectedDays = Number.isFinite(requested) && requested > 0 ? Math.round(requested) : 250;
      historyStatus = {
        ...historyStatus,
        days: Math.max(historyStatus.days, expectedDays),
        expectedDays,
        syncing: false,
        updatedAt: Date.now(),
      };
      return { ...historyStatus } as T;
    }
    case "get_strategy_profile":
      return { ...strategyProfile } as T;
    case "save_strategy_profile": {
      const next = args?.profile as StrategyProfile | undefined;
      if (next && typeof next === "object") {
        strategyProfile = { ...STRATEGY_DEFAULTS, ...next, updatedAt: Date.now() };
      }
      return { ...strategyProfile } as T;
    }
    case "run_first_to_second":
      return buildScreen(normalizeDate(args?.date)) as T;
    case "capture_auction":
    case "get_auction":
      return buildAuction(normalizeDate(args?.date)) as T;
    case "window_control":
    case "open_data_dir":
      return undefined as T;
    default:
      throw new Error(`unknown mock command ${cmd}`);
  }
}
