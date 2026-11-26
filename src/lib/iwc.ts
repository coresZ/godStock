import { state } from "./state";
import type { IwcStock } from "./types";

/** 同花顺板块成分股的实时涨幅（批量行情缓存，由 main.ts 拉取）。 */
export function iwcQuote(code: string): { price: number; pct: number } | null {
  return state.iwcQuotes[code] ?? null;
}

export function iwcSortLabel(): string {
  if (state.iwcSort === "pctDesc") return "涨幅↓";
  if (state.iwcSort === "pctAsc") return "涨幅↑";
  return "默认";
}

/** 板块内成分股排序：默认保持问财顺序；涨幅排序时无行情的排最后。 */
export function iwcSortedStocks(stocks: IwcStock[]): IwcStock[] {
  if (state.iwcSort === "default") return stocks;
  const factor = state.iwcSort === "pctDesc" ? -1 : 1;
  return [...stocks].sort((a, b) => {
    const av = iwcQuote(a.code)?.pct;
    const bv = iwcQuote(b.code)?.pct;
    if (av === undefined && bv === undefined) return 0;
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    if (av !== bv) return (av - bv) * factor;
    return 0;
  });
}

export function iwcPctText(code: string): string {
  const quote = iwcQuote(code);
  if (!quote || !Number.isFinite(quote.pct)) return "—";
  return `${quote.pct > 0 ? "+" : ""}${quote.pct.toFixed(2)}%`;
}

export function iwcPctClass(code: string): string {
  const quote = iwcQuote(code);
  if (!quote || !Number.isFinite(quote.pct) || quote.pct === 0) return "text-flat";
  return quote.pct > 0 ? "text-up" : "text-down";
}
