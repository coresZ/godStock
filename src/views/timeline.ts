import { esc, fmtClock, fmtPct, icon } from "../lib/ui";
import { breakInfo, downInfo, timestampToTimelineMinute, timelineMinuteLabel } from "../lib/market";
import { state } from "../lib/state";
import { renderViewHead } from "./common";

export function timelineExportText(): string {
  const day = state.day;
  if (!day) return "";
  const events = buildEvents();
  const byMinute = clusters(events);
  const dateText = `${day.date.slice(0, 4)}-${day.date.slice(4, 6)}-${day.date.slice(6, 8)}`;
  const lines: string[] = [
    "天梯 · A股涨停复盘 · 盘口时间轴",
    `交易日：${dateText} ${day.weekday}`,
    `涨停 ${day.stats.total} · 炸板 ${day.stats.openLimit} · 跌停 ${day.stats.limitDown}`,
    "说明：涨停为首封时间；炸板 / 跌停时间由分时采样推断，带 ≈ 标记。",
    "",
  ];
  for (const group of byMinute) {
    lines.push(`${timelineMinuteLabel(group.minute)}`);
    for (const e of group.items) {
      lines.push(`  ${KIND_LABEL[e.kind]}  ${e.name} ${e.code}  ${e.clock}${e.approx ? "≈" : ""}  ${fmtPct(e.pct)}`);
    }
    lines.push("");
  }
  lines.push("仅供学习复盘，不构成投资建议。");
  return lines.join("\r\n");
}

type EventKind = "up" | "break" | "down";

interface TimelineEvent {
  code: string;
  name: string;
  kind: EventKind;
  minute: number;
  clock: string;
  approx: boolean;
  pct: number;
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
    out.push({
      code: s.code,
      name: s.name,
      kind: "up",
      minute: timestampToTimelineMinute(s.firstSeal),
      clock: fmtClock(s.firstSeal),
      approx: false,
      pct: s.changeRate,
    });
  }
  for (const s of day.openLimit) {
    const info = breakInfo(s);
    if (info) {
      out.push({ code: s.code, name: s.name, kind: "break", minute: info.minute, clock: info.clock, approx: info.approx, pct: s.changeRate });
    } else if (s.lastSeal) {
      out.push({ code: s.code, name: s.name, kind: "break", minute: timestampToTimelineMinute(s.lastSeal), clock: fmtClock(s.lastSeal), approx: true, pct: s.changeRate });
    }
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

function clusters(events: TimelineEvent[]): Array<{ minute: number; items: TimelineEvent[] }> {
  const map = new Map<number, TimelineEvent[]>();
  for (const e of events) {
    if (!map.has(e.minute)) map.set(e.minute, []);
    map.get(e.minute)!.push(e);
  }
  return [...map.entries()].map(([minute, items]) => ({ minute, items }));
}

function lane(kind: EventKind, events: TimelineEvent[]): string {
  const rows = clusters(events.filter((e) => e.kind === kind));
  return `<div class="tl-lane">
    <div class="tl-lane-label ${kind}"><i></i>${KIND_LABEL[kind]}<span>${events.filter((e) => e.kind === kind).length}</span></div>
    <div class="tl-track">
      ${rows
        .map((row) => {
          const pct = (row.minute / 255) * 100;
          const names = row.items.map((e) => `${e.clock} ${e.name}`).join("\n");
          return `<button class="tl-mark ${kind}" style="left:${pct.toFixed(3)}%" data-timeline-minute="${row.minute}" title="${esc(names)}" aria-label="${KIND_LABEL[kind]} ${row.items.length} 只">
            ${row.items.length > 1 ? `<b>${row.items.length}</b>` : ""}
          </button>`;
        })
        .join("")}
    </div>
  </div>`;
}

export function renderTimeline(): string {
  const day = state.day;
  const events = buildEvents();
  const up = events.filter((e) => e.kind === "up");
  const brk = events.filter((e) => e.kind === "break");
  const down = events.filter((e) => e.kind === "down");
  const groups = clusters(events);

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
            <div class="timeline-hint">从集合竞价开始，按首次封板 / 推断炸板 / 推断跌停落点</div>
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
          <div class="timeline-log-head"><h3>逐分钟事件</h3><span>${events.length} 个落点 · ${groups.length} 个时间点</span><span class="log-note">炸板 / 跌停时间为分时采样推断</span></div>
          <div class="tl-log-scroll">
            ${groups
              .map(
                (g) => `<div class="tl-log-group" data-minute="${g.minute}">
                  <time>${timelineMinuteLabel(g.minute)}</time>
                  <span class="tl-log-line"></span>
                  <div class="tl-log-items">${g.items
                    .map(
                      (e) => `<button class="tl-stock ${e.kind}" data-stock-code="${e.code}" data-stock-name="${esc(e.name)}" title="${esc(e.name)} ${e.code} · ${KIND_LABEL[e.kind]}${e.approx ? " (推断)" : ""}">
                        <span class="tl-dot"></span>${esc(e.name)}<em>${KIND_LABEL[e.kind]}${e.approx ? "≈" : ""}</em>
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
