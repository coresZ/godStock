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


