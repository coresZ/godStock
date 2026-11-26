import {
  esc,
  fmtPct,
  fmtShortDate,
  icon,
  relTime,
  sparkline,
  weekdayFromYmd,
} from "../lib/ui";
import { isToday, neighbors, state } from "../lib/state";

export function renderTitlebar(): string {
  return `
  <header class="titlebar">
    <div class="titlebar-drag"></div>
    <div class="titlebar-brand">
      <img class="brand-mark" src="./mark.svg" alt="" />
      <span class="brand-word">天梯</span>
      <span class="brand-caption">A股涨停复盘</span>
    </div>
    <button class="titlebar-search" data-action="search" aria-label="搜索股票">
      ${icon("search", 14)}
      <span>搜索股票 / 代码</span>
      <kbd>Ctrl K</kbd>
    </button>
    <div class="titlebar-spacer"></div>
    <span class="sync-state" id="sync-state"><i class="sync-dot"></i><span id="sync-text">准备数据</span></span>
    <div class="window-controls">
      <button class="window-btn" data-win="minimize" aria-label="最小化">${icon("minimize", 13)}</button>
      <button class="window-btn" data-win="maximize" aria-label="最大化">${icon("maximize", 12)}</button>
      <button class="window-btn close" data-win="close" aria-label="关闭">${icon("close", 13)}</button>
    </div>
  </header>`;
}

export function renderRail(): string {
  const items: Array<{ view: string; label: string; iconName: string; title: string }> = [
    { view: "ladder", label: "天梯", iconName: "ladder", title: "连板天梯" },
    { view: "pool", label: "涨停池", iconName: "list", title: "涨停 / 炸板 / 跌停" },
    { view: "timeline", label: "时间轴", iconName: "activity", title: "涨跌停时间轴" },
    { view: "chart", label: "K线", iconName: "chart", title: "个股K线" },
    { view: "strategy", label: "策略", iconName: "layers", title: "策略复盘" },
    { view: "other", label: "其他", iconName: "grid", title: "其他 · 游资动态" },
  ];
  return `
  <aside class="rail">
    <nav class="rail-nav" aria-label="主导航">
      ${items
        .map(
          (it) => `<button class="rail-item ${state.view === it.view ? "active" : ""}" data-nav="${it.view}" title="${it.title}" aria-label="${it.title}">
            ${icon(it.iconName, 21)}<span>${it.label}</span>
          </button>`,
        )
        .join("")}
    </nav>
    <div class="rail-foot">
      <button class="rail-tool" data-action="theme" title="${state.theme === "dark" ? "切换为浅色" : "切换为深色"}" aria-label="切换主题">
        ${icon(state.theme === "dark" ? "sun" : "moon", 18)}
      </button>
      <button class="rail-tool" data-action="settings" title="设置" aria-label="设置">${icon("settings", 18)}</button>
      <span class="rail-version">v1.6.0</span>
    </div>
  </aside>`;
}

export function renderViewHead(): string {
  if (!state.date) return renderHeadSkeleton();
  const day = state.day;
  const stats = day?.stats;
  const { prev, next } = neighbors();
  const weekday = day?.weekday || weekdayFromYmd(state.date);
  const closed = isToday(state.date) && state.calendar && !state.calendar.isTradeDay;
  const month = state.date.slice(4, 6);
  const date = state.date.slice(6, 8);
  const year = state.date.slice(0, 4);

  const metric = (label: string, value: string, unit: string, cls = "", title = "") => `
    <div class="metric ${cls}" ${title ? `title="${esc(title)}"` : ""}>
      <span class="metric-label">${label}</span>
      <span class="metric-value">${value}${unit ? `<span class="unit">${unit}</span>` : ""}</span>
    </div>`;

  const metricsHtml = stats
    ? [
        metric("涨停", String(stats.total), "只", "", "当日涨停家数"),
        metric("炸板", String(stats.openLimit), "只", "break", "盘中触及涨停后打开"),
        metric("跌停", String(stats.limitDown), "只", "fall", "当日跌停家数"),
        metric("最高", String(stats.maxStreak), "板", "highlight", "连续涨停高度"),
      ].join("")
    : ["涨停", "炸板", "跌停", "最高"]
        .map(
          (label, i) =>
            `<div class="metric ${i === 3 ? "highlight" : ""}"><span class="metric-label">${label}</span><span class="sk sk-metric"></span></div>`,
        )
        .join("");

  const indicesHtml = renderIndices();

  return `
  <header class="view-head">
    <div class="date-cluster">
      <button class="date-trigger" data-action="date-menu" aria-label="选择交易日" aria-haspopup="dialog">
        <span class="date-number">${month}<span class="date-dot">.</span>${date}</span>
        <span class="date-side">
          <span class="date-year">${year}</span>
          <span class="date-week">${weekday}${closed ? `<span class="closed-mark">休市</span>` : ""}${icon("chevronDown", 13, "date-chevron")}</span>
        </span>
      </button>
      <div class="date-nav">
        <button data-action="date-prev" ${prev ? `title="上一交易日 ${fmtShortDate(prev)}"` : "disabled"} aria-label="上一交易日">${icon("chevronLeft", 14)}</button>
        <button data-action="date-next" ${next ? `title="下一交易日 ${fmtShortDate(next)}"` : "disabled"} aria-label="下一交易日">${icon("chevronRight", 14)}</button>
      </div>
    </div>
    <div class="metrics">${metricsHtml}</div>
    <div class="header-right">
      <div class="indices">${indicesHtml}</div>
    </div>
  </header>`;
}

function shortIndexName(name: string): string {
  if (name.includes("上证")) return "上证";
  if (name.includes("深证")) return "深证";
  if (name.includes("创业")) return "创业板";
  return name.replace("指数", "");
}

export function renderIndices(): string {
  return state.indices.length
    ? state.indices
        .slice(0, 3)
        .map(
          (q) => `<button class="index ${q.stale ? "is-stale" : ""}" data-index-secid="${esc(q.code)}" data-index-name="${esc(q.name)}" title="查看 ${esc(q.name)} K线 · ${q.stale ? "缓存" : "实时"} ${esc(q.asOf || "")}">
            <div class="index-copy">
              <span class="index-name">${esc(shortIndexName(q.name))}</span>
              <span class="index-value">${q.price.toFixed(2)}<span class="index-pct ${q.pct > 0 ? "text-up" : q.pct < 0 ? "text-down" : "text-flat"}">${fmtPct(q.pct)}</span></span>
            </div>
            ${sparkline(q.spark, 44, 20, "index-spark", q.pct)}
          </button>`,
        )
        .join("")
    : `<div class="index"><div class="index-copy"><span class="index-name">上证</span><span class="sk sk-index"></span></div></div>
       <div class="index"><div class="index-copy"><span class="index-name">深证</span><span class="sk sk-index"></span></div></div>
       <div class="index"><div class="index-copy"><span class="index-name">创业板</span><span class="sk sk-index"></span></div></div>`;
}

function renderHeadSkeleton(): string {
  return `
  <header class="view-head">
    <div class="date-cluster">
      <div><span class="sk sk-date"></span></div>
    </div>
    <div class="metrics">
      ${["涨停", "炸板", "跌停", "最高"].map((l, i) => `<div class="metric ${i === 3 ? "highlight" : ""}"><span class="metric-label">${l}</span><span class="sk sk-metric"></span></div>`).join("")}
    </div>
    <div class="header-right"><div class="indices"><span class="sk sk-index"></span><span class="sk sk-index"></span><span class="sk sk-index"></span></div></div>
  </header>`;
}

export function emptyState(title: string, desc: string, action = "", label = ""): string {
  return `<div class="empty-state">
    <div class="empty-mark">${icon("ladder", 22)}</div>
    <div class="empty-title">${esc(title)}</div>
    <div class="empty-desc">${esc(desc)}</div>
    ${action ? `<button class="empty-action" data-action="${action}">${esc(label)}</button>` : ""}
  </div>`;
}

export function errorState(title: string, desc: string): string {
  return `<div class="empty-state">
    <div class="empty-mark">${icon("activity", 22)}</div>
    <div class="empty-title">${esc(title)}</div>
    <div class="empty-desc">${esc(desc)}</div>
    <button class="empty-action" data-action="retry-day">重新加载</button>
  </div>`;
}

export function warningBanner(text: string): string {
  return `<div class="banner">${icon("info", 13)}<span>${esc(text)}</span><button class="banner-action" data-action="retry-day">重试</button></div>`;
}

export function syncLabel(): string {
  if (state.sync === "loading") return "正在同步行情";
  if (state.sync === "error") return "同步失败 · 本地缓存";
  if (state.sync === "cache") return `本地缓存 · ${relTime(state.day?.fetchedAt ?? 0)}`;
  if (state.sync === "live") return `已同步 · ${relTime(state.day?.fetchedAt ?? 0)}`;
  return "准备数据";
}
