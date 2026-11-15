import type { KlineCandle, Period } from "./lib/types";
import { fmtAmount, fmtPct, fmtPrice, fmtVolume } from "./lib/ui";

interface ChartOptions {
  period: Period;
  range: number;
  showEma: boolean;
  showKdj: boolean;
}

interface Colors {
  bg: string;
  text: string;
  muted: string;
  faint: string;
  line: string;
  lineStrong: string;
  up: string;
  down: string;
  flat: string;
  brass: string;
  violet: string;
  tooltip: string;
  surface: string;
}

interface Layout {
  width: number;
  height: number;
  left: number;
  right: number;
  priceTop: number;
  priceBottom: number;
  priceHeight: number;
  volTop: number;
  volBottom: number;
  volHeight: number;
  kdjTop: number;
  kdjBottom: number;
  kdjHeight: number;
  axisRight: number;
  bottom: number;
}

interface DragState {
  active: boolean;
  dragging: boolean;
  startX: number;
  startView: number;
  moved: number;
}

export class KLineChart {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tooltip: HTMLElement;
  private legend: HTMLElement;
  private stageEmpty: HTMLElement;
  private candles: KlineCandle[] = [];
  private period: Period;
  private range: number;
  private showEma: boolean;
  private showKdj: boolean;
  private viewStart = 0;
  private viewCount = 0;
  private hover: number | null = null;
  private drag: DragState = { active: false, dragging: false, startX: 0, startView: 0, moved: 0 };
  private layout: Layout | null = null;
  private colors: Colors;
  private raf = 0;
  private observer: ResizeObserver;
  private abort = new AbortController();
  private ema5: number[] = [];
  private ema10: number[] = [];
  private ema20: number[] = [];
  private ema60: number[] = [];
  private kdjK: number[] = [];
  private kdjD: number[] = [];
  private kdjJ: number[] = [];
  private lastLegendIndex = -2;

  constructor(container: HTMLElement, opts: ChartOptions) {
    this.container = container;
    this.period = opts.period;
    this.range = opts.range;
    this.showEma = opts.showEma;
    this.showKdj = opts.showKdj;
    this.colors = this.readColors();

    container.classList.add("kline-host");
    container.innerHTML = `
      <canvas aria-label="K线图" role="img"></canvas>
      <div class="chart-legend" aria-hidden="true"></div>
      <div class="chart-tooltip" role="status"></div>
      <div class="chart-placeholder" hidden>
        <div class="placeholder-title">暂无K线数据</div>
        <div class="placeholder-text">选择其他周期或股票再试。</div>
      </div>`;
    this.canvas = container.querySelector("canvas")!;
    this.ctx = this.canvas.getContext("2d")!;
    this.tooltip = container.querySelector(".chart-tooltip")!;
    this.legend = container.querySelector(".chart-legend")!;
    this.stageEmpty = container.querySelector(".chart-placeholder")!;
    this.canvas.tabIndex = 0;

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.bind();
    this.resize();
  }

  private readColors(): Colors {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string) => cs.getPropertyValue(name).trim();
    return {
      bg: v("--chart-bg"),
      text: v("--text"),
      muted: v("--muted"),
      faint: v("--faint"),
      line: v("--line"),
      lineStrong: v("--line-strong"),
      up: v("--up"),
      down: v("--down"),
      flat: v("--muted"),
      brass: v("--brass"),
      violet: v("--violet"),
      tooltip: v("--surface-2"),
      surface: v("--surface-3"),
    };
  }

  setData(candles: KlineCandle[]): void {
    this.candles = candles.slice();
    this.computeIndicators();
    this.resetView();
    this.lastLegendIndex = -2;
    this.stageEmpty.hidden = this.candles.length > 0;
    this.draw();
  }

  setOptions(opts: Partial<ChartOptions>): void {
    if (typeof opts.showEma === "boolean") this.showEma = opts.showEma;
    if (typeof opts.showKdj === "boolean") this.showKdj = opts.showKdj;
    if (typeof opts.range === "number" && opts.range !== this.range) {
      this.range = opts.range;
      this.resetView();
    }
    this.colors = this.readColors();
    this.lastLegendIndex = -2;
    this.renderLegend();
    this.draw();
  }

  setRange(range: number): void {
    this.range = range;
    this.resetView();
    this.draw();
  }

  redraw(): void {
    this.colors = this.readColors();
    this.draw();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.abort.abort();
    this.container.innerHTML = "";
    this.container.classList.remove("kline-host");
  }

  private resetView(): void {
    const n = this.candles.length;
    const count = this.range > 0 ? Math.min(this.range, n) : n;
    this.viewCount = Math.max(0, count);
    this.viewStart = Math.max(0, n - this.viewCount);
    this.hover = null;
    this.hideTooltip();
  }

  private computeIndicators(): void {
    const closes = this.candles.map((c) => c.close);
    this.ema5 = ema(closes, 5);
    this.ema10 = ema(closes, 10);
    this.ema20 = ema(closes, 20);
    this.ema60 = ema(closes, 60);
    const { k, d, j } = kdj(this.candles, 9);
    this.kdjK = k;
    this.kdjD = d;
    this.kdjJ = j;
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(0, Math.floor(rect.width));
    const h = Math.max(0, Math.floor(rect.height));
    if (!w || !h) return;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private bind(): void {
    const signal = this.abort.signal;
    this.canvas.addEventListener(
      "pointerdown",
      (e) => {
        this.canvas.focus({ preventScroll: true });
        const x = this.localX(e);
        this.drag = {
          active: true,
          dragging: false,
          startX: x,
          startView: this.viewStart,
          moved: 0,
        };
        this.canvas.setPointerCapture(e.pointerId);
      },
      { signal },
    );

    this.canvas.addEventListener(
      "pointermove",
      (e) => {
        const x = this.localX(e);
        if (this.drag.active) {
          const dx = x - this.drag.startX;
          this.drag.moved = Math.max(this.drag.moved, Math.abs(dx));
          if (Math.abs(dx) > 3) this.drag.dragging = true;
          if (this.drag.dragging && this.layout) {
            const slot = this.slotWidth();
            const shift = Math.round(-dx / Math.max(slot, 0.001));
            this.viewStart = clamp(
              this.drag.startView + shift,
              0,
              Math.max(0, this.candles.length - this.viewCount),
            );
            this.hideTooltip();
            this.draw();
          }
          return;
        }
        this.updateHover(x);
      },
      { signal },
    );

    const endDrag = (e: PointerEvent) => {
      if (!this.drag.active) return;
      const wasDragging = this.drag.dragging;
      this.drag.active = false;
      this.drag.dragging = false;
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      if (!wasDragging) this.updateHover(this.localX(e));
    };
    this.canvas.addEventListener("pointerup", endDrag, { signal });
    this.canvas.addEventListener("pointercancel", endDrag, { signal });
    this.canvas.addEventListener(
      "pointerleave",
      () => {
        if (this.drag.active) return;
        this.hover = null;
        this.hideTooltip();
        this.draw();
      },
      { signal },
    );

    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (!this.layout || !this.candles.length) return;
        const x = this.localX(e);
        const ratio = this.indexAtX(x);
        if (ratio == null) return;
        const anchor = ratio;
        const nextCount = clamp(
          Math.round(this.viewCount * (e.deltaY > 0 ? 1.15 : 0.87)),
          Math.min(28, this.candles.length),
          this.candles.length,
        );
        if (nextCount === this.viewCount) return;
        const anchorFrac = (anchor - this.viewStart) / Math.max(1, this.viewCount - 1);
        this.viewCount = nextCount;
        this.viewStart = clamp(
          Math.round(anchor - anchorFrac * (this.viewCount - 1)),
          0,
          Math.max(0, this.candles.length - this.viewCount),
        );
        this.updateHover(x, false);
        this.draw();
      },
      { signal, passive: false },
    );

    this.canvas.addEventListener(
      "dblclick",
      () => {
        this.resetView();
        this.draw();
      },
      { signal },
    );

    this.canvas.addEventListener(
      "keydown",
      (e) => {
        if (!this.candles.length) return;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const dir = e.key === "ArrowLeft" ? -1 : 1;
          const base = this.hover ?? this.viewStart + this.viewCount - 1;
          const next = clamp(base + dir, this.viewStart, this.viewStart + this.viewCount - 1);
          this.hover = next;
          this.updateHoverByIndex(next);
          this.draw();
        } else if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          const mid = this.hover ?? this.viewStart + this.viewCount - 1;
          this.zoomAt(mid, 0.85);
        } else if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          const mid = this.hover ?? this.viewStart + this.viewCount - 1;
          this.zoomAt(mid, 1.16);
        } else if (e.key === "Escape") {
          this.hover = null;
          this.hideTooltip();
          this.draw();
        }
      },
      { signal },
    );

    this.canvas.addEventListener(
      "focus",
      () => {
        if (this.hover == null && this.candles.length) {
          this.hover = this.viewStart + this.viewCount - 1;
          this.updateHoverByIndex(this.hover);
          this.draw();
        }
      },
      { signal },
    );
  }

  private zoomAt(index: number, factor: number): void {
    const nextCount = clamp(
      Math.round(this.viewCount * factor),
      Math.min(28, this.candles.length),
      this.candles.length,
    );
    if (nextCount === this.viewCount) return;
    const frac = (index - this.viewStart) / Math.max(1, this.viewCount - 1);
    this.viewCount = nextCount;
    this.viewStart = clamp(
      Math.round(index - frac * (this.viewCount - 1)),
      0,
      Math.max(0, this.candles.length - this.viewCount),
    );
    if (this.hover != null) this.updateHoverByIndex(clamp(this.hover, this.viewStart, this.viewStart + this.viewCount - 1));
    this.draw();
  }

  private localX(e: PointerEvent | WheelEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    return e.clientX - rect.left;
  }

  private slotWidth(): number {
    if (!this.layout || this.viewCount <= 0) return 0;
    return (this.layout.width - this.layout.left - this.layout.axisRight) / this.viewCount;
  }

  private indexAtX(x: number): number | null {
    if (!this.layout) return null;
    const slot = this.slotWidth();
    if (!slot) return null;
    const raw = this.viewStart + Math.floor((x - this.layout.left) / slot);
    return clamp(raw, this.viewStart, this.viewStart + this.viewCount - 1);
  }

  private updateHover(x: number, draw = true): void {
    if (!this.layout) return;
    const left = this.layout.left;
    const right = this.layout.width - this.layout.axisRight;
    if (x < left - 2 || x > right + 2) {
      this.hover = null;
      this.hideTooltip();
      if (draw) this.draw();
      return;
    }
    const idx = this.indexAtX(x);
    if (idx == null) return;
    const changed = this.hover !== idx;
    this.hover = idx;
    if (changed) this.updateHoverByIndex(idx);
    if (draw) this.draw();
  }

  private updateHoverByIndex(index: number): void {
    this.renderLegend(index);
    this.showTooltip(index);
  }

  private hideTooltip(): void {
    this.tooltip.classList.remove("show");
  }

  private draw(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.paint());
  }

  private paint(): void {
    const c = this.ctx;
    const rect = this.container.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (!width || !height) return;
    c.clearRect(0, 0, width, height);
    c.fillStyle = this.colors.bg;
    c.fillRect(0, 0, width, height);

    if (!this.candles.length) {
      this.stageEmpty.hidden = false;
      this.legend.innerHTML = "";
      return;
    }
    this.stageEmpty.hidden = true;

    const layout = this.calcLayout(width, height);
    this.layout = layout;
    const start = this.viewStart;
    const count = this.viewCount;
    if (count <= 0) return;
    const visible = this.candles.slice(start, start + count);
    if (!visible.length) return;

    const highs = visible.map((d) => d.high);
    const lows = visible.map((d) => d.low);
    let hi = Math.max(...highs);
    let lo = Math.min(...lows);
    if (this.showEma) {
      for (const arr of [this.ema5, this.ema10, this.ema20, this.ema60]) {
        for (let i = start; i < start + count; i++) {
          const v = arr[i];
          if (Number.isFinite(v)) {
            hi = Math.max(hi, v);
            lo = Math.min(lo, v);
          }
        }
      }
    }
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return;
    if (hi === lo) {
      hi += hi * 0.01 || 1;
      lo -= lo * 0.01 || 1;
    }
    const pad = (hi - lo) * 0.075;
    hi += pad;
    lo -= pad;
    const priceY = (v: number) =>
      layout.priceTop + ((hi - v) / Math.max(0.000001, hi - lo)) * layout.priceHeight;
    const xAt = (i: number) => layout.left + (i - start + 0.5) * this.slotWidth();

    this.drawGrid(layout, lo, hi, priceY, start, count, xAt);
    this.drawVolume(layout, visible, start, xAt);
    if (this.showKdj) this.drawKdj(layout, start, count, xAt);
    this.drawCandles(layout, visible, start, xAt, priceY);
    if (this.showEma) this.drawEma(layout, start, count, xAt, priceY);
    this.drawLastPrice(layout, visible[visible.length - 1], priceY);
    this.drawAxisDate(layout, start, count, xAt);
    if (this.hover != null && !this.drag.dragging) {
      this.drawCrosshair(layout, this.hover, priceY, xAt);
    }
    this.renderLegend(this.hover ?? Math.min(this.candles.length - 1, start + count - 1));
  }

  private calcLayout(width: number, height: number): Layout {
    const left = 9;
    const axisRight = Math.min(64, Math.max(52, width * 0.045));
    const bottom = 21;
    const topPad = 12;
    const total = height - topPad - bottom;
    const gap1 = 18;
    const gap2 = 19;
    const wantVol = clamp(total * 0.14, 38, 64);
    const wantKdj = this.showKdj ? clamp(total * 0.23, 82, 126) : 0;
    const priceHeight = Math.max(120, total - wantVol - wantKdj - gap1 - (this.showKdj ? gap2 : 0));
    const priceTop = topPad;
    const priceBottom = priceTop + priceHeight;
    const volTop = priceBottom + gap1;
    const volBottom = volTop + wantVol;
    const kdjTop = volBottom + gap2;
    const kdjBottom = kdjTop + wantKdj;
    return {
      width,
      height,
      left,
      right: width - axisRight,
      priceTop,
      priceBottom,
      priceHeight,
      volTop,
      volBottom,
      volHeight: wantVol,
      kdjTop,
      kdjBottom,
      kdjHeight: wantKdj,
      axisRight,
      bottom,
    };
  }

  private drawGrid(
    l: Layout,
    lo: number,
    hi: number,
    priceY: (v: number) => number,
    start: number,
    count: number,
    xAt: (i: number) => number,
  ): void {
    const c = this.ctx;
    c.save();
    c.strokeStyle = this.colors.line;
    c.lineWidth = 1;
    c.font = '9px "IBM Plex Mono", monospace';
    c.fillStyle = this.colors.faint;
    c.textBaseline = "middle";
    c.textAlign = "left";
    const lines = 4;
    for (let i = 0; i <= lines; i++) {
      const y = Math.round(l.priceTop + (l.priceHeight / lines) * i) + 0.5;
      c.beginPath();
      c.moveTo(l.left, y);
      c.lineTo(l.width - l.axisRight, y);
      c.stroke();
      const value = hi - ((hi - lo) / lines) * i;
      c.fillText(value.toFixed(2), l.width - l.axisRight + 8, y);
    }
    const tickCount = Math.max(3, Math.min(6, Math.floor((l.width - l.left - l.axisRight) / 132)));
    for (let t = 0; t < tickCount; t++) {
      const idx = start + Math.round(((count - 1) * t) / Math.max(1, tickCount - 1));
      const x = Math.round(xAt(idx)) + 0.5;
      c.strokeStyle = this.colors.line;
      c.beginPath();
      c.moveTo(x, l.priceTop);
      c.lineTo(x, this.showKdj ? l.kdjBottom : l.volBottom);
      c.stroke();
    }
    c.strokeStyle = this.colors.line;
    c.beginPath();
    c.moveTo(l.left, l.priceBottom + 0.5);
    c.lineTo(l.width - l.axisRight, l.priceBottom + 0.5);
    c.moveTo(l.left, l.volTop - 0.5);
    c.lineTo(l.width - l.axisRight, l.volTop - 0.5);
    if (this.showKdj) {
      c.moveTo(l.left, l.kdjTop - 0.5);
      c.lineTo(l.width - l.axisRight, l.kdjTop - 0.5);
    }
    c.stroke();

    c.font = '8px "Noto Sans SC", sans-serif';
    c.fillStyle = this.colors.faint;
    c.textBaseline = "top";
    c.fillText("成交量", l.left + 1, l.volTop + 3);
    if (this.showKdj) c.fillText("KDJ (9, 3, 3)", l.left + 1, l.kdjTop + 3);
    c.restore();
  }

  private drawCandles(
    l: Layout,
    visible: KlineCandle[],
    start: number,
    xAt: (i: number) => number,
    priceY: (v: number) => number,
  ): void {
    const c = this.ctx;
    const slot = this.slotWidth();
    const bodyW = Math.min(13, Math.max(1, slot * 0.62));
    c.save();
    c.beginPath();
    c.rect(l.left, l.priceTop, l.width - l.left - l.axisRight, l.priceHeight);
    c.clip();
    for (let i = 0; i < visible.length; i++) {
      const d = visible[i];
      const x = xAt(start + i);
      const up = d.close >= d.open;
      const color = d.close === d.open ? this.colors.flat : up ? this.colors.up : this.colors.down;
      const yHigh = priceY(d.high);
      const yLow = priceY(d.low);
      const yOpen = priceY(d.open);
      const yClose = priceY(d.close);
      c.strokeStyle = color;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(Math.round(x) + 0.5, Math.round(yHigh));
      c.lineTo(Math.round(x) + 0.5, Math.round(yLow));
      c.stroke();
      const bodyTop = Math.min(yOpen, yClose);
      const bodyH = Math.max(1.2, Math.abs(yClose - yOpen));
      if (bodyW <= 1.2) {
        c.fillStyle = color;
        c.fillRect(Math.floor(x), Math.floor(bodyTop), Math.max(1, Math.round(bodyW)), Math.max(1, Math.round(bodyH)));
      } else {
        c.fillStyle = color;
        c.globalAlpha = up ? 0.94 : 0.9;
        c.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
        c.globalAlpha = 1;
      }
    }
    c.restore();
  }

  private drawEma(
    l: Layout,
    start: number,
    count: number,
    xAt: (i: number) => number,
    priceY: (v: number) => number,
  ): void {
    const c = this.ctx;
    const series: Array<[number[], string]> = [
      [this.ema5, this.colors.brass],
      [this.ema10, this.colors.up],
      [this.ema20, this.colors.down],
      [this.ema60, this.colors.violet],
    ];
    c.save();
    c.beginPath();
    c.rect(l.left, l.priceTop, l.width - l.left - l.axisRight, l.priceHeight);
    c.clip();
    for (const [arr, color] of series) {
      c.beginPath();
      c.strokeStyle = color;
      c.lineWidth = 1.15;
      c.globalAlpha = 0.78;
      let started = false;
      for (let i = start; i < start + count; i++) {
        const v = arr[i];
        if (!Number.isFinite(v)) continue;
        const x = xAt(i);
        const y = priceY(v);
        if (!started) {
          c.moveTo(x, y);
          started = true;
        } else {
          c.lineTo(x, y);
        }
      }
      c.stroke();
    }
    c.restore();
  }

  private drawVolume(l: Layout, visible: KlineCandle[], start: number, xAt: (i: number) => number): void {
    const c = this.ctx;
    const slot = this.slotWidth();
    const bodyW = Math.max(1, Math.min(13, slot * 0.62));
    const max = Math.max(1, ...visible.map((d) => d.volume));
    c.save();
    c.fillStyle = this.colors.faint;
    c.font = '8px "IBM Plex Mono", monospace';
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillText(fmtVolume(max), l.width - l.axisRight + 8, l.volTop + 8);
    for (let i = 0; i < visible.length; i++) {
      const d = visible[i];
      const x = xAt(start + i);
      const h = (d.volume / max) * (l.volHeight - 10);
      const y = l.volBottom - h;
      c.fillStyle = d.close >= d.open ? this.colors.up : this.colors.down;
      c.globalAlpha = 0.3;
      c.fillRect(x - bodyW / 2, y, bodyW, Math.max(0.7, h));
    }
    c.globalAlpha = 1;
    c.restore();
  }

  private drawKdj(l: Layout, start: number, count: number, xAt: (i: number) => number): void {
    if (!this.showKdj) return;
    const c = this.ctx;
    const y = (v: number) => l.kdjBottom - (clamp(v, 0, 100) / 100) * l.kdjHeight;
    c.save();
    c.strokeStyle = this.colors.line;
    c.setLineDash([3, 4]);
    c.lineWidth = 1;
    for (const level of [20, 80]) {
      c.beginPath();
      c.moveTo(l.left, y(level));
      c.lineTo(l.width - l.axisRight, y(level));
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = this.colors.faint;
      c.font = '8px "IBM Plex Mono", monospace';
      c.textAlign = "left";
      c.textBaseline = "middle";
      c.fillText(String(level), l.width - l.axisRight + 8, y(level));
      c.setLineDash([3, 4]);
    }
    c.setLineDash([]);
    c.beginPath();
    c.rect(l.left, l.kdjTop, l.width - l.left - l.axisRight, l.kdjHeight);
    c.clip();
    const series: Array<[number[], string]> = [
      [this.kdjK, this.colors.brass],
      [this.kdjD, this.colors.down],
      [this.kdjJ, this.colors.violet],
    ];
    for (const [arr, color] of series) {
      c.beginPath();
      c.strokeStyle = color;
      c.lineWidth = 1.15;
      c.globalAlpha = 0.84;
      let started = false;
      for (let i = start; i < start + count; i++) {
        const v = arr[i];
        if (!Number.isFinite(v)) continue;
        const x = xAt(i);
        const py = y(v);
        if (!started) {
          c.moveTo(x, py);
          started = true;
        } else {
          c.lineTo(x, py);
        }
      }
      c.stroke();
    }
    c.restore();
  }

  private drawLastPrice(l: Layout, last: KlineCandle, priceY: (v: number) => number): void {
    const c = this.ctx;
    const y = priceY(last.close);
    c.save();
    c.strokeStyle = this.colors.brass;
    c.globalAlpha = 0.45;
    c.setLineDash([2, 4]);
    c.beginPath();
    c.moveTo(l.left, y);
    c.lineTo(l.width - l.axisRight, y);
    c.stroke();
    c.setLineDash([]);
    c.globalAlpha = 1;
    const label = last.close.toFixed(2);
    const x = l.width - l.axisRight + 4;
    c.fillStyle = this.colors.brass;
    c.globalAlpha = 0.16;
    roundRect(c, x, y - 8, l.axisRight - 6, 16, 3);
    c.fill();
    c.globalAlpha = 1;
    c.fillStyle = this.colors.brass;
    c.font = '9px "IBM Plex Mono", monospace';
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillText(label, x + 4, y);
    c.restore();
  }

  private drawAxisDate(
    l: Layout,
    start: number,
    count: number,
    xAt: (i: number) => number,
  ): void {
    const c = this.ctx;
    const tickCount = Math.max(3, Math.min(6, Math.floor((l.width - l.left - l.axisRight) / 132)));
    c.save();
    c.font = '8.5px "IBM Plex Mono", monospace';
    c.fillStyle = this.colors.faint;
    c.textBaseline = "top";
    for (let t = 0; t < tickCount; t++) {
      const idx = start + Math.round(((count - 1) * t) / Math.max(1, tickCount - 1));
      const d = this.candles[idx];
      if (!d) continue;
      const x = xAt(idx);
      const label = this.formatAxisDate(d.date);
      c.textAlign = t === 0 ? "left" : t === tickCount - 1 ? "right" : "center";
      c.fillText(label, x, l.height - l.bottom + 8);
    }
    c.restore();
  }

  private formatAxisDate(date: string): string {
    if (date.length === 10) {
      const [y, m, d] = date.split("-");
      if (this.period === "month") return `${y.slice(2)}.${m}`;
      return `${m}.${d}`;
    }
    return date;
  }

  private drawCrosshair(
    l: Layout,
    index: number,
    priceY: (v: number) => number,
    xAt: (i: number) => number,
  ): void {
    const d = this.candles[index];
    if (!d) return;
    const c = this.ctx;
    const x = xAt(index);
    const y = priceY(d.close);
    c.save();
    c.strokeStyle = this.colors.lineStrong;
    c.lineWidth = 1;
    c.setLineDash([3, 3]);
    c.beginPath();
    c.moveTo(x, l.priceTop);
    c.lineTo(x, this.showKdj ? l.kdjBottom : l.volBottom);
    c.stroke();
    c.beginPath();
    c.moveTo(l.left, y);
    c.lineTo(l.width - l.axisRight, y);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = this.colors.brass;
    c.beginPath();
    c.arc(x, y, 2.2, 0, Math.PI * 2);
    c.fill();
    const label = d.close.toFixed(2);
    const rx = l.width - l.axisRight + 4;
    c.fillStyle = this.colors.brass;
    c.globalAlpha = 0.18;
    roundRect(c, rx, y - 8.5, l.axisRight - 6, 17, 3);
    c.fill();
    c.globalAlpha = 1;
    c.fillStyle = this.colors.brass;
    c.font = '9px "IBM Plex Mono", monospace';
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillText(label, rx + 4, y);
    const dateLabel = this.fullDate(d.date);
    c.font = '8.5px "IBM Plex Mono", monospace';
    const tw = c.measureText(dateLabel).width;
    const tx = clamp(x - tw / 2 - 6, l.left, l.width - l.axisRight - tw - 12);
    c.fillStyle = this.colors.brass;
    c.globalAlpha = 0.18;
    roundRect(c, tx, l.height - l.bottom + 2, tw + 12, 16, 3);
    c.fill();
    c.globalAlpha = 1;
    c.fillStyle = this.colors.brass;
    c.textAlign = "left";
    c.fillText(dateLabel, tx + 6, l.height - l.bottom + 10);
    c.restore();
  }

  private fullDate(date: string): string {
    if (date.length === 10) return date;
    if (date.length === 8) return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    return date;
  }

  private showTooltip(index: number): void {
    const d = this.candles[index];
    if (!d || !this.layout) return;
    const layout = this.layout;
    const pctUp = d.pct >= 0;
    const c = d.close;
    const chg = d.open ? ((d.close - d.open) / d.open) * 100 : 0;
    const emaVals = [this.ema5[index], this.ema10[index], this.ema20[index], this.ema60[index]];
    const k = this.kdjK[index];
    const dd = this.kdjD[index];
    const j = this.kdjJ[index];
    this.tooltip.innerHTML = `
      <div class="tooltip-date"><span>${this.fullDate(d.date)}</span><span class="tooltip-pct ${pctUp ? "" : "down"}">${fmtPct(d.pct)}</span></div>
      <div class="tooltip-grid">
        <span>开盘</span><span>${fmtPrice(d.open)}</span>
        <span>最高</span><span>${fmtPrice(d.high)}</span>
        <span>最低</span><span>${fmtPrice(d.low)}</span>
        <span>收盘</span><span>${fmtPrice(c)}</span>
        <span>成交量</span><span>${fmtVolume(d.volume)}</span>
        <span>成交额</span><span>${fmtAmount(d.amount)}</span>
        <span>换手</span><span>${d.turnover.toFixed(2)}%</span>
        <span>振幅</span><span>${(((d.high - d.low) / Math.max(0.001, d.open)) * 100).toFixed(2)}%</span>
      </div>
      <div class="tooltip-inds">
        ${this.showEma ? `<span style="color:var(--brass)">EMA5 ${fmtPrice(emaVals[0])}</span><span style="color:var(--up)">EMA10 ${fmtPrice(emaVals[1])}</span><span style="color:var(--down)">EMA20 ${fmtPrice(emaVals[2])}</span><span style="color:var(--violet)">EMA60 ${fmtPrice(emaVals[3])}</span>` : ""}
        ${this.showKdj ? `<span style="color:var(--brass)">K ${fmtPrice(k, 1)}</span><span style="color:var(--down)">D ${fmtPrice(dd, 1)}</span><span style="color:var(--violet)">J ${fmtPrice(j, 1)}</span>` : ""}
        ${!this.showEma && !this.showKdj ? `<span>涨跌 ${chg.toFixed(2)}%</span>` : ""}
      </div>`;
    const x = this.xForIndex(index);
    const stageW = this.container.clientWidth;
    const tw = this.tooltip.offsetWidth || 196;
    const th = this.tooltip.offsetHeight || 170;
    let left = x + 16;
    if (left + tw > stageW - 8) left = x - tw - 16;
    left = clamp(left, 8, stageW - tw - 8);
    let top = layout.priceTop + 8;
    if (top + th > layout.kdjBottom - 4) top = Math.max(layout.priceTop + 4, layout.kdjBottom - th - 4);
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
    this.tooltip.classList.add("show");
  }

  private xForIndex(index: number): number {
    if (!this.layout) return 0;
    return this.layout.left + (index - this.viewStart + 0.5) * this.slotWidth();
  }

  private renderLegend(index: number | null = null): void {
    if (index == null) index = this.candles.length - 1;
    if (index < 0) index = 0;
    if (index === this.lastLegendIndex) return;
    this.lastLegendIndex = index;
    const fmt = (v: number) => (Number.isFinite(v) ? fmtPrice(v) : "—");
    const parts: string[] = [];
    if (this.showEma) {
      parts.push(`<span class="legend-item ema5"><i class="legend-swatch"></i>EMA5 ${fmt(this.ema5[index])}</span>`);
      parts.push(`<span class="legend-item ema10"><i class="legend-swatch"></i>EMA10 ${fmt(this.ema10[index])}</span>`);
      parts.push(`<span class="legend-item ema20"><i class="legend-swatch"></i>EMA20 ${fmt(this.ema20[index])}</span>`);
      parts.push(`<span class="legend-item ema60"><i class="legend-swatch"></i>EMA60 ${fmt(this.ema60[index])}</span>`);
    }
    if (this.showKdj) {
      parts.push(`<span class="legend-item kdj-k">K ${fmt(this.kdjK[index])}</span>`);
      parts.push(`<span class="legend-item kdj-d">D ${fmt(this.kdjD[index])}</span>`);
      parts.push(`<span class="legend-item kdj-j">J ${fmt(this.kdjJ[index])}</span>`);
    }
    this.legend.innerHTML = parts.join("");
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length);
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function kdj(candles: KlineCandle[], period = 9): { k: number[]; d: number[]; j: number[] } {
  const k: number[] = [];
  const d: number[] = [];
  const j: number[] = [];
  let prevK = 50;
  let prevD = 50;
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - period + 1);
    let hi = -Infinity;
    let lo = Infinity;
    for (let x = start; x <= i; x++) {
      hi = Math.max(hi, candles[x].high);
      lo = Math.min(lo, candles[x].low);
    }
    const rsv = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
    prevK = (2 / 3) * prevK + (1 / 3) * rsv;
    prevD = (2 / 3) * prevD + (1 / 3) * prevK;
    k.push(prevK);
    d.push(prevD);
    j.push(3 * prevK - 2 * prevD);
  }
  return { k, d, j };
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + radius, y);
  c.arcTo(x + w, y, x + w, y + h, radius);
  c.arcTo(x + w, y + h, x, y + h, radius);
  c.arcTo(x, y + h, x, y, radius);
  c.arcTo(x, y, x + w, y, radius);
  c.closePath();
}
