import type { Stock } from "./types";

export interface ApproxTime {
  clock: string;
  minute: number;
  approx: boolean;
}

function limitFor(s: Stock): number {
  if (s.market === "GEM" || s.market === "STAR") return 20;
  if (s.market === "BSE") return 30;
  const values = s.spark.filter((v) => Number.isFinite(v));
  const extreme = values.length ? Math.max(...values.map((v) => Math.abs(v))) : Math.abs(s.changeRate);
  if (extreme > 19) return 20;
  if (extreme > 4.7 && extreme < 6) return 5;
  return 10;
}

function tradingMinuteFromTimestamp(ts: number): number {
  if (!ts) return -1;
  const d = new Date((ts + 8 * 3600) * 1000);
  let total = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (total > 11 * 60 + 30) total -= 90;
  return total - (9 * 60 + 30);
}

export function timestampToTimelineMinute(ts: number): number {
  if (!ts) return 0;
  const d = new Date((ts + 8 * 3600) * 1000);
  let total = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (total > 11 * 60 + 30) total -= 90;
  // 09:15 is minute 0; 09:25 auction is minute 10.
  return Math.max(0, Math.min(255, total - (9 * 60 + 15)));
}

export function timelineMinuteLabel(minute: number): string {
  if (minute === 135) return "11:30/13:00";
  let total = 9 * 60 + 15 + Math.max(0, Math.min(255, minute));
  if (total > 11 * 60 + 30) total += 90;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function sparkClock(index: number): string {
  const minute = 9 * 60 + 30 + index * 3;
  const total = minute > 11 * 60 + 30 ? minute + 90 : minute;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export const SPARK_SAMPLE_MINUTES = 3;
export const SPARK_FULL_SAMPLES = 80;

function localTodayYmd(): string {
  // The A-share calendar is always UTC+8, even when the machine is not.
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
}

function clockOfDay(epochSeconds: number): number {
  const d = new Date((epochSeconds + 8 * 3600) * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function tradingMinutesAt(epochSeconds: number): number {
  const clock = clockOfDay(epochSeconds);
  if (clock < 9 * 60 + 30) return 0;
  if (clock <= 11 * 60 + 30) return clock - (9 * 60 + 30);
  if (clock < 13 * 60) return 120;
  if (clock <= 15 * 60) return 120 + (clock - 13 * 60);
  return 240;
}

/** How many 3-minute samples can exist for `date` when it was fetched at `fetchedAt`. */
export function sparkSampleLimit(date: string, fetchedAt: number): number {
  if (date !== localTodayYmd()) return SPARK_FULL_SAMPLES;
  if (!fetchedAt) return SPARK_FULL_SAMPLES;
  if (clockOfDay(fetchedAt) < 9 * 60 + 30) return 0;
  return Math.min(SPARK_FULL_SAMPLES, Math.floor(tradingMinutesAt(fetchedAt) / SPARK_SAMPLE_MINUTES) + 1);
}

export interface SparkWindow {
  samples: number[];
  live: boolean;
  endClock: string;
  phase: IntradayPhase;
}

export type IntradayPhase = "pre" | "live" | "lunch" | "closed";

export function intradayPhase(date: string, nowSeconds = Math.floor(Date.now() / 1000)): IntradayPhase {
  if (date !== localTodayYmd()) return "closed";
  const clock = clockOfDay(nowSeconds);
  if (clock < 9 * 60 + 15) return "pre";
  if (clock <= 11 * 60 + 30) return "live";
  if (clock < 13 * 60) return "lunch";
  if (clock <= 15 * 60) return "live";
  return "closed";
}

/**
 * Trim today's `time_preview` to the samples that could exist at fetch time and
 * report whether the last point is still live. This is the frontend safety net
 * for databases written before the backend learned to trim the series.
 */
export function sparkWindow(stock: Stock, date: string, fetchedAt: number): SparkWindow {
  const limit = sparkSampleLimit(date, fetchedAt);
  const samples = limit === 0 ? [] : stock.spark.length > limit ? stock.spark.slice(0, limit) : stock.spark;
  const endClock = samples.length ? sparkClock(samples.length - 1) : "";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const phase = intradayPhase(date, nowSeconds);
  const fresh = !fetchedAt || nowSeconds - fetchedAt < 420;
  const live = phase === "live" && fresh && samples.length > 0;
  return { samples, live, endClock, phase };
}

export function breakInfo(s: Stock): ApproxTime | null {
  if (!s.spark.length) return null;
  const limit = limitFor(s);
  // 先找到第一次封住涨停的采样点，再找其后的第一次开板。
  // 这样不会把封板前的正常价格误判为炸板。
  let sealIndex = s.spark.findIndex((v) => v >= limit - 0.2);
  if (sealIndex < 0 && s.firstSeal) {
    sealIndex = Math.max(0, Math.floor(tradingMinuteFromTimestamp(s.firstSeal) / 3));
  }
  if (sealIndex < 0) return null;
  for (let i = sealIndex + 1; i < s.spark.length; i++) {
    if (s.spark[i] < limit - 0.2) {
      return { clock: sparkClock(i), minute: 15 + i * 3, approx: true };
    }
  }
  return null;
}

export function downInfo(s: Stock): ApproxTime | null {
  const limit = limitFor(s);
  let idx = -1;
  for (let i = 0; i < s.spark.length; i++) {
    if (s.spark[i] <= -(limit - 0.2)) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  return { clock: sparkClock(idx), minute: 15 + idx * 3, approx: true };
}


