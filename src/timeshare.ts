import type { KlineCandle } from "./lib/types";
import { fmtAmount, fmtPct, fmtPrice, fmtVolume } from "./lib/ui";

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

interface TsLayout {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  priceBottom: number;
  volTop: number;
  volBottom: number;
  priceMin: number;
  priceMax: number;
  volMax: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
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
  private axisMode: "full" | "follow";
  private colors: TsColors;
  private observer: ResizeObserver;
  private abort = new AbortController();
  private raf = 0;

  constructor(container: HTMLElement, axisMode: "full" | "follow" = "full") {
    this.container = container;
    this.axisMode = axisMode;
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
      this.draw();
      return;
    }
    const day = last.date.slice(0, 10);
    this.rows = candles
      .filter((c) => c.date.startsWith(day))
      .sort((a, b) => a.date.localeCompare(b.date));
    this.base = prevClose && prevClose > 0 ? prevClose : this.rows[0]?.open || this.rows[0]?.close || 0;
    let amount = 0;
    let volume = 0;
    let lastAvg = this.base;
    this.avg = this.rows.map((c) => {
      amount += Math.max(0, c.amount);
      volume += Math.max(0, c.volume);
      if (volume > 0 && amount > 0) lastAvg = amount / (volume * 100);
      return lastAvg || c.close;
    });
    this.hover = null;
    this.tooltip.classList.remove("show");
    this.colors = this.readColors();
    this.draw();
  }

  setAxisMode(mode: "full" | "follow"): void {
    if (this.axisMode === mode) return;
    this.axisMode = mode;
    this.draw();
  }

  redraw(): void {
    this.colors = this.readColors();
    this.draw();
  }

  destroy(): void {
    this.abort.abort();
    this.observer.disconnect();
    cancelAnimationFrame(this.raf);
  }

  private bind(): void {
    const signal = this.abort.signal;
    this.canvas.addEventListener(
      "mousemove",
      (event) => {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        this.hover = this.indexAt(x);
        this.draw();
        this.showTooltip(event.clientX, event.clientY);
      },
      { signal },
    );
    this.canvas.addEventListener(
      "mouseleave",
      () => {
        this.hover = null;
        this.tooltip.classList.remove("show");
        this.draw();
      },
      { signal },
    );
  }

  private sessionMinute(index: number): number {
    const date = this.rows[clamp(index, 0, this.rows.length - 1)]?.date ?? "";
    const hour = Number(date.slice(11, 13));
    const minute = Number(date.slice(14, 16));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
    const clock = hour * 60 + minute;
    if (clock <= 690) return clamp(clock - 570, 0, 120);
    if (clock >= 780) return clamp(120 + clock - 780, 120, 240);
    return 120;
  }

  private xAt(index: number, layout: TsLayout): number {
    const plotW = Math.max(1, layout.width - layout.left - layout.right);
    if (this.axisMode === "full") {
      return layout.left + (this.sessionMinute(index) / 240) * plotW;
    }
    return layout.left + (index / Math.max(1, this.rows.length - 1)) * plotW;
  }

  private indexAt(x: number): number {
    const l = this.layout;
    if (!l || this.rows.length < 2) return 0;
    if (this.axisMode === "full") {
      let best = 0;
      let distance = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.rows.length; i++) {
        const next = Math.abs(this.xAt(i, l) - x);
        if (next < distance) {
          distance = next;
          best = i;
        }
      }
      return best;
    }
    const ratio = clamp((x - l.left) / Math.max(1, l.width - l.left - l.right), 0, 1);
    return Math.round(ratio * (this.rows.length - 1));
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
    this.draw();
  }

  private draw(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.paint());
  }

  private paint(): void {
    const c = this.ctx;
    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const height = this.canvas.height / (window.devicePixelRatio || 1);
    c.clearRect(0, 0, width, height);
    c.fillStyle = this.colors.bg;
    c.fillRect(0, 0, width, height);
    if (!this.rows.length) return;

    const left = 8;
    const right = 58;
    const top = 26;
    const bottom = 22;
    const volHeight = clamp(height * 0.16, 64, 96);
    const gap = 12;
    const priceBottom = height - bottom - volHeight - gap;
    const volTop = height - bottom - volHeight;
    const volBottom = height - bottom;

    let priceMin = this.base;
    let priceMax = this.base;
    for (let i = 0; i < this.rows.length; i++) {
      priceMin = Math.min(priceMin, this.rows[i].low, this.avg[i]);
      priceMax = Math.max(priceMax, this.rows[i].high, this.avg[i]);
    }
    const span = Math.max(priceMax - priceMin, this.base * 0.004 || 0.01);
    priceMin -= span * 0.08;
    priceMax += span * 0.08;
    const volMax = Math.max(...this.rows.map((r) => r.volume), 1);

    const layout: TsLayout = {
      width,
      height,
      left,
      right,
      top,
      priceBottom,
      volTop,
      volBottom,
      priceMin,
      priceMax,
      volMax,
    };
    this.layout = layout;
    const plotW = Math.max(1, width - left - right);
    const xAt = (i: number) => this.xAt(i, layout);
    const yAt = (v: number) => top + ((priceMax - v) / (priceMax - priceMin)) * (priceBottom - top);

    c.save();
    c.font = '9px "IBM Plex Mono", monospace';
    c.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const v = priceMin + ((priceMax - priceMin) * i) / 4;
      const y = yAt(v);
      c.strokeStyle = this.colors.grid;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(left, y + 0.5);
      c.lineTo(width - right, y + 0.5);
      c.stroke();
      c.fillStyle = this.colors.faint;
      c.textAlign = "left";
      c.fillText(fmtPrice(v), width - right + 7, y);
    }

    const by = yAt(this.base);
    if (by > top && by < priceBottom) {
      c.strokeStyle = this.colors.line;
      c.setLineDash([4, 4]);
      c.beginPath();
      c.moveTo(left, by);
      c.lineTo(width - right, by);
      c.stroke();
      c.setLineDash([]);
    }

    const last = this.rows[this.rows.length - 1];
    const rising = last.close >= this.base;
    const mainColor = rising ? this.colors.up : this.colors.down;
    const area = c.createLinearGradient(0, top, 0, priceBottom);
    area.addColorStop(0, rising ? "rgba(225,90,77,.18)" : "rgba(87,166,142,.18)");
    area.addColorStop(1, "rgba(0,0,0,0)");

    c.beginPath();
    this.rows.forEach((r, i) => {
      if (i === 0) c.moveTo(xAt(i), yAt(r.close));
      else c.lineTo(xAt(i), yAt(r.close));
    });
    c.lineTo(xAt(this.rows.length - 1), priceBottom);
    c.lineTo(xAt(0), priceBottom);
    c.closePath();
    c.fillStyle = area;
    c.fill();

    c.beginPath();
    this.rows.forEach((r, i) => {
      if (i === 0) c.moveTo(xAt(i), yAt(r.close));
      else c.lineTo(xAt(i), yAt(r.close));
    });
    c.strokeStyle = mainColor;
    c.lineWidth = 1.5;
    c.lineJoin = "round";
    c.stroke();

    c.beginPath();
    this.avg.forEach((v, i) => {
      if (i === 0) c.moveTo(xAt(i), yAt(v));
      else c.lineTo(xAt(i), yAt(v));
    });
    c.strokeStyle = this.colors.brass;
    c.lineWidth = 1.05;
    c.globalAlpha = 0.88;
    c.stroke();
    c.globalAlpha = 1;

    // 成交量
    c.strokeStyle = this.colors.grid;
    c.beginPath();
    c.moveTo(left, volTop - 0.5);
    c.lineTo(width - right, volTop - 0.5);
    c.stroke();
    const slotCount = this.axisMode === "full" ? 240 : this.rows.length;
    const barW = Math.max(0.6, Math.min(4, plotW / Math.max(1, slotCount) - 0.5));
    c.globalAlpha = 0.72;
    this.rows.forEach((r, i) => {
      const h = (r.volume / volMax) * (volBottom - volTop - 6);
      c.fillStyle = r.close >= r.open ? this.colors.up : this.colors.down;
      c.fillRect(xAt(i) - barW / 2, volBottom - h, barW, h);
    });
    c.globalAlpha = 1;
    c.font = '8px "Noto Sans SC", sans-serif';
    c.fillStyle = this.colors.faint;
    c.textAlign = "left";
    c.fillText("成交量", left, volTop + 8);

    // 时间刻度：全天模式固定 09:30–15:00；跟随模式只画已经发生的时点。
    c.font = '10px "IBM Plex Mono", monospace';
    c.fillStyle = this.colors.muted;
    c.textBaseline = "top";
    if (this.axisMode === "full") {
      const marks = [
        { minute: 0, label: "09:30" },
        { minute: 60, label: "10:30" },
        { minute: 120, label: "11:30/13:00" },
        { minute: 180, label: "14:00" },
        { minute: 240, label: "15:00" },
      ];
      marks.forEach((mark, index) => {
        const x = left + (mark.minute / 240) * plotW;
        c.textAlign = index === 0 ? "left" : index === marks.length - 1 ? "right" : "center";
        c.fillText(mark.label, x, height - 16);
      });
    } else {
      const timeAt = (i: number) => this.rows[clamp(i, 0, this.rows.length - 1)].date.slice(11, 16);
      const findTime = (wanted: string) => {
        const found = this.rows.findIndex((row) => row.date.slice(11, 16) >= wanted);
        return found >= 0 ? found : -1;
      };
      const firstTime = timeAt(0);
      const ticks = [
        { i: 0, label: firstTime <= "09:35" ? "09:30" : firstTime },
        { i: findTime("10:30"), label: "10:30" },
        { i: findTime("11:30"), label: "11:30/13:00" },
        { i: findTime("14:00"), label: "14:00" },
        { i: findTime("15:00"), label: "15:00" },
      ].filter((tick, index, list) => tick.i >= 0 && (index === 0 || tick.i > list[index - 1].i));
      const lastIdx = this.rows.length - 1;
      if (ticks[ticks.length - 1]?.i !== lastIdx) ticks.push({ i: lastIdx, label: timeAt(lastIdx) });
      ticks.forEach((tick, index) => {
        const x = xAt(tick.i);
        c.textAlign = index === 0 ? "left" : index === ticks.length - 1 ? "right" : "center";
        c.fillText(tick.label, x, height - 16);
      });
    }

    // 十字光标
    if (this.hover != null && this.hover >= 0 && this.hover < this.rows.length) {
      const row = this.rows[this.hover];
      const x = xAt(this.hover);
      const y = yAt(row.close);
      c.strokeStyle = this.colors.muted;
      c.globalAlpha = 0.5;
      c.setLineDash([3, 3]);
      c.beginPath();
      c.moveTo(x, top);
      c.lineTo(x, volBottom);
      c.moveTo(left, y);
      c.lineTo(width - right, y);
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
      c.fillStyle = mainColor;
      c.beginPath();
      c.arc(x, y, 3, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();

    const price = last.close;
    const avg = this.avg[this.avg.length - 1] || price;
    const pct = this.base > 0 ? ((price - this.base) / this.base) * 100 : 0;
    this.legend.innerHTML = `<span style="color:${mainColor}"><i></i>分时 <b>${fmtPrice(price)}</b></span>
      <span style="color:${this.colors.brass}"><i></i>均价 <b>${fmtPrice(avg)}</b></span>
      <span class="${rising ? "text-up" : "text-down"}">${fmtPct(pct)}</span>`;
  }

  private showTooltip(clientX: number, clientY: number): void {
    if (this.hover == null) return;
    const row = this.rows[this.hover];
    if (!row) return;
    const avg = this.avg[this.hover] || row.close;
    const pct = this.base > 0 ? ((row.close - this.base) / this.base) * 100 : 0;
    this.tooltip.innerHTML = `<div class="ts-tip-date"><span>${row.date.slice(5)}</span><span class="text-${pct >= 0 ? "up" : "down"}">${fmtPct(pct)}</span></div>
      <div class="ts-tip-grid">
        <span>价格</span><b>${fmtPrice(row.close)}</b>
        <span>均价</span><b>${fmtPrice(avg)}</b>
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
