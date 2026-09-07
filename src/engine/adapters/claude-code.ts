import path from "node:path";
import fs from "node:fs";
import type { Message, SessionDetail, SessionSummary, SourceAdapter, ToolId } from "../types";
import { readJsonl } from "../util/jsonl";
import { decodeDashedCwd, expand, listDirs, projectFromPath, walk } from "../util/paths";
import { buildSession } from "../util/session";
import { cleanPrompt, extractText, extractToolCalls, isRecord, normalizeRole, str } from "../util/text";
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
  const messages: Message[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let summary: string | undefined;
  let title: string | undefined;
  let model: string | undefined;
  let parentSession: string | undefined;

  for (const r of records) {
    const type = str(r.type);
    if (!sessionId) sessionId = str(r.sessionId);
    if (!cwd) cwd = str(r.cwd);
    if (!branch) branch = str(r.gitBranch);
    if (type === "summary") {
      summary = str(r.summary) ?? summary;
      continue;
    }
    if (type === "custom-title" || type === "title") {
      title = str(r.customTitle) ?? str(r.title) ?? title;
      continue;
    }
    if (r.isMeta === true) continue;
    if (type !== "user" && type !== "assistant") continue;
    const msg = isRecord(r.message) ? r.message : r;
    const role = normalizeRole(msg.role ?? type);
    if (!role) continue;
    const content = msg.content;
    if (r.isSidechain === true && !parentSession) parentSession = str(r.parentSessionId) ?? undefined;

    if (role === "user" && Array.isArray(content) && content.every((c) => isRecord(c) && c.type === "tool_result")) {
      const text = extractText(content.map((c) => (c as Rec).content));
      if (text) messages.push({ role: "tool", text: text.slice(0, 4000), timestamp: toIso(r.timestamp) });
      continue;
    }
    const text = extractText(content);
    const toolCalls = extractToolCalls(content);
    if (!model) model = str(msg.model);
    if (role === "user") {
      const cleaned = cleanPrompt(text);
      if (!cleaned) continue;
      messages.push({ role, text: cleaned, timestamp: toIso(r.timestamp) });
    } else {
      if (!text.trim() && !toolCalls.length) continue;
      messages.push({ role, text, timestamp: toIso(r.timestamp), model: str(msg.model), toolCalls: toolCalls.length ? toolCalls : undefined });
    }
  }
  if (!messages.length) return null;
  const id = opts.nativeId ?? sessionId ?? path.basename(opts.file, ".jsonl");
  return buildSession({
    tool: opts.tool,
    surface: opts.surface ?? "cli",
    nativeId: id,
    title: title ?? summary,
    project: projectFromPath(cwd ?? opts.fallbackCwd),
    messages,
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
