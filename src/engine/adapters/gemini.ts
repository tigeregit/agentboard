import fs from "node:fs";
import path from "node:path";
import type { Message, SessionDetail, SourceAdapter, ToolCall } from "../types";
import { parseJsonlText } from "../util/jsonl";
import { exists, expand, listDirs, projectFromPath } from "../util/paths";
import { buildSession } from "../util/session";
import { cleanPrompt, isRecord, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { detection, fileSource, scanFiles } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * Gemini CLI records chats under `<GEMINI_HOME|~/.gemini>/tmp/<projectHash>/chats/`;
 * the sibling `.project_root` file names the real cwd. Two on-disk formats:
 *  - legacy `session-*.json`: one object
 *    `{ sessionId, projectHash, startTime, lastUpdated, kind, summary?, messages: [...] }`
 *  - current `session-*.jsonl` (gemini-cli#23749): first line is the same
 *    metadata (string `sessionId` + `projectHash`), then one message record per
 *    line (string `id`); `{ "$set": {...} }` lines patch the metadata and
 *    `{ "$rewindTo": ... }` markers carry no content.
 * Message records: `{ id, timestamp, type: user|gemini|info|warning|error,
 * content: string | Part[], model?, thoughts?: [{subject,description}],
 * tokens?, toolCalls?: [{ id, name, args, result?, resultDisplay?, status }] }`.
 */
function geminiHome(): string {
  const env = process.env.GEMINI_HOME?.trim();
  if (env && fs.statSync(env, { throwIfNoEntry: false })?.isDirectory()) return env;
  return expand("~/.gemini");
}

function tmpDir(): string {
  return path.join(geminiHome(), "tmp");
}

function isSessionFile(name: string): boolean {
  return name.startsWith("session-") && /\.jsonl?$/i.test(name);
}

function sessionFiles(): string[] {
  const out: string[] = [];
  for (const project of listDirs(tmpDir())) {
    const chats = path.join(project, "chats");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(chats, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) if (e.isFile() && isSessionFile(e.name)) out.push(path.join(chats, e.name));
  }
  return out;
}

function readProjectRoot(projectDir: string): string | undefined {
  try {
    const s = fs.readFileSync(path.join(projectDir, ".project_root"), "utf8").trim();
    return s || undefined;
  } catch {
    return undefined;
  }
}

/** Both on-disk formats → merged metadata object + ordered message records. */
export function parseGeminiSession(data: string): { meta: Rec; records: Rec[] } | null {
  try {
    const whole: unknown = JSON.parse(data);
    if (isRecord(whole) && Array.isArray(whole.messages)) return { meta: whole, records: whole.messages.filter(isRecord) };
  } catch {
    /* not a single JSON document: fall through to JSONL */
  }
  const lines = parseJsonlText<unknown>(data).filter(isRecord);
  if (!lines.length) return null;
  const meta: Rec = {};
  const records: Rec[] = [];
  for (const obj of lines) {
    if (isRecord(obj.$set)) {
      Object.assign(meta, obj.$set);
      continue;
    }
    if ("$rewindTo" in obj) continue;
    if (str(obj.sessionId) && str(obj.projectHash)) {
      Object.assign(meta, obj);
      continue;
    }
    if (str(obj.id)) records.push(obj);
  }
  return { meta, records };
}

/** Split a genai PartListUnion into visible text (thoughts dropped), Part-level tool calls and tool outputs. */
function partsToText(content: unknown): { text: string; toolCalls: ToolCall[]; outputs: string[] } {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const outputs: string[] = [];
  if (typeof content === "string") return { text: content, toolCalls, outputs };
  if (!Array.isArray(content)) return { text: "", toolCalls, outputs };
  for (const part of content) {
    if (typeof part === "string") {
      texts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    if (typeof part.text === "string") {
      if (part.thought !== true) texts.push(part.text);
    } else if (isRecord(part.functionCall)) {
      const name = str(part.functionCall.name) ?? "unknown";
      toolCalls.push({ name, summary: summarizeToolInput(name, part.functionCall.args) });
    } else if (isRecord(part.functionResponse)) {
      const resp = part.functionResponse.response;
      const out = isRecord(resp) ? str(resp.output) : undefined;
      if (out) outputs.push(out);
    } else if (isRecord(part.executableCode)) {
      texts.push(`\`\`\`${str(part.executableCode.language) ?? "python"}\n${str(part.executableCode.code) ?? ""}\n\`\`\``);
    } else if (isRecord(part.codeExecutionResult)) {
      texts.push(`[Code Execution: ${str(part.codeExecutionResult.outcome) ?? "UNKNOWN"}]\n${str(part.codeExecutionResult.output) ?? ""}`);
    }
  }
  return { text: texts.join("\n"), toolCalls, outputs };
}

function toolResultText(result: unknown): string {
  if (Array.isArray(result)) {
    const texts = result.map((item) => (isRecord(item) && isRecord(item.functionResponse) && isRecord(item.functionResponse.response) ? str(item.functionResponse.response.output) : undefined)).filter((t): t is string => !!t);
    if (texts.length) return texts.join("\n");
  }
  if (typeof result === "string") return result;
  return JSON.stringify(result) ?? "";
}

function resultDisplayText(display: unknown): string | undefined {
  if (typeof display === "string") return display || undefined;
  if (!isRecord(display)) return undefined;
  if ("fileDiff" in display) return `[File Change] ${str(display.fileName) ?? "unknown file"}`;
  if ("todos" in display) return "[Task List Updated]";
  if ("isSubagentProgress" in display) return `[Subagent: ${str(display.agentName) ?? "agent"}]`;
  return undefined;
}

function convertRecords(records: Rec[]): { messages: Message[]; model?: string } {
  const messages: Message[] = [];
  let model: string | undefined;
  for (const r of records) {
    const type = str(r.type);
    const ts = toIso(r.timestamp);
    if (type === "user") {
      const { text, outputs } = partsToText(r.content);
      const cleaned = cleanPrompt(text);
      if (cleaned) messages.push({ role: "user", text: cleaned, timestamp: ts });
      for (const out of outputs) messages.push({ role: "tool", text: out.slice(0, 4000), timestamp: ts });
    } else if (type === "gemini") {
      const m = str(r.model);
      model ??= m;
      const { text, toolCalls, outputs } = partsToText(r.content);
      const results: string[] = [];
      const calls = Array.isArray(r.toolCalls) ? r.toolCalls.filter(isRecord) : [];
      for (const tc of calls) {
        const name = str(tc.name) ?? "unknown";
        toolCalls.push({ name, summary: summarizeToolInput(name, tc.args) });
        if (tc.result !== undefined) {
          const out = toolResultText(tc.result);
          if (out) results.push(str(tc.status) === "error" ? `[error] ${out}` : out);
        }
        const display = resultDisplayText(tc.resultDisplay);
        if (display) results.push(display);
      }
      if (text.trim() || toolCalls.length) messages.push({ role: "assistant", text, timestamp: ts, model: m, toolCalls: toolCalls.length ? toolCalls : undefined });
      for (const out of [...outputs, ...results]) messages.push({ role: "tool", text: out.slice(0, 4000), timestamp: ts });
    }
    // info / warning / error records are system notices, not turns
  }
  return { messages, model };
}

function parseFile(file: string): SessionDetail | null {
  const parsed = parseGeminiSession(fs.readFileSync(file, "utf8"));
  if (!parsed) return null;
  const { meta, records } = parsed;
  if (str(meta.kind) === "subagent") return null;
  const { messages, model } = convertRecords(records);
  if (!messages.length) return null;
  const projectDir = path.dirname(path.dirname(file));
  return buildSession({
    tool: "gemini",
    surface: "cli",
    nativeId: str(meta.sessionId) ?? path.basename(file).replace(/\.jsonl?$/i, ""),
    title: str(meta.summary),
    project: projectFromPath(readProjectRoot(projectDir) ?? projectDir),
    messages,
    source: fileSource(file),
    startedAt: meta.startTime,
    endedAt: meta.lastUpdated,
    model,
    fallbackTime: fs.statSync(file).mtimeMs,
    extra: { projectHash: str(meta.projectHash) ?? path.basename(projectDir), kind: str(meta.kind) ?? "main", format: file.toLowerCase().endsWith(".jsonl") ? "jsonl" : "json" },
  });
}

export const gemini: SourceAdapter = {
  id: "gemini",
  name: "Gemini CLI",
  vendor: "Google",
  surface: "cli",
  configHints: ["GEMINI_HOME (default ~/.gemini; must be an existing directory)"],
  strategies: [
    { kind: "file", status: "implemented", description: "~/.gemini/tmp/<projectHash>/chats/session-*.jsonl (metadata line + message records, $set/$rewindTo control lines) and legacy session-*.json; .project_root gives the cwd." },
  ],
  async detect() {
    const d = detection([{ path: tmpDir(), note: "per-project chats (session-*.json[l])" }]);
    if (exists(path.join(geminiHome(), "antigravity")) || exists(path.join(geminiHome(), "antigravity-cli"))) d.notes = ["~/.gemini also hosts Antigravity stores; those are handled by the antigravity adapter."];
    return d;
  },
  async scan(ctx) {
    return scanFiles(sessionFiles(), ctx, async (file) => parseFile(file));
  },
  async load(summary) {
    return parseFile(summary.source.path);
  },
};
