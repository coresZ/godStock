import type { KlineCandle } from "./lib/types";
import { intradayPhase, type IntradayPhase } from "./lib/market";
import { clamp, fmtAmount, fmtPct, fmtPrice, fmtVolume } from "./lib/ui";

interface TsColors {
  bg: string;
  text: string;
  muted: string;
  faint: string;
  line: string;
  grid: string;
  up: string;
  down: string;
  brass: string;
  surface: string;
}

type TsKind = "stock" | "index";
type AxisMode = "full" | "follow";

export interface TimeShareOptions {
  axisMode?: AxisMode;
  yScale?: number;
  kind?: TsKind;
  onYScaleChange?: (value: number) => void;
}

interface TsLayout {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  priceBottom: number;
  volTop: number;
  volBottom: number;
  plotW: number;
  plotH: number;
  spanMinutes: number;
  minPct: number;
  maxPct: number;
  stepPct: number;
}

const SESSION_MINUTES = 240;
const NICE_STEPS = [
  0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6,
  7.5, 10, 12, 15, 20, 25, 30, 40, 50,
];

function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  if (hex.startsWith("#") && (hex.length === 7 || hex.length === 4)) {
    const expand = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
    const r = parseInt(expand.slice(1, 3), 16);
    const g = parseInt(expand.slice(3, 5), 16);
    const b = parseInt(expand.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return hex;
}

function niceStep(raw: number): number {
  for (const step of NICE_STEPS) {
    if (step >= raw) return step;
  }
  return NICE_STEPS[NICE_STEPS.length - 1];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

export class TimeShareChart {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tooltip: HTMLElement;
  private legend: HTMLElement;
  private rows: KlineCandle[] = [];
  private avg: number[] = [];
  private base = 0;
  private hover: number | null = null;
  private layout: TsLayout | null = null;
  private axisMode: AxisMode;
  private yScale: number;
  private kind: TsKind;
  private onYScaleChange?: (value: number) => void;
  private colors: TsColors;
  private observer: ResizeObserver;
  private abort = new AbortController();
  private raf = 0;
  private pulseRaf = 0;
  private pulseLast = 0;
  private live = false;
  private phase: IntradayPhase = "closed";
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(container: HTMLElement, options: TimeShareOptions = {}) {
    this.container = container;
    this.axisMode = options.axisMode ?? "full";
    this.yScale = clamp(options.yScale ?? 1, 0.55, 2.2);
    this.kind = options.kind ?? "stock";
    this.onYScaleChange = options.onYScaleChange;
    container.classList.add("timeshare-host");
    container.innerHTML = `<canvas aria-label="分时走势" role="img"></canvas>
      <div class="ts-legend"></div>
      <div class="ts-tooltip"></div>`;
    this.canvas = container.querySelector("canvas")!;
    this.ctx = this.canvas.getContext("2d")!;
    this.legend = container.querySelector(".ts-legend")!;
    this.tooltip = container.querySelector(".ts-tooltip")!;
    this.colors = this.readColors();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    document.addEventListener("visibilitychange", () => this.restartPulse(), { signal: this.abort.signal });
    this.bind();
    this.resize();
  }

  private readColors(): TsColors {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string) => cs.getPropertyValue(name).trim();
    return {
      bg: v("--chart-bg"),
      text: v("--text"),
      muted: v("--muted"),
      faint: v("--faint"),
      line: v("--line"),
      grid: v("--grid"),
      up: v("--up"),
      down: v("--down"),
      brass: v("--brass"),
      surface: v("--surface-2"),
    };
  }

  setData(candles: KlineCandle[], prevClose?: number | null): void {
    const last = candles[candles.length - 1];
    if (!last) {
      this.rows = [];
      this.avg = [];
      this.live = false;
      this.schedule();
      return;
    }
    const day = last.date.slice(0, 10);
    this.rows = candles
      .filter((c) => c.date.startsWith(day))
      .sort((a, b) => a.date.localeCompare(b.date));
    this.base = prevClose && prevClose > 0 ? prevClose : this.rows[0]?.open || this.rows[0]?.close || 0;
    this.avg = this.kind === "index" ? [] : this.computeAverage();
    this.hover = null;
    this.tooltip.classList.remove("show");
    this.colors = this.readColors();
    const dateYmd = day.replace(/-/g, "");
    this.phase = intradayPhase(dateYmd);
    this.live = this.phase === "live";
    this.updateLegend();
    this.schedule();
    this.restartPulse();
  }

  private computeAverage(): number[] {
    let amount = 0;
    let volume = 0;
    let lastAvg = this.base;
    const out: number[] = [];
    for (const row of this.rows) {
      amount += Math.max(0, row.amount);
      volume += Math.max(0, row.volume);
      if (volume > 0 && amount > 0) {
        const value = amount / (volume * 100);
        // 指数成交额 / 成交量没有「每股均价」含义；个股也防止异常字段把
        // 纵轴拉坏。
        if (Number.isFinite(value) && value > 0 && Math.abs(value / this.base - 1) < 0.35) {
          lastAvg = value;
        }
      }
      out.push(lastAvg || row.close);
    }
    return out;
  }

  setAxisMode(mode: AxisMode): void {
    if (this.axisMode === mode) return;
    this.axisMode = mode;
    this.schedule();
  }

  setYScale(value: number): void {
    const next = clamp(Number.isFinite(value) ? value : 1, 0.55, 2.2);
    if (Math.abs(next - this.yScale) < 0.001) return;
    this.yScale = next;
    this.schedule();
  }

  redraw(): void {
    this.colors = this.readColors();
    this.updateLegend();
    this.schedule();
  }

  destroy(): void {
    this.abort.abort();
    this.observer.disconnect();
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.pulseRaf);
    this.pulseRaf = 0;
  }

  private bind(): void {
    const signal = this.abort.signal;
    this.canvas.addEventListener(
      "mousemove",
      (event) => {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        this.hover = this.indexAt(x);
        this.schedule();
        this.showTooltip(event.clientX, event.clientY);
      },
      { signal },
    );
    this.canvas.addEventListener(
      "mouseleave",
      () => {
        this.hover = null;
        this.tooltip.classList.remove("show");
        this.schedule();
      },
      { signal },
    );
    this.canvas.addEventListener(
      "dblclick",
      () => {
        this.setYScale(1);
        this.onYScaleChange?.(1);
      },
      { signal },
    );
    this.canvas.addEventListener(
      "wheel",
      (event) => {
        const layout = this.layout;
        if (!layout) return;
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const onAxis = x <= layout.left || x >= layout.width - layout.right;
        if (!onAxis) return;
        event.preventDefault();
        const direction = event.deltaY < 0 ? 1 : -1;
        const next = clamp(this.yScale + direction * 0.12, 0.55, 2.2);
        this.setYScale(next);
        this.onYScaleChange?.(next);
      },
      { signal, passive: false },
    );
  }

  private sessionMinute(index: number): number {
    const date = this.rows[clamp(index, 0, this.rows.length - 1)]?.date ?? "";
    const hour = Number(date.slice(11, 13));
    const minute = Number(date.slice(14, 16));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
    const clock = hour * 60 + minute;
    if (clock <= 11 * 60 + 30) return clamp(clock - (9 * 60 + 30), 0, 120);
    if (clock >= 13 * 60) return clamp(120 + clock - 13 * 60, 120, 240);
    return 120;
  }

  private spanMinutes(): number {
    if (this.axisMode === "full") return SESSION_MINUTES;
    return Math.max(1, this.sessionMinute(this.rows.length - 1));
  }

  private xAt(index: number, layout: TsLayout): number {
    return layout.left + (this.sessionMinute(index) / layout.spanMinutes) * layout.plotW;
  }

  private indexAt(x: number): number {
    const layout = this.layout;
    if (!layout || this.rows.length < 2) return 0;
    let best = 0;
    let distance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.rows.length; i++) {
      const next = Math.abs(this.xAt(i, layout) - x);
      if (next < distance) {
        distance = next;
        best = i;
      }
    }
    return best;
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.colors = this.readColors();
    this.schedule();
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint(performance.now());
    });
  }

  private restartPulse(): void {
    cancelAnimationFrame(this.pulseRaf);
    this.pulseRaf = 0;
    if (!this.live || this.reducedMotion || document.hidden) return;
    const loop = (timestamp: number) => {
      if (timestamp - this.pulseLast >= 33) {
        this.pulseLast = timestamp;
        this.paint(timestamp);
      }
      this.pulseRaf = requestAnimationFrame(loop);
    };
    this.pulseRaf = requestAnimationFrame(loop);
  }

  private prepare(): { width: number; height: number; layout: TsLayout } | null {
    const c = this.ctx;
    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const height = this.canvas.height / (window.devicePixelRatio || 1);
    if (width < 10 || height < 10) return null;
    c.clearRect(0, 0, width, height);
    c.fillStyle = this.colors.bg;
    c.fillRect(0, 0, width, height);
    if (!this.rows.length) return null;

    const left = 60;
    const right = 60;
    const top = 30;
    const bottom = 22;
    const volHeight = clamp(height * 0.16, 62, 94);
    const gap = 10;
    const priceBottom = height - bottom - volHeight - gap;
    const volTop = height - bottom - volHeight;
    const volBottom = height - bottom;
    const plotW = Math.max(1, width - left - right);
    const plotH = Math.max(1, priceBottom - top);

    let minDev = 0;
    let maxDev = 0;
    let hasData = false;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      for (const value of [row.close, row.high, row.low]) {
        if (value > 0 && this.base > 0) {
          const dev = (value / this.base - 1) * 100;
          minDev = hasData ? Math.min(minDev, dev) : dev;
          maxDev = hasData ? Math.max(maxDev, dev) : dev;
          hasData = true;
        }
      }
      if (this.avg[i] > 0) {
        const dev = (this.avg[i] / this.base - 1) * 100;
        minDev = hasData ? Math.min(minDev, dev) : dev;
        maxDev = hasData ? Math.max(maxDev, dev) : dev;
        hasData = true;
      }
    }
    if (!hasData) {
      minDev = -0.5;
      maxDev = 0.5;
    }
    const dataSpan = Math.max(maxDev - minDev, 0.2);
    const minRange = this.kind === "index" ? 0.4 : 1.2;
    const range = Math.max(dataSpan, minRange);
    const center = (maxDev + minDev) / 2;
    let fitMin = Math.min(minDev, center - range / 2);
    let fitMax = Math.max(maxDev, center + range / 2);
    // TradingView-style auto scale: fit the data, and only keep 0% (昨收) in
    // view when it is reasonably close to the action. Limit-up stocks would
    // otherwise waste half the canvas on an empty 0% half.
    if (fitMin - dataSpan * 0.6 <= 0 && 0 <= fitMax + dataSpan * 0.6) {
      fitMin = Math.min(fitMin, 0);
      fitMax = Math.max(fitMax, 0);
    }
    const targetLines = clamp(Math.round(5 * this.yScale), 3, 11);
    const stepPct = niceStep(((fitMax - fitMin) * 1.08) / Math.max(2, targetLines - 1));
    let minPct = Math.floor((fitMin - stepPct * 0.15) / stepPct) * stepPct;
    let maxPct = Math.ceil((fitMax + stepPct * 0.15) / stepPct) * stepPct;
    if (maxPct - minPct < stepPct * 1.6) {
      const mid = (maxPct + minPct) / 2;
      maxPct = mid + stepPct * 0.8;
      minPct = mid - stepPct * 0.8;
    }
    minPct = Math.max(-80, minPct);
    maxPct = Math.min(80, maxPct);
    const layout: TsLayout = {
      width,
      height,
      left,
      right,
      top,
      priceBottom,
      volTop,
      volBottom,
      plotW,
      plotH,
      spanMinutes: this.spanMinutes(),
      minPct,
      maxPct,
      stepPct,
    };
    this.layout = { ...layout };
    return { width, height, layout };
  }

  private yOf(price: number, layout: TsLayout): number {
    if (this.base <= 0) return layout.top;
    const pct = (price / this.base - 1) * 100;
    const ratio = (layout.maxPct - pct) / Math.max(0.0001, layout.maxPct - layout.minPct);
    return layout.top + clamp(ratio, -0.2, 1.2) * layout.plotH;
  }

  private pctOf(price: number): number {
    return this.base > 0 ? ((price / this.base - 1) * 100) : 0;
  }

  private paint(timestamp: number): void {
    const prepared = this.prepare();
    if (!prepared) return;
    const { width, layout } = prepared;
    const c = this.ctx;
    const { left, right, top, priceBottom, volTop, volBottom, plotW, stepPct } = layout;
    const plotRight = width - right;
    const mainColor = this.rows[this.rows.length - 1].close >= this.base ? this.colors.up : this.colors.down;
    const xAt = (i: number) => this.xAt(i, layout);
    const last = this.rows[this.rows.length - 1];
    const lastX = xAt(this.rows.length - 1);
    const lastY = clamp(this.yOf(last.close, layout), top + 1, priceBottom - 1);

    // Horizontal grid. Labeled lines follow a "nice" percentage step; when
    // there is room we add minor lines so a quiet index still reads like a
    // chart instead of a single flat line.
    const spanPct = Math.max(0.0001, layout.maxPct - layout.minPct);
    const labeledSpacing = (layout.plotH * stepPct) / spanPct;
    const minorDiv = labeledSpacing > 104 ? 4 : labeledSpacing > 38 ? 2 : 0;
    if (minorDiv) {
      const minorStep = stepPct / minorDiv;
      const start = Math.ceil(layout.minPct / minorStep - 1e-9);
      const end = Math.floor(layout.maxPct / minorStep + 1e-9);
      c.strokeStyle = withAlpha(this.colors.text, 0.05);
      c.lineWidth = 1;
      for (let k = start; k <= end; k++) {
        if (Math.abs(k) % minorDiv === 0) continue;
        const y = Math.round(this.yOf(this.base * (1 + (k * minorStep) / 100), layout)) + 0.5;
        c.beginPath();
        c.moveTo(left, y);
        c.lineTo(plotRight, y);
        c.stroke();
      }
    }

    c.font = '9px "IBM Plex Mono", monospace';
    c.textBaseline = "middle";
    const startTick = Math.ceil(layout.minPct / stepPct - 1e-9);
    const endTick = Math.floor(layout.maxPct / stepPct + 1e-9);
    for (let k = startTick; k <= endTick; k++) {
      const pct = k * stepPct;
      const y = this.yOf(this.base * (1 + pct / 100), layout);
      if (y < top - 1 || y > priceBottom + 1) continue;
      const zero = Math.abs(pct) < 0.0001;
      c.strokeStyle = zero ? this.colors.line : this.colors.grid;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(left, Math.round(y) + 0.5);
      c.lineTo(plotRight, Math.round(y) + 0.5);
      c.stroke();
      c.fillStyle = zero ? this.colors.muted : this.colors.faint;
      // The last-price tags are drawn on top of the gutter; hide the label
      // underneath so the two numbers do not overlap (tag box is 16px tall).
      if (Math.abs(y - lastY) >= 15) {
        c.textAlign = "right";
        c.fillText(this.axisPrice(this.base * (1 + pct / 100)), left - 7, y);
        c.textAlign = "left";
        c.fillStyle = zero ? this.colors.muted : this.colors.faint;
        c.fillText(fmtPct(pct), plotRight + 7, y);
      }
    }

    // Previous close reference.
    const baseY = this.yOf(this.base, layout);
    if (baseY > top && baseY < priceBottom) {
      c.strokeStyle = this.colors.line;
      c.setLineDash([4, 4]);
      c.beginPath();
      c.moveTo(left, baseY);
      c.lineTo(plotRight, baseY);
      c.stroke();
      c.setLineDash([]);
    }

    // Price area + lines, clipped so a manual tight scale can never leak into
    // the axes.
    c.save();
    c.beginPath();
    c.rect(left, top, plotW, priceBottom - top);
    c.clip();

    const area = c.createLinearGradient(0, top, 0, priceBottom);
    area.addColorStop(0, mainColor === this.colors.up ? "rgba(225,90,77,.17)" : "rgba(87,166,142,.17)");
    area.addColorStop(1, "rgba(0,0,0,0)");
    c.beginPath();
    this.rows.forEach((row, i) => {
      const x = xAt(i);
      const y = this.yOf(row.close, layout);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    });
    c.lineTo(xAt(this.rows.length - 1), priceBottom);
    c.lineTo(xAt(0), priceBottom);
    c.closePath();
    c.fillStyle = area;
    c.fill();

    c.beginPath();
    this.rows.forEach((row, i) => {
      const x = xAt(i);
      const y = this.yOf(row.close, layout);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    });
    c.strokeStyle = mainColor;
    c.lineWidth = 1.6;
    c.lineJoin = "round";
    c.stroke();

    if (this.kind === "stock" && this.avg.length) {
      c.beginPath();
      this.avg.forEach((value, i) => {
        const x = xAt(i);
        const y = this.yOf(value, layout);
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      });
      c.strokeStyle = this.colors.brass;
      c.lineWidth = 1.05;
      c.globalAlpha = 0.82;
      c.stroke();
      c.globalAlpha = 1;
    }
    c.restore();

    // Volume pane.
    c.strokeStyle = this.colors.line;
    c.beginPath();
    c.moveTo(left, volTop - 0.5);
    c.lineTo(plotRight, volTop - 0.5);
    c.stroke();
    const volMax = Math.max(...this.rows.map((row) => Math.max(0, row.volume)), 1);
    const slot = (plotW * 1) / Math.max(1, layout.spanMinutes);
    const barW = Math.max(0.7, Math.min(3.4, slot * 2.4));
    c.globalAlpha = 0.7;
    this.rows.forEach((row, i) => {
      const h = (Math.max(0, row.volume) / volMax) * (volBottom - volTop - 7);
      c.fillStyle = row.close >= row.open ? this.colors.up : this.colors.down;
      c.fillRect(xAt(i) - barW / 2, volBottom - h, barW, h);
    });
    c.globalAlpha = 1;
    c.font = '8px "Noto Sans SC", sans-serif';
    c.fillStyle = this.colors.faint;
    c.textAlign = "left";
    c.textBaseline = "top";
    c.fillText("成交量", left, volTop + 8);

    // Time axis.
    c.font = '10px "IBM Plex Mono", monospace';
    c.fillStyle = this.colors.muted;
    c.textBaseline = "top";
    this.drawTimeAxis(layout);

    // Last price / percent tags on both axes.
    c.textBaseline = "middle";
    c.font = '9px "IBM Plex Mono", monospace';
    const priceText = this.axisPrice(last.close);
    this.drawTag(priceText, 2, lastY, mainColor);
    this.drawTag(fmtPct(this.pctOf(last.close)), width - right + 3, lastY, mainColor);

    // Hover crosshair.
    if (this.hover != null && this.hover >= 0 && this.hover < this.rows.length) {
      const row = this.rows[this.hover];
      const x = xAt(this.hover);
      const y = this.yOf(row.close, layout);
      c.strokeStyle = this.colors.muted;
      c.globalAlpha = 0.5;
      c.setLineDash([3, 3]);
      c.beginPath();
      c.moveTo(x, top);
      c.lineTo(x, volBottom);
      c.moveTo(left, y);
      c.lineTo(plotRight, y);
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
      c.fillStyle = mainColor;
      c.beginPath();
      c.arc(x, y, 3, 0, Math.PI * 2);
      c.fill();
    }

    // Latest point: a vermilion pulse while the session is live, a quiet dot
    // after the close.
    if (this.live) {
      const phase = (timestamp % 1700) / 1700;
      const radius = 3 + phase * 8;
      const alpha = Math.max(0, 0.42 * (1 - phase));
      const glow = c.createRadialGradient(lastX, lastY, 1, lastX, lastY, radius);
      glow.addColorStop(0, withAlpha(this.colors.up, alpha));
      glow.addColorStop(0.55, withAlpha(this.colors.up, alpha * 0.45));
      glow.addColorStop(1, withAlpha(this.colors.up, 0));
      c.fillStyle = glow;
      c.beginPath();
      c.arc(lastX, lastY, radius, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = this.colors.up;
      c.beginPath();
      c.arc(lastX, lastY, 2.9, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = this.colors.bg;
      c.beginPath();
      c.arc(lastX, lastY, 1.1, 0, Math.PI * 2);
      c.fill();
    } else {
      c.fillStyle = mainColor;
      c.beginPath();
      c.arc(lastX, lastY, 2.4, 0, Math.PI * 2);
      c.fill();
    }
  }

  private axisPrice(value: number): string {
    if (!Number.isFinite(value)) return "—";
    if (this.kind === "index" && Math.abs(value) >= 1000) {
      return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return fmtPrice(value);
  }

  private drawTag(text: string, x: number, y: number, color: string): void {
    const c = this.ctx;
    const width = c.measureText(text).width + 10;
    const h = 16;
    roundRect(c, x, y - h / 2, width, h, 3);
    c.fillStyle = color;
    c.fill();
    c.fillStyle = this.colors.bg;
    c.textAlign = "center";
    c.fillText(text, x + width / 2, y + 0.5);
  }

  private drawTimeAxis(layout: TsLayout): void {
    const { left, plotW, spanMinutes, height: h } = layout;
    const c = this.ctx;
    const xAtMinute = (minute: number) => left + (minute / spanMinutes) * plotW;
    const marks: Array<{ minute: number; label: string; align: CanvasTextAlign }> = [];
    if (this.axisMode === "full") {
      marks.push(
        { minute: 0, label: "09:30", align: "left" },
        { minute: 60, label: "10:30", align: "center" },
        { minute: 120, label: "11:30/13:00", align: "center" },
        { minute: 180, label: "14:00", align: "center" },
        { minute: 240, label: "15:00", align: "right" },
      );
    } else {
      const first = this.rows[0]?.date.slice(11, 16) || "09:30";
      const last = this.rows[this.rows.length - 1]?.date.slice(11, 16) || first;
      marks.push({ minute: 0, label: first, align: "left" });
      for (const mark of [
        { minute: 60, label: "10:30" },
        { minute: 120, label: "11:30/13:00" },
        { minute: 180, label: "14:00" },
      ]) {
        if (mark.minute < spanMinutes - 6 && mark.minute > 8) {
          marks.push({ ...mark, align: "center" });
        }
      }
      marks.push({ minute: spanMinutes, label: last, align: "right" });
    }
    for (const mark of marks) {
      c.textAlign = mark.align;
      const x = mark.align === "left" ? left : mark.align === "right" ? left + plotW : xAtMinute(mark.minute);
      c.fillText(mark.label, x, h - 16);
    }
  }

  private updateLegend(): void {
    const last = this.rows[this.rows.length - 1];
    if (!last) {
      this.legend.innerHTML = "";
      return;
    }
    const rising = last.close >= this.base;
    const mainColor = rising ? this.colors.up : this.colors.down;
    const price = last.close;
    const pct = this.pctOf(price);
    const stateChip =
      this.phase === "live"
        ? `<span class="ts-live"><i></i>盘中 ${last.date.slice(11, 16)}</span>`
        : `<span class="ts-live is-closed"><i></i>${this.phase === "lunch" ? "午间休市" : this.phase === "pre" ? "待开盘" : "已收盘"}</span>`;
    const avgHtml =
      this.kind === "stock" && this.avg.length
        ? `<span style="color:${this.colors.brass}"><i></i>均价 <b>${fmtPrice(this.avg[this.avg.length - 1] || price)}</b></span>`
        : `<span style="color:${this.colors.faint}"><i></i>昨收 <b>${this.axisPrice(this.base)}</b></span>`;
    this.legend.innerHTML = `<span style="color:${mainColor}"><i></i>分时 <b>${this.axisPrice(price)}</b></span>
      ${avgHtml}
      <span class="${rising ? "text-up" : "text-down"}">${fmtPct(pct)}</span>
      ${stateChip}`;
  }

  private showTooltip(clientX: number, clientY: number): void {
    if (this.hover == null) return;
    const row = this.rows[this.hover];
    if (!row) return;
    const avg = this.avg[this.hover] || row.close;
    const pct = this.pctOf(row.close);
    const avgRow = this.kind === "stock" && this.avg.length ? `<span>均价</span><b>${fmtPrice(avg)}</b>` : `<span>昨收</span><b>${this.axisPrice(this.base)}</b>`;
    this.tooltip.innerHTML = `<div class="ts-tip-date"><span>${row.date.slice(5)}</span><span class="text-${pct >= 0 ? "up" : "down"}">${fmtPct(pct)}</span></div>
      <div class="ts-tip-grid">
        <span>价格</span><b>${this.axisPrice(row.close)}</b>
        ${avgRow}
        <span>成交量</span><b>${fmtVolume(row.volume)}</b>
        <span>成交额</span><b>${fmtAmount(row.amount)}</b>
      </div>`;
    this.tooltip.classList.add("show");
    const rect = this.container.getBoundingClientRect();
    const w = this.tooltip.offsetWidth || 168;
    const h = this.tooltip.offsetHeight || 100;
    let left = clientX - rect.left + 14;
    if (left + w > rect.width - 8) left = clientX - rect.left - w - 14;
    let top = clientY - rect.top + 14;
    if (top + h > rect.height - 8) top = clientY - rect.top - h - 12;
    this.tooltip.style.left = `${Math.max(8, left)}px`;
    this.tooltip.style.top = `${Math.max(8, top)}px`;
  }
}
