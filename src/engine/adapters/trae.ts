import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, ScanContext, ScanResult, SessionDetail, SessionSummary, SourceAdapter, ToolCall } from "../types";
import { readJsonSafe } from "../util/jsonl";
import { appDataRoots, expand, listDirs, projectFromPath, statSafe, walk } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { cleanPrompt, extractText, isRecord, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { openSqliteReadOnly, type SqliteDb } from "../util/sqlite";
import { detection, fileSource, scanFiles, sqliteSource } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * Trae has three stores of interest:
 *  - Trae IDE / SOLO (ByteDance, VS Code fork), per-workspace VS Code KV db
 *    `<AppData>/Trae[ CN]/User/workspaceStorage/<hash>/state.vscdb`
 *    (`ItemTable(key, value)`). Chats sit under ByteDance "icube" mementos;
 *    the layout is reverse-engineered (via claude-code-history-viewer and the
 *    community trae-chats-exporter), so parsing is deliberately defensive.
 *  - Trae IDE `ModularData/ai-agent/database.db`: SQLCipher-4 encrypted with an
 *    in-memory key. Not readable; detected only so we can point to the export.
 *  - trae-agent (open-source CLI): `trajectories/trajectory_<ts>.json` files
 *    with `agent_steps[]` / `llm_interactions[]`. Fully parsed.
 */
function trajectoryRoots(): string[] {
  const roots = [process.env.TRAE_TRAJECTORY_DIR, ...(process.env.AGENTBOARD_TRAE_TRAJECTORY_DIRS?.split(path.delimiter) ?? []), "~/.trae-agent/trajectories", "~/.trae-agent"].filter((p): p is string => !!p);
  return Array.from(new Set(roots.map(expand)));
}

function trajectoryFiles(): string[] {
  const out = new Set<string>();
  for (const root of trajectoryRoots()) {
    for (const f of walk(root, (_p, n) => /^trajectory[_-].*\.json$/.test(n), { maxDepth: 4 })) out.add(f);
  }
  return Array.from(out);
}

function ideDatabases(): string[] {
  const out: string[] = [];
  for (const app of ["Trae", "Trae CN"]) {
    for (const root of appDataRoots(app)) out.push(path.join(root, "ModularData", "ai-agent", "database.db"));
  }
  return Array.from(new Set(out));
}

// ---------- Trae IDE workspaceStorage/<hash>/state.vscdb ----------

/** Exact icube keys to try, in precedence order. */
const ICUBE_EXACT_KEYS = ["memento/icube-ai-agent-storage", "ChatStore", "chat.ChatSessionStore.index"];
/** Install-suffixed keys (`…-<n>` is account specific), matched by prefix. */
const ICUBE_KEY_PREFIXES = ["memento/icube-ai-ng-chat-storage-", "memento/icube-ai-chat-storage-"];
const SESSION_CONTAINERS = ["list", "sessions", "conversations", "entries"];
const MESSAGE_CONTAINERS = ["messages", "conversation", "history", "list", "bubbles"];
const TEXT_FIELDS = ["content", "text", "message", "body", "prompt", "response"];

function workspaceStorageRoots(): string[] {
  const out: string[] = [];
  for (const app of ["Trae", "Trae CN"]) {
    for (const root of appDataRoots(app)) out.push(path.join(root, "User", "workspaceStorage"));
  }
  if (process.env.AGENTBOARD_TRAE_USER_DIRS) {
    for (const u of process.env.AGENTBOARD_TRAE_USER_DIRS.split(path.delimiter)) if (u) out.push(path.join(expand(u), "workspaceStorage"));
  }
  return Array.from(new Set(out)).filter((p) => fs.existsSync(p));
}

interface TraeWorkspace {
  dir: string;
  dbPath: string;
  folder?: string;
}

function workspaces(): TraeWorkspace[] {
  const out: TraeWorkspace[] = [];
  for (const root of workspaceStorageRoots()) {
    for (const dir of listDirs(root)) {
      const dbPath = path.join(dir, "state.vscdb");
      if (fs.existsSync(dbPath)) out.push({ dir, dbPath, folder: workspaceFolder(dir) });
    }
  }
  return out;
}

/** The workspace folder from `workspace.json` (a `file://` URI on every platform). */
function workspaceFolder(wsDir: string): string | undefined {
  const ws = readJsonSafe<Rec>(path.join(wsDir, "workspace.json"));
  const uri = str(ws?.folder) ?? str(ws?.workspace);
  if (!uri) return undefined;
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : uri;
  } catch {
    return uri.replace(/^file:\/\//, "");
  }
}

function valueToJson(v: unknown): unknown {
  try {
    if (typeof v === "string") return JSON.parse(v);
    if (Buffer.isBuffer(v)) return JSON.parse(v.toString("utf8"));
    if (v instanceof Uint8Array) return JSON.parse(Buffer.from(v).toString("utf8"));
  } catch {
    /* not JSON */
  }
  return null;
}

interface TraeSession {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  messages: Rec[];
}

/** Pull the session list out of an icube value, across every container shape seen in the wild. */
export function extractTraeSessions(value: unknown): TraeSession[] {
  let raw: unknown[] = [];
  if (Array.isArray(value)) raw = value;
  else if (isRecord(value)) {
    for (const key of SESSION_CONTAINERS) {
      const v = value[key];
      if (Array.isArray(v)) {
        raw = v;
        break;
      }
      if (isRecord(v)) {
        raw = Object.values(v);
        break;
      }
    }
  }
  const out: TraeSession[] = [];
  for (const s of raw) {
    if (!isRecord(s)) continue;
    const id = str(s.id) ?? str(s.sessionId) ?? str(s.key);
    if (!id) continue;
    const messages = MESSAGE_CONTAINERS.map((k) => s[k]).find(Array.isArray) as Rec[] | undefined;
    if (!messages?.length) continue;
    out.push({
      id,
      title: str(s.title) ?? str(s.name),
      createdAt: toIso(s.createdAt ?? s.createTime ?? s.created_at ?? s.timestamp),
      updatedAt: toIso(s.updatedAt ?? s.updateTime ?? s.updated_at ?? s.lastUpdatedAt),
      messages: messages.filter(isRecord),
    });
  }
  return out;
}

/** Reduce a content value to a string (mirrors trae-chats-exporter's cleanContent). */
function cleanContent(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (isRecord(v)) {
    const data = isRecord(v.data) ? v.data : undefined;
    for (const cand of [data?.summary, v.summary, v.content, v.text]) if (typeof cand === "string") return cand;
    const nested = extractText(v);
    return nested.trim() ? nested : JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    const nested = extractText(v);
    return nested.trim() ? nested : JSON.stringify(v);
  }
  return String(v);
}

function traeRole(m: Rec): Message["role"] | null {
  const role = (str(m.role) ?? str(m.type) ?? "").toLowerCase();
  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "ai" || role === "model" || role === "bot") return "assistant";
  return null;
}

/** Text + tool calls for one Trae message; Agent/SOLO plan items become tool calls. */
function traeMessage(m: Rec): Message | null {
  const role = traeRole(m);
  if (!role) return null;
  const parts: string[] = [];
  for (const field of TEXT_FIELDS) {
    const s = cleanContent(m[field]);
    if (s?.trim()) {
      parts.push(s);
      break;
    }
  }
  const toolCalls: ToolCall[] = [];
  const task = isRecord(m.agentTaskContent) ? m.agentTaskContent : undefined;
  const guideline = isRecord(task?.guideline) ? task.guideline : undefined;
  const items = Array.isArray(guideline?.planItems) ? (guideline.planItems as unknown[]) : [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const thought = cleanContent(item.thought);
    if (thought?.trim()) parts.push(thought);
    const toolName = str(item.toolName) ?? str(item.tool);
    if (toolName) {
      const args = item.toolParams ?? item.params ?? item.arguments ?? item.input;
      toolCalls.push({ name: toolName, summary: summarizeToolInput(toolName, args) ?? cleanContent(item.result)?.slice(0, 200) });
    } else {
      for (const f of ["content", "text"]) {
        const s = cleanContent(item[f]);
        if (s?.trim()) parts.push(s);
      }
    }
  }
  const timestamp = toIso(m.timestamp ?? m.createdAt ?? m.createTime ?? m.time);
  const text = parts.join("\n");
  if (role === "user") {
    const cleaned = cleanPrompt(text);
    return cleaned ? { role, text: cleaned, timestamp } : null;
  }
  if (!text.trim() && !toolCalls.length) return null;
  return { role, text, timestamp, model: str(m.model) ?? str(m.modelName), toolCalls: toolCalls.length ? toolCalls : undefined };
}

/** First icube value in the workspace db that yields at least one parseable session. */
function readIcubeValue(db: SqliteDb): unknown {
  if (!db.tables().includes("ItemTable")) return null;
  for (const key of ICUBE_EXACT_KEYS) {
    const row = db.get<{ value: unknown }>("select value from ItemTable where key = ?", key);
    const v = row ? valueToJson(row.value) : null;
    if (v && extractTraeSessions(v).length) return v;
  }
  for (const prefix of ICUBE_KEY_PREFIXES) {
    const row = db.get<{ value: unknown }>("select value from ItemTable where key like ? order by key desc limit 1", `${prefix}%`);
    const v = row ? valueToJson(row.value) : null;
    if (v && extractTraeSessions(v).length) return v;
  }
  return null;
}

/** Normalize an icube session value (already parsed JSON) into agentboard sessions. */
export function traeSessionsFromValue(value: unknown, dbPath: string, folder: string | undefined, fallbackTime: unknown): SessionDetail[] {
  const out: SessionDetail[] = [];
  for (const s of extractTraeSessions(value)) {
    const messages = s.messages.map(traeMessage).filter((m): m is Message => !!m);
    if (!messages.length) continue;
    out.push(
      buildSession({
        tool: "trae",
        surface: "ide",
        nativeId: s.id,
        title: s.title,
        project: projectFromPath(folder),
        messages,
        source: sqliteSource(dbPath, s.id),
        startedAt: s.createdAt,
        endedAt: s.updatedAt,
        fallbackTime,
        extra: { workspaceHash: path.basename(path.dirname(dbPath)) },
      }),
    );
  }
  return out;
}

function readWorkspaceDb(ws: TraeWorkspace): SessionDetail[] {
  const db = openSqliteReadOnly(ws.dbPath);
  if (!db) return [];
  try {
    const value = readIcubeValue(db);
    if (!value) return [];
    return traeSessionsFromValue(value, ws.dbPath, ws.folder, fs.statSync(ws.dbPath).mtimeMs);
  } finally {
    db.close();
  }
}

function scanIde(ctx: ScanContext): ScanResult {
  const result: ScanResult = { sessions: [], seen: [], warnings: [] };
  for (const ws of workspaces()) {
    const stat = statSafe(ws.dbPath);
    if (!stat) continue;
    const wal = statSafe(ws.dbPath + "-wal");
    const mtimeMs = Math.max(stat.mtimeMs, wal?.mtimeMs ?? 0);
    const size = stat.size + (wal?.size ?? 0);
    result.seen.push({ path: ws.dbPath, mtimeMs, size });
    if (!ctx.full && ctx.isFresh(ws.dbPath, mtimeMs, size)) continue;
    try {
      for (const d of readWorkspaceDb(ws)) result.sessions.push(stripDetail(d));
    } catch (err) {
      result.warnings.push(`${ws.dbPath}: ${(err as Error).message}`);
    }
  }
  return result;
}

// ---------- trae-agent trajectories ----------

function parseTrajectory(file: string): SessionDetail | null {
  const t = readJsonSafe<Rec>(file);
  if (!t) return null;
  const messages: Message[] = [];
  const task = str(t.task);
  if (task) messages.push({ role: "user", text: cleanPrompt(task), timestamp: str(t.start_time) });
  const steps = Array.isArray(t.agent_steps) ? (t.agent_steps as Rec[]) : [];
  for (const step of steps) {
    const ts = str(step.timestamp);
    const resp = isRecord(step.llm_response) ? step.llm_response : undefined;
    const text = extractText(resp?.content);
    const calls = Array.isArray(step.tool_calls) ? (step.tool_calls as Rec[]) : Array.isArray(resp?.tool_calls) ? (resp!.tool_calls as Rec[]) : [];
    const toolCalls = calls.map((c) => {
      const name = str(c.name) ?? "tool";
      return { name, summary: summarizeToolInput(name, c.arguments) };
    });
    if (text.trim() || toolCalls.length) messages.push({ role: "assistant", text, timestamp: ts, model: str(resp?.model) ?? str(t.model), toolCalls: toolCalls.length ? toolCalls : undefined });
    const results = Array.isArray(step.tool_results) ? (step.tool_results as Rec[]) : [];
    for (const r of results) {
      const out = str(r.result) ?? str(r.error);
      if (out) messages.push({ role: "tool", text: out.slice(0, 4000), timestamp: ts });
    }
  }
  if (messages.length === 1 && steps.length === 0) {
    // fall back to raw llm_interactions when steps were not recorded
    const inter = Array.isArray(t.llm_interactions) ? (t.llm_interactions as Rec[]) : [];
    for (const i of inter) {
      const resp = isRecord(i.response) ? i.response : undefined;
      const text = extractText(resp?.content);
      if (text.trim()) messages.push({ role: "assistant", text, timestamp: str(i.timestamp), model: str(i.model) });
    }
  }
  const final = str(t.final_result);
  if (final && !messages.some((m) => m.role === "assistant" && m.text.includes(final))) messages.push({ role: "assistant", text: final, timestamp: str(t.end_time) });
  if (!messages.length) return null;
  // trajectories/ sits inside the project that trae-cli ran in
  const dir = path.dirname(file);
  const project = path.basename(dir) === "trajectories" ? path.dirname(dir) : dir;
  return buildSession({
    tool: "trae",
    surface: "cli",
    nativeId: path.basename(file, ".json"),
    title: task ? undefined : "trae-agent run",
    project: projectFromPath(project),
    messages,
    source: fileSource(file),
    startedAt: t.start_time,
    endedAt: t.end_time,
    model: str(t.model),
    fallbackTime: fs.statSync(file).mtimeMs,
    extra: { provider: str(t.provider), success: t.success, executionTime: t.execution_time },
  });
}

export const trae: SourceAdapter = {
  id: "trae",
  name: "Trae (IDE / SOLO / trae-agent)",
  vendor: "ByteDance",
  surface: "ide",
  configHints: ["TRAE_TRAJECTORY_DIR", "AGENTBOARD_TRAE_TRAJECTORY_DIRS (path-delimited list of project dirs containing trajectories/)", "AGENTBOARD_TRAE_USER_DIRS (path-delimited list of Trae `User` dirs containing workspaceStorage/)"],
  strategies: [
    { kind: "api", status: "reserved", description: "Trae SOLO cloud tasks sync to solo.trae.ai / solo.trae.cn; no public API yet." },
    { kind: "sqlite", status: "implemented", description: "Trae IDE User/workspaceStorage/<hash>/state.vscdb ItemTable icube mementos (memento/icube-ai-agent-storage, ChatStore, icube-ai[-ng]-chat-storage-*). Reverse-engineered schema; Agent/SOLO plan items are flattened to tool calls." },
    { kind: "sqlite", status: "unavailable", description: "Trae IDE ModularData/ai-agent/database.db is SQLCipher-4 encrypted with an in-memory key; use the in-app chat export and `agentboard import markdown`." },
    { kind: "file", status: "implemented", description: "trae-agent CLI trajectories/trajectory_<timestamp>.json (agent_steps, llm_interactions)." },
  ],
  async detect() {
    const d = detection([
      ...trajectoryRoots().map((p) => ({ path: p, note: "trae-agent trajectories" })),
      ...workspaceStorageRoots().map((p) => ({ path: p, note: "Trae IDE workspaceStorage (state.vscdb)" })),
      ...ideDatabases().map((p) => ({ path: p, note: "Trae IDE (encrypted, read not supported)" })),
    ]);
    const notes: string[] = [];
    if (workspaceStorageRoots().length) notes.push("Trae IDE workspaceStorage found; chats are read from state.vscdb icube mementos (best-effort, reverse-engineered layout).");
    if (d.locations.some((l) => l.exists && l.note?.includes("encrypted"))) {
      notes.push("Trae IDE ModularData database is SQLCipher-encrypted and skipped; if a chat is missing, export it from Trae and import with `agentboard import`.");
    }
    if (notes.length) d.notes = notes;
    return d;
  },
  async scan(ctx) {
    const result = scanIde(ctx);
    const traj = await scanFiles(trajectoryFiles(), ctx, async (file) => parseTrajectory(file));
    result.sessions.push(...traj.sessions);
    result.seen.push(...traj.seen);
    result.warnings.push(...traj.warnings);
    return result;
  },
  async load(summary: SessionSummary) {
    const src = summary.source;
    if (src.kind === "sqlite") {
      const dir = path.dirname(src.path);
      return readWorkspaceDb({ dir, dbPath: src.path, folder: workspaceFolder(dir) }).find((s) => s.nativeId === summary.nativeId) ?? null;
    }
    return parseTrajectory(src.path);
  },
};
