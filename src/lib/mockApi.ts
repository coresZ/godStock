import type { CalendarInfo, DataInfo, DayPayload, IndexQuote, KlinePayload, SearchItem } from "./types";
import { mockCalendar, mockDay, mockIndices, mockKlines, mockRecent } from "./mock";

const delay = (ms = 220) => new Promise((r) => setTimeout(r, ms));

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
          { period: 5, color: "sky", width: 1, dashed: true },
          { period: 10, color: "amber", width: 1, dashed: true },
          { period: 20, color: "violet", width: 1, dashed: true },
          { period: 60, color: "brass", width: 1, dashed: true },
        ],
        emaEnabled: true,
        emaLines: [
          { period: 5, color: "brass", width: 1.2, dashed: false },
          { period: 10, color: "up", width: 1.2, dashed: false },
          { period: 20, color: "down", width: 1.2, dashed: false },
          { period: 60, color: "violet", width: 1.2, dashed: false },
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
    case "window_control":
    case "open_data_dir":
      return undefined as T;
    default:
      throw new Error(`unknown mock command ${cmd}`);
  }
}
