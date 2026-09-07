import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, SessionDetail, SessionSummary, SourceAdapter } from "../types";
import { readJsonSafe, readJsonl } from "../util/jsonl";
import { appDataRoots, listDirs, projectFromPath } from "../util/paths";
import { buildSession } from "../util/session";
import { cleanPrompt, extractText, isRecord, str } from "../util/text";
import { toIso } from "../util/time";
import { detection, fileSource, scanFiles } from "./_shared";
import { copilotDesktopSessionIds, copilotSessionsForTool, parseCopilotSessionDir } from "./copilot";

type Rec = Record<string, unknown>;

const HOSTS = ["Code", "Code - Insiders", "VSCodium", "Cursor"]; // Cursor keeps VS Code chatSessions too on some builds

function userRoots(): string[] {
  const roots: string[] = [];
  for (const host of HOSTS) for (const r of appDataRoots(host)) roots.push(path.join(r, "User"));
  if (process.env.VSCODE_USER_DIRS) roots.push(...process.env.VSCODE_USER_DIRS.split(path.delimiter));
  return Array.from(new Set(roots)).filter((r) => fs.existsSync(r));
}

interface Candidate {
  file: string;
  workspaceDir?: string;
}

function candidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const user of userRoots()) {
    for (const wsDir of listDirs(path.join(user, "workspaceStorage"))) {
      const chatDir = path.join(wsDir, "chatSessions");
      for (const f of listSessionFiles(chatDir)) out.push({ file: f, workspaceDir: wsDir });
    }
    for (const f of listSessionFiles(path.join(user, "globalStorage", "emptyWindowChatSessions"))) out.push({ file: f });
  }
  return dedupeJsonl(out);
}

function listSessionFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Prefer the .jsonl log when both formats exist for one session id. */
function dedupeJsonl(list: Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const c of list) {
    const id = path.basename(c.file).replace(/\.jsonl?$/, "");
    const prev = byId.get(id);
    if (!prev || c.file.endsWith(".jsonl")) byId.set(id, c);
  }
  return Array.from(byId.values());
}

function workspaceFolder(wsDir: string | undefined): string | undefined {
  if (!wsDir) return undefined;
  const ws = readJsonSafe<Rec>(path.join(wsDir, "workspace.json"));
  const uri = str(ws?.folder) ?? str(ws?.workspace) ?? str(ws?.configuration);
  if (!uri) return undefined;
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : uri;
  } catch {
    return uri;
  }
}

/** Replay VS Code's mutation log (kind 0 initial, 1 set, 2 push, 3 delete). */
function replayLog(entries: Rec[]): Rec | null {
  let state: Rec | null = null;
  for (const e of entries) {
    const kind = e.kind;
    if (kind === 0) {
      state = isRecord(e.v) ? structuredClone(e.v) : null;
      continue;
    }
    if (!state) continue;
    const keyPath = Array.isArray(e.k) ? (e.k as (string | number)[]) : null;
    if (!keyPath) continue;
    try {
      if (kind === 1) setPath(state, keyPath, e.v);
      else if (kind === 2) {
        const arr = getPath(state, keyPath);
        if (Array.isArray(arr) && Array.isArray(e.v)) arr.push(...e.v);
        else if (Array.isArray(e.v)) setPath(state, keyPath, [...e.v]);
      } else if (kind === 3) deletePath(state, keyPath);
    } catch {
      /* ignore corrupt mutation */
    }
  }
  return state;
}

function getPath(obj: unknown, keys: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}
function setPath(obj: Rec, keys: (string | number)[], value: unknown) {
  let cur: unknown = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const c = cur as Record<string | number, unknown>;
    if (c[k] === undefined || c[k] === null) c[k] = typeof keys[i + 1] === "number" ? [] : {};
    cur = c[k];
  }
  (cur as Record<string | number, unknown>)[keys[keys.length - 1]] = value;
}
function deletePath(obj: Rec, keys: (string | number)[]) {
  const parent = getPath(obj, keys.slice(0, -1));
  if (parent && typeof parent === "object") delete (parent as Record<string | number, unknown>)[keys[keys.length - 1]];
}

function requestsToMessages(requests: Rec[]): Message[] {
  const out: Message[] = [];
  for (const req of requests) {
    if (!isRecord(req)) continue;
    const ts = toIso(req.timestamp);
    const msg = req.message;
    const userText = cleanPrompt(typeof msg === "string" ? msg : extractText(isRecord(msg) ? msg.text ?? msg.parts : msg));
    const agent = isRecord(req.agent) ? str(req.agent.id) : undefined;
    if (userText) out.push({ role: "user", text: userText, timestamp: ts });
    const response = Array.isArray(req.response) ? (req.response as unknown[]) : [];
    const texts: string[] = [];
    const toolCalls: Message["toolCalls"] = [];
    for (const item of response) {
      if (typeof item === "string") {
        texts.push(item);
        continue;
      }
      if (!isRecord(item)) continue;
      const kind = str(item.kind);
      if (kind === "toolInvocationSerialized" || kind === "toolInvocation") {
        const name = str(item.toolId) ?? str(item.toolName) ?? "tool";
        const inv = item.invocationMessage;
        const summary = typeof inv === "string" ? inv : extractText(inv);
        toolCalls.push({ name, summary: summary?.slice(0, 160) || undefined });
        continue;
      }
      if (kind && ["thinking", "progressMessage", "warning", "info", "systemNotification", "progressTask", "codeblockUri", "undoStop", "prepareToolInvocation"].includes(kind)) continue;
      if (typeof item.value === "string" && (!kind || kind === "markdownContent" || kind === "inlineReference" || kind === "markdownVuln")) texts.push(item.value);
      else if (isRecord(item.value) && typeof item.value.value === "string") texts.push(item.value.value);
    }
    const model = str(req.modelId) ?? str(req.modelInfo) ?? agent;
    const text = texts.join("");
    if (text.trim() || toolCalls.length) out.push({ role: "assistant", text, timestamp: ts, model, toolCalls: toolCalls.length ? toolCalls : undefined });
  }
  return out;
}

async function parseCandidate(c: Candidate): Promise<SessionDetail | null> {
  let state: Rec | null;
  if (c.file.endsWith(".jsonl")) {
    state = replayLog(await readJsonl<Rec>(c.file));
  } else {
    state = readJsonSafe<Rec>(c.file);
  }
  if (!state) return null;
  const requests = Array.isArray(state.requests) ? (state.requests as Rec[]) : [];
  const messages = requestsToMessages(requests);
  if (!messages.length) return null;
  const folder = workspaceFolder(c.workspaceDir) ?? str(state.workingDirectory);
  const id = str(state.sessionId) ?? path.basename(c.file).replace(/\.jsonl?$/, "");
  return buildSession({
    tool: "vscode-copilot",
    surface: "ide",
    nativeId: id,
    title: str(state.customTitle) ?? str(state.title),
    project: projectFromPath(folder),
    messages,
    source: fileSource(c.file),
    startedAt: state.creationDate,
    endedAt: state.lastMessageDate,
    fallbackTime: fs.statSync(c.file).mtimeMs,
    extra: { host: c.file.split(path.sep).find((seg) => HOSTS.includes(seg)) },
  });
}

export const vscodeCopilot: SourceAdapter = {
  id: "vscode-copilot",
  name: "VS Code Copilot Chat",
  vendor: "Microsoft / GitHub",
  surface: "ide",
  configHints: ["VSCODE_USER_DIRS (extra User folders, path-delimited)", "Probes Code, Code - Insiders, VSCodium"],
  strategies: [
    { kind: "api", status: "reserved", description: "No extension API to enumerate chat sessions; `Chat: Export Session` is manual." },
    { kind: "file", status: "implemented", description: "User/workspaceStorage/<hash>/chatSessions/*.jsonl mutation log (kind 0/1/2/3) or legacy *.json, plus globalStorage/emptyWindowChatSessions." },
    { kind: "file", status: "implemented", description: "Copilot agent sessions hosted by VS Code that land in ~/.copilot/session-state (host_type=vscode)." },
  ],
  async detect() {
    return detection(userRoots().map((r) => ({ path: path.join(r, "workspaceStorage") })));
  },
  async scan(ctx) {
    const list = candidates();
    const byFile = new Map(list.map((c) => [c.file, c]));
    const result = await scanFiles(
      list.map((c) => c.file),
      ctx,
      async (file) => parseCandidate(byFile.get(file) ?? { file }),
    );
    const hosted = await copilotSessionsForTool(ctx, "vscode-copilot");
    result.sessions.push(...hosted.sessions);
    result.warnings.push(...hosted.warnings);
    return result;
  },
  async load(summary: SessionSummary) {
    if (summary.source.path.endsWith("events.jsonl")) {
      const d = await parseCopilotSessionDir(path.dirname(summary.source.path), copilotDesktopSessionIds());
      if (d) {
        d.tool = "vscode-copilot";
        d.key = summary.key;
        d.surface = "ide";
      }
      return d;
    }
    const wsDir = summary.source.path.includes(`${path.sep}workspaceStorage${path.sep}`) ? path.dirname(path.dirname(summary.source.path)) : undefined;
    return parseCandidate({ file: summary.source.path, workspaceDir: wsDir });
  },
};
