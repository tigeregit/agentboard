import fs from "node:fs";
import path from "node:path";
import type { Message, SessionDetail, SourceAdapter, ToolCall } from "../types";
import { readJsonl } from "../util/jsonl";
import { decodeDashedCwd, expand, listDirs, projectFromPath } from "../util/paths";
import { buildSession } from "../util/session";
import { cleanPrompt, isRecord, str, summarizeToolInput } from "../util/text";
import { detection, fileSource, scanFiles } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * Qwen Code (Alibaba's Gemini-CLI derivative) auto-saves each session as
 * `<runtime>/projects/<sanitizedCwd>/chats/<sessionId>.jsonl`, where the
 * runtime base is `$QWEN_RUNTIME_DIR` / `$QWEN_HOME` / `~/.qwen` and
 * `sanitizedCwd` is the cwd with every non-alphanumeric char replaced by `-`.
 * Each line is a ChatRecord:
 *   { uuid, parentUuid, sessionId, timestamp, type: user|assistant|tool_result|system,
 *     cwd, model, usageMetadata, message: { role: user|model, parts: Part[] } }
 * `Part` is the @google/genai shape: `{text}` / `{text, thought:true}` /
 * `{functionCall:{id,name,args}}` / `{functionResponse:{id,name,response:{output}}}`.
 */
function runtimeBase(): string {
  for (const env of ["QWEN_RUNTIME_DIR", "QWEN_HOME"]) {
    const v = process.env[env]?.trim();
    if (v) return expand(v);
  }
  return expand("~/.qwen");
}

function projectsDir(): string {
  return path.join(runtimeBase(), "projects");
}

function sessionFiles(): string[] {
  const out: string[] = [];
  for (const project of listDirs(projectsDir())) {
    const chats = path.join(project, "chats");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(chats, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) if (e.isFile() && e.name.endsWith(".jsonl")) out.push(path.join(chats, e.name));
  }
  return out;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  return JSON.stringify(v);
}

/** Split a record's genai parts into visible text, tool calls and tool outputs (thoughts dropped). */
function splitParts(parts: unknown): { text: string; toolCalls: ToolCall[]; outputs: string[] } {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const outputs: string[] = [];
  if (!Array.isArray(parts)) return { text: "", toolCalls, outputs };
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (isRecord(part.functionCall)) {
      const name = str(part.functionCall.name) ?? "unknown";
      toolCalls.push({ name, summary: summarizeToolInput(name, part.functionCall.args) });
      continue;
    }
    if (isRecord(part.functionResponse)) {
      const response = part.functionResponse.response;
      const out = isRecord(response) && response.output !== undefined ? stringify(response.output) : stringify(response);
      if (out) outputs.push(out);
      continue;
    }
    if (typeof part.text === "string" && part.text && part.thought !== true) texts.push(part.text);
  }
  return { text: texts.join("\n"), toolCalls, outputs };
}

async function parseFile(file: string): Promise<SessionDetail | null> {
  const records = await readJsonl<Rec>(file);
  const messages: Message[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let title: string | undefined;
  for (const r of records) {
    sessionId ??= str(r.sessionId);
    cwd ??= str(r.cwd);
    const type = str(r.type);
    const ts = str(r.timestamp);
    const msg = isRecord(r.message) ? r.message : undefined;
    const { text, toolCalls, outputs } = splitParts(msg?.parts);
    if (type === "user") {
      const cleaned = cleanPrompt(text);
      if (cleaned) messages.push({ role: "user", text: cleaned, timestamp: ts });
      for (const out of outputs) messages.push({ role: "tool", text: out.slice(0, 4000), timestamp: ts });
    } else if (type === "assistant") {
      const m = str(r.model);
      model ??= m;
      if (text.trim() || toolCalls.length) messages.push({ role: "assistant", text, timestamp: ts, model: m, toolCalls: toolCalls.length ? toolCalls : undefined });
    } else if (type === "tool_result") {
      for (const out of outputs) messages.push({ role: "tool", text: out.slice(0, 4000), timestamp: ts });
    } else if (type === "system" && str(r.subtype) === "custom_title" && text.trim()) {
      title = text.trim();
    }
  }
  if (!messages.length) return null;
  const base = path.basename(file, ".jsonl");
  return buildSession({
    tool: "qwen",
    surface: "cli",
    nativeId: sessionId ?? base,
    title,
    project: projectFromPath(cwd ?? decodeDashedCwd(path.basename(path.dirname(path.dirname(file))))),
    messages,
    source: fileSource(file),
    model,
    fallbackTime: fs.statSync(file).mtimeMs,
  });
}

export const qwen: SourceAdapter = {
  id: "qwen",
  name: "Qwen Code",
  vendor: "Alibaba",
  surface: "cli",
  configHints: ["QWEN_RUNTIME_DIR", "QWEN_HOME (default ~/.qwen)"],
  strategies: [
    { kind: "file", status: "implemented", description: "<QWEN_RUNTIME_DIR|QWEN_HOME|~/.qwen>/projects/<sanitizedCwd>/chats/<sessionId>.jsonl ChatRecord lines (user/assistant/tool_result; genai parts)." },
  ],
  async detect() {
    return detection([{ path: projectsDir() }]);
  },
  async scan(ctx) {
    return scanFiles(sessionFiles(), ctx, parseFile);
  },
  async load(summary) {
    return parseFile(summary.source.path);
  },
};
