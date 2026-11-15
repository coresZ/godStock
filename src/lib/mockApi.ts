import type { CalendarInfo, DataInfo, DayPayload, IndexQuote, KlinePayload, SearchItem } from "./types";
import { mockCalendar, mockDay, mockIndices, mockKlines, mockRecent } from "./mock";

const delay = (ms = 220) => new Promise((r) => setTimeout(r, ms));

export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await delay(cmd === "get_kline" || cmd === "get_day" ? 460 : 160);
  switch (cmd) {
    case "get_calendar":
      return mockCalendar as T;
    case "get_day":
      return { ...mockDay, source: args?.refresh ? "network" : "cache" } as T;
    case "get_kline": {
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
      return { theme: (localStorage.getItem("tianti-theme") as "dark" | "light") || "dark" } as T;
    case "set_theme":
      localStorage.setItem("tianti-theme", String(args?.theme));
      return undefined as T;
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
