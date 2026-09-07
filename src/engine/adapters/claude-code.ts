import path from "node:path";
import fs from "node:fs";
import type { Part, SessionDetail, SessionSummary, SourceAdapter, ToolId } from "../types";
import { extractFiles, splitInjected } from "../parts/classify";
import { PartList } from "../parts/derive";
import { readJsonl } from "../util/jsonl";
import { decodeDashedCwd, expand, listDirs, projectFromPath, walk } from "../util/paths";
import { buildSession } from "../util/session";
import { extractText, isRecord, normalizeRole, str } from "../util/text";
import { toIso } from "../util/time";
import { detection, fileSource, scanFiles } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * Parse a Claude Code style transcript (`~/.claude/projects/<cwd>/<id>.jsonl`).
 * Also used for tools that copy the format (ZCode legacy, WorkBuddy legacy).
 */
export function parseClaudeShapedRecords(
  records: Rec[],
  opts: { tool: ToolId; file: string; fallbackCwd?: string; nativeId?: string; surface?: "cli" | "ide" },
): SessionDetail | null {
  const list = new PartList();
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let summary: string | undefined;
  let title: string | undefined;
  let model: string | undefined;
  let parentSession: string | undefined;
  const callNames = new Map<string, string>();
  const callFiles = new Map<string, string[]>();
  let lastAssistant: Part | undefined;

  for (const r of records) {
    const type = str(r.type);
    if (!sessionId) sessionId = str(r.sessionId);
    if (!cwd) cwd = str(r.cwd);
    if (!branch) branch = str(r.gitBranch);
    const ts = toIso(r.timestamp);
    if (type === "summary") {
      summary = str(r.summary) ?? summary;
      // Claude Code writes a summary record when it compacts / resumes; keep it as a compaction part when it has a body.
      if (summary && records.length > 5) list.push({ kind: "compaction", role: "system", text: summary, timestamp: ts });
      continue;
    }
    if (type === "custom-title" || type === "title") {
      title = str(r.customTitle) ?? str(r.title) ?? title;
      continue;
    }
    if (type === "system") {
      const text = str(r.content) ?? extractText(r.content);
      if (text?.trim()) list.push({ kind: "event", role: "system", text, timestamp: ts });
      continue;
    }
    if (type !== "user" && type !== "assistant") continue;
    const msg = isRecord(r.message) ? r.message : r;
    const role = normalizeRole(msg.role ?? type);
    if (!role) continue;
    const content = msg.content;
    if (r.isSidechain === true && !parentSession) parentSession = str(r.parentSessionId) ?? undefined;
    if (!model) model = str(msg.model);

    if (r.isMeta === true) {
      // Meta user rows carry injected context (caveats, local command output, skill loads).
      const text = extractText(content);
      if (text.trim()) {
        const { prompt, context } = splitInjected(text);
        for (const c of context) list.push({ kind: "context", role: "user", form: c.form, text: c.text, timestamp: ts });
        if (prompt) list.push({ kind: "context", role: "user", form: "notice", text: prompt, timestamp: ts });
      }
      continue;
    }

    if (role === "user") {
      const blocks = Array.isArray(content) ? (content as Rec[]).filter(isRecord) : [];
      const results = blocks.filter((b) => b.type === "tool_result");
      for (const b of results) {
        const callId = str(b.tool_use_id);
        const text = extractText(b.content);
        // Claude Code also puts structured results on the row (toolUseResult) — use it for file paths / stdout when the block is terse.
        const structured = isRecord(r.toolUseResult) ? r.toolUseResult : undefined;
        const files = structured ? extractFiles(structured) : [];
        const body = text || (structured ? str(structured.stdout) ?? str(structured.content) ?? "" : "");
        list.pushToolResult(body, {
          callId,
          isError: b.is_error === true ? true : undefined,
          exitCode: structured && typeof structured.exitCode === "number" ? structured.exitCode : undefined,
          timestamp: ts,
          name: callId ? callNames.get(callId) : undefined,
          files: files.length ? files : callId ? callFiles.get(callId) : undefined,
        });
      }
      const rest = blocks.filter((b) => b.type !== "tool_result");
      const text = Array.isArray(content) ? extractText(rest) : extractText(content);
      if (text.trim()) list.pushUserText(text, { timestamp: ts });
      for (const b of blocks) if (b.type === "image") list.push({ kind: "context", role: "user", form: "attachment", text: "[image attachment]", timestamp: ts });
      continue;
    }

    // assistant
    const blocks = Array.isArray(content) ? (content as Rec[]).filter(isRecord) : [];
    if (!blocks.length) {
      const text = extractText(content);
      if (text.trim()) lastAssistant = list.push({ kind: "reply", role: "assistant", text, timestamp: ts, model: str(msg.model) });
    }
    for (const b of blocks) {
      const bt = str(b.type);
      if (bt === "text") {
        const text = str(b.text) ?? "";
        if (text.trim()) lastAssistant = list.push({ kind: "reply", role: "assistant", text, timestamp: ts, model: str(msg.model) });
      } else if (bt === "thinking" || bt === "redacted_thinking") {
        const text = str(b.thinking) ?? (bt === "redacted_thinking" ? "[redacted thinking]" : "");
        if (text.trim()) list.push({ kind: "reasoning", role: "assistant", text, timestamp: ts, model: str(msg.model) });
      } else if (bt === "tool_use") {
        const name = str(b.name) ?? "tool";
        const callId = str(b.id);
        if (callId) callNames.set(callId, name);
        const part = list.pushToolCall(name, b.input, { callId, timestamp: ts, model: str(msg.model) });
        if (callId && part.files) callFiles.set(callId, part.files);
        lastAssistant = part;
      }
    }
    const usage = isRecord(msg.usage) ? msg.usage : undefined;
    if (usage && lastAssistant) lastAssistant.usage = { input: Number(usage.input_tokens) || undefined, output: Number(usage.output_tokens) || undefined };
  }
  list.linkResults();
  if (!list.parts.length) return null;
  const id = opts.nativeId ?? sessionId ?? path.basename(opts.file, ".jsonl");
  return buildSession({
    tool: opts.tool,
    surface: opts.surface ?? "cli",
    nativeId: id,
    title: title ?? summary,
    project: projectFromPath(cwd ?? opts.fallbackCwd),
    parts: list.parts,
    source: fileSource(opts.file),
    model,
    gitBranch: branch,
    fallbackTime: fs.statSync(opts.file).mtimeMs,
    parentKey: parentSession ? `${opts.tool}:${parentSession}` : undefined,
  });
}

function configDir(): string {
  return expand(process.env.CLAUDE_CONFIG_DIR || "~/.claude");
}

function transcriptFiles(): string[] {
  const projects = path.join(configDir(), "projects");
  const files: string[] = [];
  for (const projDir of listDirs(projects)) {
    for (const f of walk(projDir, (_p, name) => name.endsWith(".jsonl"), { maxDepth: 3 })) files.push(f);
  }
  return files;
}

async function parseFile(file: string): Promise<SessionDetail | null> {
  const records = await readJsonl<Rec>(file);
  const rel = path.relative(path.join(configDir(), "projects"), file).split(path.sep);
  const encoded = rel[0];
  const isSubagent = rel.includes("subagents");
  const detail = parseClaudeShapedRecords(records, { tool: "claude-code", file, fallbackCwd: decodeDashedCwd(encoded) });
  if (detail && isSubagent) {
    const parentId = rel.length >= 3 ? rel[1] : undefined;
    detail.nativeId = `${parentId ?? "subagent"}/${path.basename(file, ".jsonl")}`;
    detail.key = `claude-code:${detail.nativeId}`;
    detail.parentKey = parentId ? `claude-code:${parentId}` : detail.parentKey;
    detail.extra = { ...detail.extra, subagent: true };
  }
  return detail;
}

export const claudeCode: SourceAdapter = {
  id: "claude-code",
  name: "Claude Code",
  vendor: "Anthropic",
  surface: "cli",
  configHints: ["CLAUDE_CONFIG_DIR (default ~/.claude)"],
  strategies: [
    { kind: "api", status: "reserved", description: "No session query API today; the Agent SDK can resume but not list sessions." },
    { kind: "file", status: "implemented", description: "~/.claude/projects/<encoded-cwd>/<session>.jsonl transcripts (+ subagents/)." },
  ],
  async detect() {
    return detection([{ path: path.join(configDir(), "projects") }]);
  },
  async scan(ctx) {
    return scanFiles(transcriptFiles(), ctx, parseFile);
  },
  async load(summary: SessionSummary) {
    return parseFile(summary.source.path);
  },
};
