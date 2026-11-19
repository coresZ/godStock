import { esc, fmtClock, fmtPct, icon } from "../lib/ui";
import { breakInfo, downInfo, timestampToTimelineMinute, timelineMinuteLabel } from "../lib/market";
import { state } from "../lib/state";
import { renderViewHead } from "./common";

export function timelineExportText(): string {
  const day = state.day;
  if (!day) return "";
  const events = buildEvents();
  const supplements = buildSecondaryEvents(events);
  const all = [...events, ...supplements].sort((a, b) => a.minute - b.minute || a.code.localeCompare(b.code));
  const byMinute = clusters(all);
  const ordered = state.timelineOrder === "desc" ? [...byMinute].reverse() : byMinute;
  const dateText = `${day.date.slice(0, 4)}-${day.date.slice(4, 6)}-${day.date.slice(6, 8)}`;
  const lines: string[] = [
    "天梯 · A股涨停复盘 · 盘口时间轴",
    `交易日：${dateText} ${day.weekday}`,
    `涨停 ${day.stats.total} · 炸板 ${day.stats.openLimit} · 跌停 ${day.stats.limitDown}`,
    "说明：涨停为首封时间；炸板 / 跌停时间由分时采样推断，带 ≈ 标记。",
    "补充：空心点/「首封」「开板」为同一只票的辅助轨迹，不重复计入涨跌停数。",
    "",
  ];
  for (const group of ordered) {
    lines.push(`${timelineMinuteLabel(group.minute)}`);
    for (const e of group.items) {
      const extra = e.note ? `  ${e.note}` : "";
      const prefix = e.secondary ? "补充 " : "";
      lines.push(`  ${prefix}${e.label ?? KIND_LABEL[e.kind]}  ${e.name} ${e.code}  ${e.clock}${e.approx ? "≈" : ""}  ${fmtPct(e.pct)}${extra}`);
    }
    lines.push("");
  }
  lines.push("仅供学习复盘，不构成投资建议。");
  return lines.join("\r\n");
}

type EventKind = "up" | "break" | "down";

interface TimelineMark {
  minute: number;
  clock: string;
  approx: boolean;
}

interface TimelineEvent {
  code: string;
  name: string;
  kind: EventKind;
  minute: number;
  clock: string;
  approx: boolean;
  pct: number;
  /** 炸板票的首封，用空心点补在涨停泳道，不参与计数。 */
  lead?: TimelineMark;
  /** 收盘涨停票盘中的首次开板，用空心点补在炸板泳道，不参与计数。 */
  openBreak?: TimelineMark;
  note?: string;
  timeUnknown?: boolean;
  /** 同一只票的辅助轨迹（首封 / 开板），只进日志与空心点，不计入主事件数。 */
  secondary?: boolean;
  label?: string;
}

const KIND_LABEL: Record<EventKind, string> = {
  up: "涨停",
  break: "炸板",
  down: "跌停",
};

const TICKS = [
  { minute: 0, label: "09:15" },
  { minute: 15, label: "09:30" },
  { minute: 45, label: "10:00" },
  { minute: 75, label: "10:30" },
  { minute: 105, label: "11:00" },
  { minute: 135, label: "11:30/13:00" },
  { minute: 165, label: "13:30" },
  { minute: 195, label: "14:00" },
  { minute: 225, label: "14:30" },
  { minute: 255, label: "15:00" },
];

function buildEvents(): TimelineEvent[] {
  const day = state.day;
  if (!day) return [];
  const out: TimelineEvent[] = [];
  for (const s of day.stocks) {
    if (!s.firstSeal) continue;
    const event: TimelineEvent = {
      code: s.code,
      name: s.name,
      kind: "up",
      minute: timestampToTimelineMinute(s.firstSeal),
      clock: fmtClock(s.firstSeal),
      approx: false,
      pct: s.changeRate,
    };
    if (s.openNum > 0) {
      const info = breakInfo(s);
      if (info) {
        event.openBreak = { minute: info.minute, clock: info.clock, approx: info.approx };
        event.note = `开板${s.openNum}次 · 首开≈${info.clock}`;
      } else {
        event.note = `开板${s.openNum}次 · 时间未知`;
      }
    }
    out.push(event);
  }
  for (const s of day.openLimit) {
    const info = breakInfo(s);
    const fallbackMinute = s.lastSeal ? timestampToTimelineMinute(s.lastSeal) : null;
    if (!info && fallbackMinute == null) continue;
    const minute = info ? info.minute : fallbackMinute!;
    const clock = info ? info.clock : fmtClock(s.lastSeal);
    const event: TimelineEvent = {
      code: s.code,
      name: s.name,
      kind: "break",
      minute,
      clock,
      approx: true,
      pct: s.changeRate,
    };
    if (s.firstSeal) {
      const leadMinute = timestampToTimelineMinute(s.firstSeal);
      event.lead = { minute: leadMinute, clock: fmtClock(s.firstSeal), approx: false };
      event.note = `首封 ${fmtClock(s.firstSeal)}`;
    }
    if (!info) {
      event.timeUnknown = true;
      event.note = [event.note, `炸板时间未知 · 末封 ${clock}`].filter(Boolean).join(" · ");
    }
    out.push(event);
  }
  for (const s of day.limitDown) {
    const info = downInfo(s);
    if (info) {
      out.push({ code: s.code, name: s.name, kind: "down", minute: info.minute, clock: info.clock, approx: info.approx, pct: s.changeRate });
    } else {
      out.push({ code: s.code, name: s.name, kind: "down", minute: 15, clock: "09:30", approx: true, pct: s.changeRate });
    }
  }
  return out.sort((a, b) => a.minute - b.minute || a.code.localeCompare(b.code));
}

function buildSecondaryEvents(events: TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const event of events) {
    if (event.kind === "break" && event.lead) {
      out.push({
        code: event.code,
        name: event.name,
        kind: "up",
        minute: event.lead.minute,
        clock: event.lead.clock,
        approx: false,
        pct: event.pct,
        secondary: true,
        label: "首封",
        note: `后炸板${event.approx ? "≈" : ""}${event.clock}`,
      });
    }
    if (event.kind === "up" && event.openBreak) {
      out.push({
        code: event.code,
        name: event.name,
        kind: "break",
        minute: event.openBreak.minute,
        clock: event.openBreak.clock,
        approx: event.openBreak.approx,
        pct: event.pct,
        secondary: true,
        label: "开板",
        note: `首开≈${event.openBreak.clock}`,
      });
    }
  }
  return out;
}

function clusters(events: TimelineEvent[]): Array<{ minute: number; items: TimelineEvent[] }> {
  const map = new Map<number, TimelineEvent[]>();
  for (const e of events) {
    if (!map.has(e.minute)) map.set(e.minute, []);
    map.get(e.minute)!.push(e);
  }
  return [...map.entries()].map(([minute, items]) => ({ minute, items }));
}

function lane(kind: EventKind, events: TimelineEvent[]): string {
  const primary = events.filter((e) => e.kind === kind);
  const rows = clusters(primary);
  const extras: Array<TimelineMark & { code: string; name: string; hint: string; targetMinute: number }> =
    kind === "up"
      ? events
          .filter((e) => e.kind === "break" && e.lead)
          .map((e) => ({ ...e.lead!, code: e.code, name: e.name, hint: `首封 ${e.lead!.clock} · 后炸板`, targetMinute: e.minute }))
      : kind === "break"
        ? events
            .filter((e) => e.kind === "up" && e.openBreak)
            .map((e) => ({ ...e.openBreak!, code: e.code, name: e.name, hint: e.note ?? "盘中开板", targetMinute: e.minute }))
        : [];
  return `<div class="tl-lane">
    <div class="tl-lane-label ${kind}"><i></i>${KIND_LABEL[kind]}<span>${primary.length}</span></div>
    <div class="tl-track">
      ${rows
        .map((row) => {
          const pct = (row.minute / 255) * 100;
          const names = row.items.map((e) => `${e.clock} ${e.name}${e.note ? ` · ${e.note}` : ""}`).join("\n");
          const unknown = row.items.every((e) => e.timeUnknown);
          return `<button class="tl-mark ${kind}${unknown ? " is-unknown" : ""}" style="left:${pct.toFixed(3)}%" data-timeline-minute="${row.minute}" title="${esc(names)}" aria-label="${KIND_LABEL[kind]} ${row.items.length} 只">
            ${row.items.length > 1 ? `<b>${row.items.length}</b>` : ""}
          </button>`;
        })
        .join("")}
      ${extras
        .map(
          (mark) => `<button class="tl-mark is-secondary ${kind}" style="left:${((mark.minute / 255) * 100).toFixed(3)}%" data-timeline-minute="${mark.targetMinute}" title="${esc(`${mark.clock} ${mark.name} · ${mark.hint}`)}" aria-label="${esc(`${mark.clock} ${mark.name} · ${mark.hint}`)}"></button>`,
        )
        .join("")}
    </div>
  </div>`;
}

export function renderTimeline(): string {
  const day = state.day;
  const events = buildEvents();
  const supplements = buildSecondaryEvents(events);
  const all = [...events, ...supplements].sort((a, b) => a.minute - b.minute || a.code.localeCompare(b.code));
  const up = events.filter((e) => e.kind === "up");
  const brk = events.filter((e) => e.kind === "break");
  const down = events.filter((e) => e.kind === "down");
  const groups = clusters(all);
  const orderedGroups = state.timelineOrder === "desc" ? [...groups].reverse() : groups;

  const body = !day
    ? `<div class="empty-state"><div class="empty-mark">${icon("activity", 22)}</div><div class="empty-title">正在读取盘口</div><div class="empty-desc">时间轴需要涨停、炸板与跌停池。</div></div>`
    : !events.length
      ? `<div class="empty-state"><div class="empty-mark">${icon("activity", 22)}</div><div class="empty-title">这一天没有盘口事件</div><div class="empty-desc">换一个交易日，或重新拉取。</div></div>`
      : `<div class="timeline-stage">
          <div class="timeline-top">
            <div class="timeline-summary">
              <div><b class="up">${up.length}</b><span>涨停</span></div>
              <div><b class="break">${brk.length}</b><span>炸板</span></div>
              <div><b class="down">${down.length}</b><span>跌停</span></div>
            </div>
            <div class="timeline-hint">从集合竞价开始；空心点为首封 / 开板补充，不重复计数</div>
          </div>
          <div class="timeline-axis">
            <div class="tl-lane-label axis">时间</div>
            <div class="tl-axis-track">
              ${TICKS.map((t) => `<span class="tl-tick" style="left:${((t.minute / 255) * 100).toFixed(3)}%">${t.label}</span>`).join("")}
              <span class="tl-auction" title="集合竞价">竞价</span>
            </div>
          </div>
          ${lane("up", events)}
          ${lane("break", events)}
          ${lane("down", events)}
        </div>
        <div class="timeline-log">
          <div class="timeline-log-head">
            <h3>逐分钟事件</h3>
            <span>${events.length} 个主事件${supplements.length ? ` · ${supplements.length} 条补充` : ""} · ${groups.length} 个时间点</span>
            <div class="seg tl-log-order" role="group" aria-label="事件排序">
              <button class="${state.timelineOrder === "asc" ? "active" : ""}" data-timeline-order="asc">正序</button>
              <button class="${state.timelineOrder === "desc" ? "active" : ""}" data-timeline-order="desc">倒序</button>
            </div>
            <span class="log-note">炸板 / 跌停时间为分时采样推断</span>
          </div>
          <div class="tl-log-scroll">
            ${orderedGroups
              .map(
                (g) => `<div class="tl-log-group" data-minute="${g.minute}">
                  <time>${timelineMinuteLabel(g.minute)}</time>
                  <span class="tl-log-line"></span>
                  <div class="tl-log-items">${g.items
                    .map(
                      (e) => `<button class="tl-stock ${e.kind}${e.secondary ? " is-secondary" : ""}" data-stock-code="${e.code}" data-stock-name="${esc(e.name)}" title="${esc(`${e.name} ${e.code} · ${e.label ?? KIND_LABEL[e.kind]}${e.approx ? " (推断)" : ""}${e.note ? ` · ${e.note}` : ""}`)}">
                        <span class="tl-dot"></span>${esc(e.name)}<em>${e.label ?? KIND_LABEL[e.kind]}${e.timeUnknown ? "?" : e.approx ? "≈" : ""}</em>${e.note ? `<span class="tl-stock-note">${esc(e.note)}</span>` : ""}
                      </button>`,
                    )
                    .join("")}</div>
                </div>`,
              )
              .join("")}
          </div>
        </div>`;

  return `<section class="view view-timeline">
    ${renderViewHead()}
    <div class="timeline-main">
      <div class="section-head">
        <h2 class="section-title">盘口时间轴</h2>
        <span class="section-sub">集合竞价 → 收盘 · 涨停 / 炸板 / 跌停</span>
        <span class="section-note">${events.length ? `${events.length} 个落点` : ""}</span>
        <button class="timeline-export" data-action="export-timeline" ${day ? "" : "disabled"}>${icon("download", 13)} 导出 TXT</button>
      </div>
      ${body}
    </div>
  </section>`;
}
