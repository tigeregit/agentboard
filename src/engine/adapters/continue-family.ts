import fs from "node:fs";
import path from "node:path";
import type { Message, ScanContext, ScanResult, SessionDetail, SessionSummary, ToolCall, ToolId } from "../types";
import { readJsonSafe } from "../util/jsonl";
import { projectFromPath } from "../util/paths";
import { buildSession } from "../util/session";
import { cleanPrompt, extractText, isRecord, normalizeRole, str, summarizeToolInput } from "../util/text";
import { maxIso, toIso } from "../util/time";
import { detection, fileSource, memo, scanFiles } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * Continue (VS Code / JetBrains / CLI) and its fork PearAI persist one JSON
 * document per chat at `<global-dir>/sessions/<sessionId>.json`:
 * `{sessionId, title, workspaceDirectory, history[]}` where each history item
 * is `{message:{role, content, toolCalls?, toolCallId?}, contextItems[],
 * toolCallStates?[]}`. `content` is a string or an array of parts
 * (`{type:"text",text}` / `{type:"imageUrl",...}`). Tool invocations are in
 * `toolCallStates[]` (`toolCall.function.{name,arguments}`, `parsedArgs`,
 * `status`, `output[]`) and their results come back as `role: "tool"` items.
 * A sibling `sessions.json` index (`{sessionId, title, dateCreated,
 * workspaceDirectory}[]`) is consulted only for `dateCreated`; messages carry
 * no timestamps so the file mtime is the fallback.
 */

export interface ContinueFamily {
  tool: ToolId;
  name: string;
  /** Resolved global dir (e.g. `~/.continue`). */
  globalDir(): string;
}

const INDEX_FILE = "sessions.json";

export function sessionsDir(fam: ContinueFamily): string {
  return path.join(fam.globalDir(), "sessions");
}

export function sessionFiles(fam: ContinueFamily): string[] {
  const dir = sessionsDir(fam);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json") && e.name !== INDEX_FILE)
    .map((e) => path.join(dir, e.name))
    .sort();
}

/** `sessions.json` entries keyed by session id. */
function readIndex(fam: ContinueFamily): Map<string, Rec> {
  const out = new Map<string, Rec>();
  const raw = readJsonSafe<unknown>(path.join(sessionsDir(fam), INDEX_FILE));
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = str(item.sessionId);
    if (id) out.set(id, item);
  }
  return out;
}

function toolCallsFrom(item: Rec, message: Rec): ToolCall[] {
  const out: ToolCall[] = [];
  const states = Array.isArray(item.toolCallStates) ? item.toolCallStates.filter(isRecord) : [];
  for (const state of states) {
    const call = isRecord(state.toolCall) ? state.toolCall : undefined;
    const fn = isRecord(call?.function) ? call.function : undefined;
    const name = str(fn?.name) ?? str(state.toolName) ?? "tool";
    out.push({ name, summary: summarizeToolInput(name, state.parsedArgs ?? fn?.arguments) });
  }
  if (out.length) return out;
  const calls = Array.isArray(message.toolCalls) ? message.toolCalls.filter(isRecord) : [];
  for (const call of calls) {
    const fn = isRecord(call.function) ? call.function : undefined;
    const name = str(fn?.name) ?? "tool";
    out.push({ name, summary: summarizeToolInput(name, fn?.arguments) });
  }
  return out;
}

/** Tool output embedded in `toolCallStates[].output[]` (context items), for histories without `role: "tool"` items. */
function toolOutputs(item: Rec): string[] {
  const states = Array.isArray(item.toolCallStates) ? item.toolCallStates.filter(isRecord) : [];
  const out: string[] = [];
  for (const state of states) {
    const items = Array.isArray(state.output) ? state.output.filter(isRecord) : [];
    const text = items
      .map((o) => str(o.content) ?? "")
      .filter(Boolean)
      .join("\n");
    if (text) out.push(text);
  }
  return out;
}

export function convertHistory(history: unknown[]): Message[] {
  const items = history.filter(isRecord);
  const hasToolRole = items.some((it) => isRecord(it.message) && normalizeRole(it.message.role) === "tool");
  const out: Message[] = [];
  for (const item of items) {
    const message = isRecord(item.message) ? item.message : undefined;
    if (!message) continue;
    const role = normalizeRole(message.role);
    if (!role || role === "system") continue;
    const text = extractText(message.content);
    if (role === "user") {
      const cleaned = cleanPrompt(text);
      if (cleaned) out.push({ role, text: cleaned });
    } else if (role === "assistant") {
      const toolCalls = toolCallsFrom(item, message);
      if (text.trim() || toolCalls.length) out.push({ role, text, toolCalls: toolCalls.length ? toolCalls : undefined });
      if (!hasToolRole) for (const o of toolOutputs(item)) out.push({ role: "tool", text: o.slice(0, 4000) });
    } else if (text.trim()) {
      out.push({ role: "tool", text: text.slice(0, 4000) });
    }
  }
  return out;
}

export function parseSessionFile(fam: ContinueFamily, file: string, index?: Map<string, Rec>): SessionDetail | null {
  const doc = readJsonSafe<unknown>(file);
  if (!isRecord(doc)) return null;
  const sessionId = str(doc.sessionId) || path.basename(file, ".json");
  const messages = convertHistory(Array.isArray(doc.history) ? doc.history : []);
  if (!messages.length) return null;
  const meta = (index ?? readIndex(fam)).get(sessionId);
  const title = str(doc.title)?.trim();
  const workspace = str(doc.workspaceDirectory) ?? str(meta?.workspaceDirectory);
  const mtimeMs = fs.statSync(file).mtimeMs;
  const created = toIso(meta?.dateCreated);
  return buildSession({
    tool: fam.tool,
    surface: "ide",
    nativeId: sessionId,
    title: title && title !== "New Session" ? title : undefined,
    project: projectFromPath(workspace || undefined),
    messages,
    source: fileSource(file),
    startedAt: created,
    endedAt: created ? maxIso(created, toIso(mtimeMs)) : undefined,
    fallbackTime: mtimeMs,
    extra: workspace ? { workspaceDirectory: workspace } : undefined,
  });
}

export function familyDetect(fam: ContinueFamily) {
  return detection([{ path: sessionsDir(fam), note: `${fam.name} sessions (<sessionId>.json)` }]);
}

export async function familyScan(fam: ContinueFamily, ctx: ScanContext): Promise<ScanResult> {
  const files = sessionFiles(fam);
  if (!files.length) return { sessions: [], seen: [], warnings: [] };
  const index = await memo(ctx, `${fam.tool}:sessions-index:${sessionsDir(fam)}`, async () => readIndex(fam));
  return scanFiles(files, ctx, async (file) => parseSessionFile(fam, file, index));
}

export function familyLoad(fam: ContinueFamily, summary: SessionSummary): SessionDetail | null {
  return parseSessionFile(fam, summary.source.path);
}
