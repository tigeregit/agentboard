import type { SessionSummary } from "../engine/types";
import { TOOL_META } from "../engine/registry";
import { formatDuration } from "../engine/util/time";

export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  if (!all.length) return "";
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  const out = all.map(line);
  if (header) out.splice(1, 0, widths.map((w) => "─".repeat(w)).join("  "));
  return out.join("\n");
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

export function sessionRows(items: SessionSummary[]): string[][] {
  return items.map((s) => [
    fmtTime(s.startedAt),
    TOOL_META[s.tool]?.short ?? s.tool,
    truncate(s.project.name, 22),
    truncate(s.title, 60),
    `${s.userMessageCount}p/${s.toolCallCount}t`,
    formatDuration(s.startedAt, s.endedAt) || "-",
    s.key,
  ]);
}

export const SESSION_HEADER = ["started", "tool", "project", "title", "turns/calls", "dur", "key"];
