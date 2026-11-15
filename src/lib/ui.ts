const ICONS: Record<string, string> = {
  ladder:
    '<path d="M4.5 18.5v-3.2h4.2v-3.6h4.2V8.2h4.2V5h2.4"/><path d="M4.5 18.5h15"/><circle cx="19.5" cy="5" r="1.2" fill="currentColor" stroke="none"/>',
  list:
    '<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11"/><circle cx="4.6" cy="6.5" r="1" fill="currentColor" stroke="none"/><circle cx="4.6" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4.6" cy="17.5" r="1" fill="currentColor" stroke="none"/>',
  chart:
    '<path d="M4 20V4M4 20h16"/><path d="M8.5 16.5v-5M8.5 9V7.2M12.8 16.5V9.8M12.8 8V6.2M17.1 16.5v-3M17.1 11.7V8.5"/><rect x="7.3" y="9" width="2.4" height="4.6" rx=".5"/><rect x="11.6" y="9.8" width="2.4" height="5.2" rx=".5"/><rect x="15.9" y="11.7" width="2.4" height="2.8" rx=".5"/>',
  search: '<circle cx="11" cy="11" r="6.2"/><path d="m15.6 15.6 3.4 3.4"/>',
  settings:
    '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.1"/><circle cx="8" cy="17" r="2.1"/>',
  refresh:
    '<path d="M19 8.5A7.5 7.5 0 1 0 19.4 13"/><path d="M19 4.5v4h-4"/>',
  chevronDown: '<path d="m7 9.5 5 5 5-5"/>',
  chevronLeft: '<path d="m14.5 5.5-6 6.5 6 6.5"/>',
  chevronRight: '<path d="m9.5 5.5 6 6.5-6 6.5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<rect x="5.5" y="5.5" width="13" height="13" rx="1.2"/>',
  restore: '<path d="M8 8V6.2c0-.7.5-1.2 1.2-1.2h8.6c.7 0 1.2.5 1.2 1.2v8.6c0 .7-.5 1.2-1.2 1.2H16"/><rect x="5" y="8" width="11" height="11" rx="1.2"/>',
  arrowUpRight: '<path d="M7 17 17 7M9 7h8v8"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  database:
    '<ellipse cx="12" cy="5.5" rx="7.2" ry="2.8"/><path d="M4.8 5.5v6.3c0 1.5 3.2 2.8 7.2 2.8s7.2-1.3 7.2-2.8V5.5"/><path d="M4.8 11.8v6.2c0 1.6 3.2 2.9 7.2 2.9s7.2-1.3 7.2-2.9v-6.2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4"/>',
  moon: '<path d="M19.5 14.2A7.8 7.8 0 0 1 9.8 4.5 8 8 0 1 0 19.5 14.2Z"/>',
  check: '<path d="m5 12.5 4.3 4.3L19 7"/>',
  info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8.2v.2"/>',
  trash: '<path d="M5 7h14M9.5 7V5.2h5V7M7.2 7l.7 12.2h8.2L16.8 7M10 10.5v5M14 10.5v5"/>',
  folder: '<path d="M3.8 7.5c0-1 .8-1.8 1.8-1.8h4l1.7 2h7.1c1 0 1.8.8 1.8 1.8v8c0 1-.8 1.8-1.8 1.8H5.6c-1 0-1.8-.8-1.8-1.8Z"/>',
  expand: '<path d="M8 3.8H4v4M16 3.8h4v4M20 16v4h-4M4 16v4h4"/>',
  command: '<path d="M6.5 9.2A2.7 2.7 0 1 1 9.2 6.5v11a2.7 2.7 0 1 1-2.7-2.7h11a2.7 2.7 0 1 1-2.7 2.7v-11a2.7 2.7 0 1 1 2.7 2.7Z"/>',
  dot: '<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>',
  activity: '<path d="M3.5 12h3.2l2.1-6 3.6 12 2.3-6h5.8"/>',
  layers:
    '<path d="m12 3.8 8 4.2-8 4.2-8-4.2 8-4.2Z"/><path d="m4 12 8 4.2 8-4.2M4 16.3l8 4.2 8-4.2"/>',
  wallet:
    '<path d="M4 8.2c0-1.2 1-2.2 2.2-2.2h11.6c1.2 0 2.2 1 2.2 2.2v9.6c0 1.2-1 2.2-2.2 2.2H6.2c-1.2 0-2.2-1-2.2-2.2Z"/><path d="M4 8.5h16M15.2 13h3.6"/>',
};

export function icon(name: keyof typeof ICONS | string, size = 20, cls = ""): string {
  const body = ICONS[name] ?? ICONS.dot;
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function esc(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function fmtPrice(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

export function fmtPct(v: number, digits = 2, sign = true): string {
  if (!Number.isFinite(v)) return "—";
  const s = sign && v > 0 ? "+" : "";
  return `${s}${v.toFixed(digits)}%`;
}

export function fmtSigned(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
}

export function fmtMoney(v: number, digits = 2): string {
  if (!Number.isFinite(v) || v === 0) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(digits)}亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(abs >= 1e7 ? 0 : 1)}万`;
  return `${v.toFixed(0)}`;
}

export function fmtVolume(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿手`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(1)}万手`;
  return `${v.toFixed(0)}手`;
}

export function fmtAmount(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
  return `${v.toFixed(0)}`;
}

export function fmtBytes(v: number): string {
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function tone(v: number): "up" | "down" | "flat" {
  if (v > 0.0001) return "up";
  if (v < -0.0001) return "down";
  return "flat";
}

export function fmtClock(ts: number): string {
  if (!ts) return "—";
  const d = new Date((ts + 8 * 3600) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function fmtClockSeconds(ts: number): string {
  if (!ts) return "—";
  const d = new Date((ts + 8 * 3600) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function fmtShortDate(ymd: string): string {
  if (!ymd || ymd.length !== 8) return ymd || "—";
  return `${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

export function fmtDotDate(ymd: string): string {
  if (!ymd || ymd.length !== 8) return ymd || "—";
  return `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
}

export function fmtCnDate(ymd: string): string {
  if (!ymd || ymd.length !== 8) return ymd || "—";
  return `${ymd.slice(0, 4)}年${Number(ymd.slice(4, 6))}月${Number(ymd.slice(6, 8))}日`;
}

export function weekdayFromYmd(ymd: string): string {
  if (!ymd || ymd.length !== 8) return "";
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][day] ?? "";
}

export function relTime(tsSeconds: number): string {
  if (!tsSeconds) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - tsSeconds));
  if (diff < 20) return "刚刚更新";
  if (diff < 60) return `${diff}秒前更新`;
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前更新`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前更新`;
  return `${Math.floor(diff / 86400)}天前更新`;
}

export function tierName(streak: number): string {
  return streak <= 1 ? "首板" : `${streak}板`;
}

export function sparkline(
  values: number[],
  width = 96,
  height = 30,
  className = "",
): string {
  if (!values.length) return "";
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0.001);
  const span = max - min || 1;
  const n = values.length;
  const points = values.map((v, i) => {
    const x = (i / Math.max(1, n - 1)) * width;
    const y = height - 2 - ((v - min) / span) * (height - 4);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const area = `M0,${height} L${points.join(" L")} L${width},${height} Z`;
  const last = values[n - 1];
  const cls = last > 0.1 ? "spark-up" : last < -0.1 ? "spark-down" : "spark-flat";
  return `<svg class="spark ${cls} ${className}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><path class="spark-area" d="${area}"/><polyline class="spark-line" points="${points.join(" ")}"/></svg>`;
}

export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): T {
  let t: number | undefined;
  return ((...args: never[]) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), wait);
  }) as T;
}

export function greetingByHour(): string {
  const h = new Date().getHours();
  if (h < 9) return "早间";
  if (h < 12) return "上午";
  if (h < 15) return "盘中";
  if (h < 18) return "午后";
  return "晚间";
}

export function pctToneClass(v: number): string {
  const t = tone(v);
  return t === "up" ? "text-up" : t === "down" ? "text-down" : "text-flat";
}

export function marketLabel(market: string, code: string): string {
  if (market === "HS" || market === "1") {
    if (code.startsWith("688")) return "科创板";
    return "沪市";
  }
  if (code.startsWith("300") || code.startsWith("301")) return "创业板";
  return "深市";
}
