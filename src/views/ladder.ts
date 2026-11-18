import { esc, fmtClock, fmtMoney, fmtPct, fmtPrice, icon, intradaySparkline, relTime, tierName, tone } from "../lib/ui";
import { sparkWindow, type SparkWindow } from "../lib/market";
import { isToday, state } from "../lib/state";
import type { Stock } from "../lib/types";
import { emptyState, errorState, renderViewHead, warningBanner } from "./common";

function stockCard(s: Stock, compact: boolean, index: number, spark: SparkWindow): string {
  const pctCls = tone(s.changeRate);
  const primary = s.primarySector || s.sectors[0] || "";
  const pct = `<span class="card-pct text-${pctCls}">${fmtPct(s.changeRate)}</span>`;
  const sparkSvg =
    !compact && spark.samples.length > 2
      ? intradaySparkline(spark.samples, { width: 96, height: 32, className: "card-spark", live: spark.live })
      : "";

  if (compact) {
    const previous = s.board > s.streak ? s.highDays : "";
    const subline = previous ? `<span class="sector-name previous-run">${esc(previous)}</span>` : `<span class="sector-name">${esc(primary || "—")}</span>`;
    return `<button class="stock-card compact" style="--i:${index}" data-stock-code="${s.code}" data-stock-name="${esc(s.name)}" title="${esc(s.highDays)} · ${esc(s.limitType)} · ${esc(primary)}" aria-label="查看 ${esc(s.name)} K线">
      <span class="compact-line"></span>
      <div class="card-top">
        <span class="card-name">${esc(s.name)}</span>
        <span class="card-code">${s.code}</span>
      </div>
      <div class="card-sub">
        ${subline}
        ${pct}
      </div>
    </button>`;
  }

  const reason = s.reasonTags.slice(0, 2).join(" · ") || primary || "—";
  const extra = s.highDays && s.highDays !== `${s.streak}板` ? s.highDays : s.limitType;
  const seal = s.sealAmount > 0 ? fmtMoney(s.sealAmount) : "—";
  return `<button class="stock-card" style="--i:${index}" data-stock-code="${s.code}" data-stock-name="${esc(s.name)}" aria-label="查看 ${esc(s.name)} K线">
    ${sparkSvg}
    <div class="card-top">
      <span class="card-name">${esc(s.name)}</span>
      <span class="card-code">${s.code}</span>
      <span class="card-sector">${esc(primary)}</span>
    </div>
    <div class="card-price-row">
      <span class="card-price">${fmtPrice(s.price)}</span>
      ${pct}
      <span class="card-hint">查看K线</span>
    </div>
    <div class="card-tagline" title="${esc(s.reason)}">${esc(reason)}</div>
    <div class="card-foot">
      <span>封 ${seal}</span>
      <span class="dot">·</span>
      <span>${fmtClock(s.firstSeal)}</span>
      <span class="dot">·</span>
      <span>${esc(extra)}</span>
    </div>
  </button>`;
}

function heroCard(s: Stock, spark: SparkWindow): string {
  const primary = s.primarySector || s.sectors[0] || "—";
  const pctCls = tone(s.changeRate);
  const limitAt = spark.samples.findIndex((v) => v >= (s.changeRate >= 19 ? 19.5 : 9.7));
  const sealLeft = limitAt > 1 ? (limitAt * 3 * 100) / 240 : 0;
  const sealMark =
    limitAt > 1 && limitAt < spark.samples.length - 1
      ? `<span class="hero-seal-mark" style="left:${sealLeft.toFixed(2)}%"><i>封板</i></span>`
      : "";
  const endPct = spark.samples.length ? Math.min(100, (spark.samples.length - 1) * 3 * 100 / 240) : 0;
  const liveLabel =
    spark.phase === "live"
      ? `<i class="spark-live-dot"></i>盘中 ${spark.endClock}`
      : spark.phase === "lunch"
        ? "午间休市"
        : spark.phase === "pre"
          ? "待开盘"
          : "已收盘";
  const sparkHtml =
    spark.samples.length > 2
      ? `<div class="hero-spark">${intradaySparkline(spark.samples, { width: 320, height: 72, live: spark.live, showNow: true })}${sealMark}</div>
         <div class="hero-spark-axis">
           <span>09:30</span><span>11:30</span><span>15:00</span>
           ${spark.live && endPct > 12 && endPct < 90 ? `<span class="hero-axis-now" style="left:${endPct.toFixed(2)}%">${spark.endClock}</span>` : ""}
         </div>`
      : "";
  return `<button class="stock-card hero" data-stock-code="${s.code}" data-stock-name="${esc(s.name)}" aria-label="查看 ${esc(s.name)} K线">
    <div class="hero-copy">
      <div class="hero-kicker"><span class="hero-kicker-dot"></span>市场最高</div>
      <div class="card-top">
        <span class="card-name">${esc(s.name)}</span>
        <span class="card-code">${s.code}</span>
        <span class="card-sector">${esc(primary)}</span>
      </div>
      <div class="hero-price-row">
        <span class="hero-price">${fmtPrice(s.price)}</span>
        <span class="card-pct text-${pctCls}">${fmtPct(s.changeRate)}</span>
        <span class="hero-height">${esc(s.highDays)}</span>
      </div>
      <div class="card-tagline" title="${esc(s.reason)}">${esc(s.reasonTags.slice(0, 3).join(" · ") || primary)}</div>
      <div class="hero-meta">
        <span><i>封单</i>${s.sealAmount > 0 ? fmtMoney(s.sealAmount) : "—"}</span>
        <span><i>首封</i>${fmtClock(s.firstSeal)}</span>
        <span><i>开板</i>${s.openNum} 次</span>
      </div>
    </div>
    <div class="hero-visual">
      ${
        sparkHtml
          ? `<div class="hero-spark-head"><span>分时走势</span><span class="hero-spark-state">${liveLabel}${s.limitType ? ` · ${esc(s.limitType)}` : ""}</span></div>${sparkHtml}`
          : `<div class="hero-empty">${esc(s.limitType || "涨停")} · ${esc(s.highDays)}</div>`
      }
      <div class="hero-visual-foot"><span>查看 K 线 ${icon("arrowUpRight", 12)}</span><span>${esc(s.highDays)}</span></div>
    </div>
  </button>`;
}

function ladderSkeleton(): string {
  return `<div class="ladder-skeleton">
    ${[4, 3, 2, 1]
      .map(
        (n) => `<div class="sk-tier">
          <div class="sk sk-tier-num"></div>
          <div class="sk-card-row">${Array.from({ length: Math.min(n, 4) })
            .map(() => `<span class="sk sk-card"></span>`)
            .join("")}</div>
        </div>`,
      )
      .join("")}
  </div>`;
}

function sealBands(stocks: Stock[]): number[] {
  const bands = [0, 0, 0];
  for (const s of stocks) {
    if (!s.firstSeal) continue;
    const sec = (s.firstSeal + 8 * 3600) % 86400;
    if (sec < 10 * 3600) bands[0] += 1;
    else if (sec < 13 * 3600) bands[1] += 1;
    else bands[2] += 1;
  }
  return bands;
}

function renderSide(): string {
  const day = state.day;
  if (!day) return "";
  const sectors = day.sectors.filter((s) => s.limitUpNum > 0).slice(0, 7);
  const maxSector = Math.max(1, ...sectors.map((s) => s.limitUpNum));
  const sealTop = [...day.stocks].sort((a, b) => b.sealAmount - a.sealAmount).slice(0, 5);
  const bands = sealBands(day.stocks);
  const bandMax = Math.max(1, ...bands);
  const bandsMeta = [
    { label: "10点前", value: bands[0] },
    { label: "10–13点", value: bands[1] },
    { label: "13点后", value: bands[2] },
  ];

  return `<aside class="ladder-side">
    <section class="side-section">
      <div class="side-head">
        <h3 class="side-title">主线</h3>
        <span class="side-kicker">按涨停家数</span>
        <span class="side-count">TOP ${sectors.length}</span>
      </div>
      <div class="sector-list">
        ${sectors
          .map(
            (s, i) => `<button class="sector-row" data-sector-code="${s.code}" title="查看「${esc(s.name)}」涨停股">
              <div class="sector-line">
                <span class="sector-rank">${String(i + 1).padStart(2, "0")}</span>
                <span class="sector-name">${esc(s.name)}</span>
                ${s.highDays ? `<span class="sector-high">${esc(s.highDays)}</span>` : ""}
                <span class="sector-num">${s.limitUpNum}</span>
              </div>
              <div class="sector-bar"><span style="width:${Math.round((s.limitUpNum / maxSector) * 100)}%"></span></div>
              <div class="sector-meta">
                <span>${s.continuousNum} 只连板</span>
                <span>·</span>
                <span class="text-${tone(s.change)}">板块 ${fmtPct(s.change)}</span>
              </div>
            </button>`,
          )
          .join("") || `<div class="archive-empty">暂无板块数据</div>`}
      </div>
    </section>

    <section class="side-section">
      <div class="side-head">
        <h3 class="side-title">封单</h3>
        <span class="side-kicker">收盘封单额</span>
        <span class="side-count">TOP 5</span>
      </div>
      <div class="seal-list">
        ${sealTop
          .map(
            (s, i) => `<button class="seal-row" data-stock-code="${s.code}" data-stock-name="${esc(s.name)}">
              <span class="seal-rank">${String(i + 1).padStart(2, "0")}</span>
              <span class="seal-name">${esc(s.name)}<em>${s.code}</em></span>
              <span class="seal-amount">${s.sealAmount > 0 ? fmtMoney(s.sealAmount) : "—"}</span>
              <span class="seal-sub"><span>${esc(tierName(s.streak))}</span><span class="text-${tone(s.changeRate)}">${fmtPct(s.changeRate)}</span><span>首封 ${fmtClock(s.firstSeal)}</span></span>
            </button>`,
          )
          .join("") || `<div class="archive-empty">暂无封单数据</div>`}
      </div>
    </section>

    <section class="side-section">
      <div class="side-head">
        <h3 class="side-title">封板时点</h3>
        <span class="side-kicker">首次封板</span>
      </div>
      <div class="time-dist">
        ${bandsMeta
          .map(
            (b) => `<div class="time-dist-row">
              <span class="time-dist-label">${b.label}</span>
              <span class="time-dist-bar"><span style="width:${Math.round((b.value / bandMax) * 100)}%"></span></span>
              <span class="time-dist-count">${b.value}</span>
            </div>`,
          )
          .join("")}
      </div>
    </section>

    <div class="side-foot">
      涨停数据 · 同花顺公开接口<br />
      行情数据 · 东方财富<br />
      ${day.stocks.length ? `本次同步 ${relTime(day.fetchedAt)}` : "等待数据"}<br />
      仅供研究复盘，不构成投资建议
    </div>
  </aside>`;
}

export function renderLadder(): string {
  const day = state.day;
  const loading = state.dayLoading && !day;
  const error = state.error && !day;

  let body = "";
  if (loading) {
    body = `<div class="section-head"><h2 class="section-title">连板天梯</h2><span class="section-sub">正在读取涨停池</span></div>${ladderSkeleton()}`;
  } else if (error) {
    body = errorState("数据没有到达", state.error || "请检查网络后重试");
  } else if (!day || !day.stocks.length) {
    body = `<div class="section-head"><h2 class="section-title">连板天梯</h2><span class="section-sub">${esc(day?.weekday || "")}</span></div>
      ${emptyState(isToday(state.date) && state.calendar && !state.calendar.isTradeDay ? "今日休市" : "这一天没有涨停", "换一个交易日看看，或重新拉取数据。", "retry-day", "重新拉取")}`;
  } else {
    const tiers = new Map<number, Stock[]>();
    for (const s of day.stocks) {
      const key = Math.max(1, s.streak);
      if (!tiers.has(key)) tiers.set(key, []);
      tiers.get(key)!.push(s);
    }
    const sorted = [...tiers.entries()].sort((a, b) => b[0] - a[0]);
    const max = sorted[0][0];
    const tierHtml = sorted
      .map(([streak, stocks], i) => {
        const isMax = streak === max;
        const compact = streak <= 1;
        const useHero = isMax && stocks.length === 1 && !compact;
        const ordered = [...stocks].sort((a, b) => {
          const av = a.firstSeal > 0 ? a.firstSeal : Number.MAX_SAFE_INTEGER;
          const bv = b.firstSeal > 0 ? b.firstSeal : Number.MAX_SAFE_INTEGER;
          if (av !== bv) return av - bv;
          return a.code.localeCompare(b.code);
        });
        return `<section class="ladder-tier ${isMax ? "max" : ""}" style="--tier:${i}">
          <div class="tier-gutter">
            ${
              compact
                ? `<div class="tier-number firstboard">首板</div>`
                : `<div class="tier-number ${streak >= 10 ? "double" : ""}">${streak}<span class="tier-unit">板</span></div>`
            }
            <div class="tier-label">${isMax ? "市场最高" : compact ? "今日首封" : "连续涨停"}</div>
            <span class="tier-count">${ordered.length}</span>
          </div>
          <div class="tier-cards">
            ${ordered.map((s, idx) => (useHero ? heroCard(s, sparkWindow(s, day.date, day.fetchedAt)) : stockCard(s, compact, idx, sparkWindow(s, day.date, day.fetchedAt)))).join("")}
          </div>
        </section>`;
      })
      .join("");

    body = `
      <div class="section-head">
        <h2 class="section-title">连板天梯</h2>
        <span class="section-sub">按连续涨停高度排列 · 连板 ${day.stats.consecutive} · 首板 ${day.stats.firstBoard} · 共 ${day.stocks.length} 只</span>
        <button class="section-note" data-action="refresh-day" title="重新拉取当日数据">${icon("refresh", 13)}${state.refreshing ? "同步中" : relTime(day.fetchedAt)}</button>
      </div>
      ${day.warning ? warningBanner(day.warning) : ""}
      <div class="ladder is-entering">${tierHtml}</div>`;
  }

  return `<section class="view view-ladder">
    ${renderViewHead()}
    <div class="ladder-layout">
      <div class="ladder-main">${body}</div>
      ${renderSide()}
    </div>
  </section>`;
}
