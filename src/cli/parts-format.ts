import type { SessionSummary, ToolId } from "../engine/types";
import type { FileStat, Part, PartHit, SessionOutline, ToolCategory, Turn } from "../engine/parts/types";
import { renderArgs } from "../engine/parts/classify";
import { TOOL_META } from "../engine/registry";
import { formatDuration } from "../engine/util/time";
import { fmtTime, table, truncate } from "./format";

const CAT_SHORT: Record<ToolCategory, string> = { shell: "sh", read: "rd", edit: "ed", search: "se", web: "web", subagent: "sub", plan: "plan", ask: "ask", browser: "br", mcp: "mcp", other: "?" };

export function fmtClock(iso: string | undefined, dayRef?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameDay = dayRef && new Date(dayRef).toDateString() === d.toDateString();
  return `${sameDay ? "" : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} `}${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function categories(by: Partial<Record<ToolCategory, number>>): string {
  return Object.entries(by)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([c, n]) => `${c} ${n}`)
    .join(", ");
}

/** Header block shared by every `show` mode. */
export function sessionHeader(s: SessionSummary, o?: SessionOutline, fidelity?: string): string[] {
  const lines = [`# ${s.title}`, ""];
  lines.push(`- Tool: ${TOOL_META[s.tool]?.name ?? s.tool} (${s.surface}) · Project: ${s.project.path}`);
  lines.push(`- Time: ${fmtTime(s.startedAt)} → ${fmtTime(s.endedAt)} (${formatDuration(s.startedAt, s.endedAt) || "<1m"})${s.model ? ` · Model: ${s.model}` : ""}${s.gitBranch ? ` · Branch: ${s.gitBranch}` : ""}`);
  lines.push(`- Key: \`${s.key}\` · Source: ${s.source.kind} ${s.source.path}${s.source.locator ? ` (${s.source.locator})` : ""}`);
  if (o) {
    const calls = Object.values(o.byCategory).reduce((a, b) => a + (b ?? 0), 0);
    lines.push(`- Parts: ${o.partCount}${fidelity ? ` (${fidelity})` : ""} · Turns: ${o.turns.filter((t) => t.turn > 0).length} · Tool calls: ${calls}${calls ? ` (${categories(o.byCategory)})` : ""} · Errors: ${o.errors} · Files: ${o.files.length}${o.byKind.reasoning ? ` · Reasoning parts: ${o.byKind.reasoning}` : ""}${o.contextParts ? ` · Injected context: ${o.contextParts}` : ""}${o.compactions ? ` · Compactions: ${o.compactions}` : ""}`);
  }
  return lines;
}

/** Default `show`: per-turn outline. */
export function outlineToText(s: SessionSummary, o: SessionOutline, opts: { fidelity?: string; promptChars?: number; replyChars?: number; maxFiles?: number } = {}): string {
  const pc = opts.promptChars ?? 90;
  const rc = opts.replyChars ?? 90;
  const lines = sessionHeader(s, o, opts.fidelity);
  lines.push("", "## Turns", "");
  const rows = o.turns.map((t) => [
    String(t.turn),
    fmtClock(t.startedAt, s.startedAt),
    t.startedAt && t.endedAt ? formatDuration(t.startedAt, t.endedAt) || "<1m" : "",
    `${t.startSeq}-${t.endSeq}`,
    t.toolCalls ? `${t.toolCalls} (${Object.entries(t.byCategory).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(([c, n]) => `${CAT_SHORT[c as ToolCategory]}${n}`).join(" ")})` : "-",
    t.errors ? String(t.errors) : "",
    t.turn === 0 ? "(before first prompt)" : truncate(t.prompt, pc),
    truncate(t.reply, rc),
  ]);
  lines.push(table(rows, ["turn", "at", "dur", "seq", "calls", "err", "prompt", "→ last reply"]));
  if (o.files.length) {
    lines.push("", `## Files (${o.files.length})`, "");
    const max = opts.maxFiles ?? 15;
    lines.push(table(o.files.slice(0, max).map((f) => [f.edits ? String(f.edits) : "", f.reads ? String(f.reads) : "", f.path]), ["edits", "reads", "path"]));
    if (o.files.length > max) lines.push(`… ${o.files.length - max} more (show --files)`);
  }
  const tools = Object.entries(o.toolNames).sort((a, b) => b[1] - a[1]);
  if (tools.length) lines.push("", `Tools: ${tools.map(([n, c]) => `${n} ×${c}`).join(", ")}`);
  lines.push("", `Next: \`show ${s.key} --turn N\` · \`--seq a:b\` · \`--parts [--kind reply,prompt] [--category shell] [--grep text] [--errors]\` · \`--json\``);
  return lines.join("\n");
}

export function turnsRows(turns: Turn[]): string[][] {
  return turns.map((t) => [String(t.turn), `${t.startSeq}-${t.endSeq}`, String(t.partCount), String(t.toolCalls), truncate(t.prompt, 80)]);
}

/** `show --parts`: one row per part. */
export function partsTable(parts: Part[], dayRef?: string): string {
  const rows = parts.map((p) => [
    String(p.seq),
    String(p.turn),
    p.kind + (p.form ? `/${p.form}` : ""),
    p.tool ? `${p.tool.category}` : "",
    p.tool?.name ?? "",
    fmtClock(p.timestamp, dayRef),
    fmtBytes(p.bytes ?? p.text.length) + (p.result?.isError ? " ERR" : "") + (p.result?.exitCode !== undefined && p.result.exitCode !== 0 ? ` exit ${p.result.exitCode}` : ""),
    truncate(partPreview(p), 100),
  ]);
  return table(rows, ["seq", "turn", "kind", "cat", "tool", "at", "size", "preview"]);
}

export function partPreview(p: Part): string {
  if (p.kind === "tool_call" || p.kind === "plan" || p.kind === "subagent") {
    if (p.tool?.command) return `$ ${p.tool.command}`;
    if (p.tool) return renderArgs(p.tool.name, p.tool.args ?? p.text, 200);
  }
  if (p.kind === "context") return `[${p.form ?? "context"}] ${p.text}`;
  return p.text;
}

export interface DumpOptions {
  /** Cap per part text. */
  maxChars: number;
  /** Total output cap; the dump stops when exceeded and prints how to continue. */
  budget: number;
  key: string;
  dayRef?: string;
}

/** Full rendering of a list of parts, budget-aware. */
export function dumpParts(parts: Part[], opts: DumpOptions): string {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const block = renderPart(p, opts);
    if (used + block.length > opts.budget && i > 0) {
      const remain = parts.length - i;
      out.push(`… budget of ${fmtBytes(opts.budget)} reached before seq ${p.seq}; ${remain} part(s) remain. Continue: \`show ${opts.key} --seq ${p.seq}:${parts[parts.length - 1].seq}\` (raise --budget / lower --max-chars to fit more)`);
      break;
    }
    out.push(block);
    used += block.length;
  }
  return out.join("\n");
}

export function renderPart(p: Part, opts: { maxChars: number; dayRef?: string }): string {
  const at = fmtClock(p.timestamp, opts.dayRef);
  const head: string[] = [`### [${p.seq}] t${p.turn} ${p.kind}`];
  if (p.form) head.push(`(${p.form})`);
  if (p.tool) head.push(`${p.tool.category} \`${p.tool.name}\``);
  if (p.result) {
    const bits = [];
    if (p.result.isError) bits.push("ERROR");
    if (p.result.exitCode !== undefined) bits.push(`exit ${p.result.exitCode}`);
    bits.push(fmtBytes(p.bytes ?? p.text.length));
    head.push(`(${bits.join(", ")})`);
  }
  if (p.child) head.push(`→ ${p.child}`);
  if (p.model) head.push(`· ${p.model}`);
  if (at) head.push(`· ${at}`);
  const lines = [head.join(" ")];
  if (p.files?.length && p.kind !== "tool_result") lines.push(`files: ${p.files.join(", ")}`);
  let body = p.text;
  if (p.kind === "tool_call" || p.kind === "plan" || p.kind === "subagent") {
    if (p.tool?.command) body = `$ ${p.tool.command}`;
  }
  const max = opts.maxChars;
  if (body.length > max) body = body.slice(0, max) + `\n…(${body.length - max} more chars; \`--seq ${p.seq} --max-chars ${body.length + 1}\` for all)`;
  if (body.trim()) {
    if (p.kind === "tool_result" || p.kind === "tool_call") lines.push("```", body, "```");
    else if (p.kind === "reasoning" || p.kind === "context") lines.push(body.split("\n").map((l) => `> ${l}`).join("\n"));
    else lines.push(body);
  }
  lines.push("");
  return lines.join("\n");
}

export function hitsTable(hits: PartHit[], width: number): string {
  const rows = hits.map((h) => [
    h.sessionKey.length > 44 ? h.sessionKey.slice(0, 43) + "…" : h.sessionKey,
    `${h.turn}/${h.seq}`,
    h.kind + (h.category ? `/${h.category}` : "") + (h.isError ? " ERR" : ""),
    fmtTime(h.timestamp ?? ""),
    truncate(h.snippet, width),
  ]);
  return table(rows, ["session", "turn/seq", "kind", "when", "snippet"]);
}

export function hitsBySession(hits: PartHit[]): string {
  const groups = new Map<string, { title: string; tool: string; project: string; n: number; kinds: Record<string, number>; first: PartHit }>();
  for (const h of hits) {
    const g = groups.get(h.sessionKey) ?? { title: h.title, tool: h.tool, project: h.project, n: 0, kinds: {}, first: h };
    g.n++;
    g.kinds[h.kind] = (g.kinds[h.kind] ?? 0) + 1;
    groups.set(h.sessionKey, g);
  }
  const rows = Array.from(groups.entries()).map(([key, g]) => [String(g.n), TOOL_META[g.tool as ToolId]?.short ?? g.tool, truncate(g.project, 18), truncate(g.title, 50), Object.entries(g.kinds).map(([k, n]) => `${k}:${n}`).join(" "), key]);
  return table(rows, ["hits", "tool", "project", "title", "kinds", "key"]);
}

export function filesTable(files: FileStat[]): string {
  return table(
    files.map((f) => [String(f.edits), String(f.reads), String(f.sessions), f.lastActivity ? fmtTime(f.lastActivity) : "", f.path]),
    ["edits", "reads", "sessions", "last", "path"],
  );
}
