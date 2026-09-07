import fs from "node:fs";
import path from "node:path";
import type { Message, SessionDetail, SourceAdapter, Surface, ToolId } from "../types";
import { readJsonl } from "../util/jsonl";
import { decodeDashedCwd, expand, listDirs, projectFromPath, walk } from "../util/paths";
import { buildSession } from "../util/session";
import { cleanPrompt, extractText, isRecord, normalizeRole, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { detection, fileSource, scanFiles } from "./_shared";
import { parseClaudeShapedRecords } from "./claude-code";

type Rec = Record<string, unknown>;

/**
 * Tencent WorkBuddy / CodeBuddy Code borrows Claude Code's directory layout
 * (`~/.codebuddy/projects/<encoded-cwd>/<session>.jsonl`) but writes flat
 * OpenAI Agents-SDK "items": top-level `type` of `message` / `reasoning` /
 * `function_call` / `function_call_result` / `ai-title`, a top-level `role`,
 * `content[]` of `input_text` / `output_text`, and millisecond timestamps.
 */
export function parseFlatItemRecords(
  records: Rec[],
  opts: { tool: ToolId; file: string; fallbackCwd?: string; surface: Surface; nativeId?: string },
): SessionDetail | null {
  const messages: Message[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let title: string | undefined;
  let model: string | undefined;
  let branch: string | undefined;
  for (const r of records) {
    sessionId = sessionId ?? str(r.sessionId);
    cwd = cwd ?? str(r.cwd);
    branch = branch ?? str(r.gitBranch);
    const provider = isRecord(r.providerData) ? r.providerData : undefined;
    model = model ?? str(provider?.model) ?? str(provider?.requestModelName) ?? str(r.requestModelId);
    const type = str(r.type);
    const ts = toIso(r.timestamp);
    if (type === "ai-title") {
      title = str(r.aiTitle) ?? title;
      continue;
    }
    if (type === "message") {
      const role = normalizeRole(r.role);
      if (!role) continue;
      const text = extractText(r.content);
      if (role === "user") {
        const cleaned = cleanPrompt(text);
        if (cleaned) messages.push({ role, text: cleaned, timestamp: ts });
      } else if (role === "assistant" && text.trim()) {
        messages.push({ role, text, timestamp: ts, model: str(provider?.model) });
      }
    } else if (type === "function_call") {
      const name = str(r.name) ?? "tool";
      messages.push({ role: "assistant", text: "", timestamp: ts, toolCalls: [{ name, summary: summarizeToolInput(name, r.arguments) }] });
    } else if (type === "function_call_result") {
      const out = extractText(r.output);
      if (out) messages.push({ role: "tool", text: out.slice(0, 4000), timestamp: ts });
    }
  }
  if (!messages.length) return null;
  return buildSession({
    tool: opts.tool,
    surface: opts.surface,
    nativeId: opts.nativeId ?? sessionId ?? path.basename(opts.file, ".jsonl"),
    title,
    project: projectFromPath(cwd ?? opts.fallbackCwd),
    messages,
    source: fileSource(opts.file),
    model,
    gitBranch: branch,
    fallbackTime: fs.statSync(opts.file).mtimeMs,
  });
}

function roots(): string[] {
  const list = [process.env.CODEBUDDY_DIR, process.env.WORKBUDDY_DIR, "~/.codebuddy", "~/.workbuddy"].filter((p): p is string => !!p);
  return Array.from(new Set(list.map(expand)));
}

function transcriptFiles(): string[] {
  const out: string[] = [];
  for (const root of roots()) {
    for (const projDir of listDirs(path.join(root, "projects"))) {
      out.push(...walk(projDir, (p, n) => n.endsWith(".jsonl") && !p.includes(`${path.sep}memory${path.sep}`) && !p.includes(`${path.sep}tool-results${path.sep}`), { maxDepth: 3 }));
    }
  }
  return out;
}

async function parseFile(file: string): Promise<SessionDetail | null> {
  const records = await readJsonl<Rec>(file);
  const parts = file.split(path.sep);
  const projIdx = parts.lastIndexOf("projects");
  const encoded = projIdx >= 0 ? parts[projIdx + 1] : "";
  const cwd = encoded ? decodeDashedCwd(encoded) : undefined;
  const isFlat = records.some((r) => typeof r.type === "string" && ["message", "function_call", "ai-title", "reasoning"].includes(r.type as string) && r.message === undefined);
  const detail = isFlat
    ? parseFlatItemRecords(records, { tool: "workbuddy", file, fallbackCwd: cwd, surface: "cli" })
    : parseClaudeShapedRecords(records, { tool: "workbuddy", file, fallbackCwd: cwd });
  if (detail && parts.includes("subagents")) {
    const parentId = parts[parts.indexOf("subagents") - 1];
    detail.nativeId = `${parentId}/${path.basename(file, ".jsonl")}`;
    detail.key = `workbuddy:${detail.nativeId}`;
    detail.parentKey = `workbuddy:${parentId}`;
    detail.extra = { ...detail.extra, subagent: true };
  }
  return detail;
}

export const workbuddy: SourceAdapter = {
  id: "workbuddy",
  name: "WorkBuddy / CodeBuddy Code",
  vendor: "Tencent",
  surface: "cli",
  configHints: ["CODEBUDDY_DIR (default ~/.codebuddy)", "WORKBUDDY_DIR (default ~/.workbuddy)"],
  strategies: [
    { kind: "api", status: "reserved", description: "No local query API; `codebuddy -p --output-format json` only covers the current run." },
    { kind: "file", status: "implemented", description: "~/.codebuddy/projects/<encoded-cwd>/<session>.jsonl (flat OpenAI-item schema; Claude-shaped legacy files also accepted)." },
  ],
  async detect() {
    return detection(roots().map((r) => ({ path: path.join(r, "projects") })));
  },
  async scan(ctx) {
    return scanFiles(transcriptFiles(), ctx, parseFile);
  },
  async load(summary) {
    return parseFile(summary.source.path);
  },
};
