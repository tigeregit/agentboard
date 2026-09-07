import type { ProjectStat, SessionSummary, ToolId, ToolStat } from "./types";
import { TOOL_META } from "./registry";
import { addDays, formatDuration, startOfLocalDay, startOfLocalWeek } from "./util/time";

/**
 * Period summaries for daily / weekly reports. Pure functions over index
 * results so the CLI, the API and an agent can all render the same data.
 */
export type Period = "day" | "week" | "month";

export interface PeriodRange {
  period: Period;
  since: string;
  until: string;
  label: string;
}

export function periodRange(period: Period, anchor: Date = new Date()): PeriodRange {
  let start: Date;
  let end: Date;
  if (period === "day") {
    start = startOfLocalDay(anchor);
    end = addDays(start, 1);
  } else if (period === "week") {
    start = startOfLocalWeek(anchor);
    end = addDays(start, 7);
  } else {
    start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  }
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const label = period === "day" ? fmt(start) : `${fmt(start)} → ${fmt(addDays(end, -1))}`;
  return { period, since: start.toISOString(), until: end.toISOString(), label };
}

export interface PeriodSummary {
  range: PeriodRange;
  totals: { sessions: number; messages: number; userMessages: number; toolCalls: number; projects: number; tools: number };
  byTool: ToolStat[];
  byProject: ProjectStat[];
  sessions: SessionSummary[];
}

export function summarize(range: PeriodRange, sessions: SessionSummary[], byTool: ToolStat[], byProject: ProjectStat[]): PeriodSummary {
  return {
    range,
    totals: {
      sessions: sessions.length,
      messages: sessions.reduce((n, s) => n + s.messageCount, 0),
      userMessages: sessions.reduce((n, s) => n + s.userMessageCount, 0),
      toolCalls: sessions.reduce((n, s) => n + s.toolCallCount, 0),
      projects: byProject.length,
      tools: byTool.length,
    },
    byTool,
    byProject,
    sessions,
  };
}

/** Markdown rendering meant to be pasted into a daily/weekly report or fed to an LLM. */
export function summaryToMarkdown(s: PeriodSummary, opts: { maxSessions?: number; includePrompts?: boolean } = {}): string {
  const lines: string[] = [];
  const title = s.range.period === "day" ? "Daily" : s.range.period === "week" ? "Weekly" : "Monthly";
  lines.push(`# ${title} agent activity — ${s.range.label}`, "");
  lines.push(`- Sessions: **${s.totals.sessions}** across **${s.totals.tools}** tools and **${s.totals.projects}** projects`);
  lines.push(`- Messages: ${s.totals.messages} (${s.totals.userMessages} prompts, ${s.totals.toolCalls} tool calls)`, "");
  if (s.byTool.length) {
    lines.push("## By tool", "");
    for (const t of s.byTool) lines.push(`- ${TOOL_META[t.tool]?.name ?? t.tool}: ${t.sessionCount} sessions, ${t.messageCount} messages`);
    lines.push("");
  }
  if (s.byProject.length) {
    lines.push("## By project", "");
    for (const p of s.byProject) lines.push(`- \`${p.name}\` (${p.path}): ${p.sessionCount} sessions · ${p.tools.map((t: ToolId) => TOOL_META[t]?.short ?? t).join(", ")}`);
    lines.push("");
  }
  const max = opts.maxSessions ?? 200;
  const grouped = new Map<string, SessionSummary[]>();
  for (const sess of s.sessions.slice(0, max)) {
    const list = grouped.get(sess.project.path) ?? [];
    list.push(sess);
    grouped.set(sess.project.path, list);
  }
  if (grouped.size) {
    lines.push("## Sessions", "");
    for (const [project, list] of grouped) {
      lines.push(`### ${list[0].project.name}  <sub>${project}</sub>`, "");
      for (const sess of list) {
        const when = sess.startedAt.slice(0, 16).replace("T", " ");
        const dur = formatDuration(sess.startedAt, sess.endedAt);
        lines.push(`- **${sess.title}** — ${TOOL_META[sess.tool]?.short ?? sess.tool} · ${when}${dur ? ` · ${dur}` : ""} · ${sess.userMessageCount} prompts / ${sess.toolCallCount} tool calls · \`${sess.key}\``);
        if (opts.includePrompts && sess.firstPrompt && sess.firstPrompt !== sess.title) lines.push(`  > ${sess.firstPrompt.slice(0, 200)}`);
      }
      lines.push("");
    }
  }
  if (s.sessions.length > max) lines.push(`_…and ${s.sessions.length - max} more sessions._`);
  return lines.join("\n");
}
