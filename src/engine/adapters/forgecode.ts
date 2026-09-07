import fs from "node:fs";
import path from "node:path";
import type { Message, ProjectRef, ScanContext, ScanResult, SessionDetail, SessionSummary, SourceAdapter, ToolCall } from "../types";
import { expand, home, projectFromPath, statSafe } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { cleanPrompt, extractText, extractToolCalls, isRecord, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { openSqliteReadOnly, type SqliteDb } from "../util/sqlite";
import { detection, sqliteSource } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * ForgeCode (Antinomy) keeps its transcripts in `<$FORGE_CONFIG|~/.forge>/.forge.db`,
 * table `conversations` with `id|conversation_id`, `workspace_id`, `title?`,
 * `context` (JSON), `metrics?`, `created_at|createdAt?`, `updated_at|updatedAt?`
 * (column names vary across versions and are resolved from `pragma table_info`).
 * `context` is either an array of entries or `{ messages: [...] }`; each entry
 * is one `ContextMessage` in one of three serializations:
 *   `{ "message": { "text" | "tool" | "image": payload } }`, `{ "Text" | "Tool" | "Image": payload }`
 *   or a flat `{ "type": ..., ... }` object.
 * Text payloads carry `role`, `content` (string or blocks), optional
 * `tool_calls[]{name, call_id, arguments}` and `model`; tool payloads carry
 * `name`, `call_id` and either an `output`/`result` (tool result) or `input`
 * (tool call). The project is the most-voted `cwd` found anywhere in a
 * workspace's context JSON; `logs/` and `.forge_history` are detection-only.
 */
function baseDirs(): string[] {
  const out: string[] = [];
  const cfg = process.env.FORGE_CONFIG?.trim();
  if (cfg) out.push(expand(cfg));
  out.push(expand("~/.forge"));
  return Array.from(new Set(out));
}

function dbCandidates(): string[] {
  return baseDirs().map((d) => path.join(d, ".forge.db"));
}

function dbFiles(): string[] {
  return dbCandidates().filter((p) => fs.existsSync(p));
}

interface Columns {
  id: string;
  workspace: string;
  title?: string;
  context: string;
  metrics?: string;
  createdAt?: string;
  updatedAt?: string;
}

const quote = (n: string) => `"${n.replace(/"/g, '""')}"`;
const castText = (n: string | undefined, alias: string) => (n ? `cast(${quote(n)} as text) as ${alias}` : `null as ${alias}`);

function resolveColumns(db: SqliteDb): Columns | null {
  if (!db.tables().includes("conversations")) return null;
  const names = new Set(db.columns("conversations"));
  const pick = (...cands: string[]) => cands.find((c) => names.has(c));
  const id = pick("conversation_id", "id");
  const workspace = pick("workspace_id");
  const context = pick("context");
  if (!id || !workspace || !context) return null;
  return { id, workspace, title: pick("title"), context, metrics: pick("metrics"), createdAt: pick("created_at", "createdAt"), updatedAt: pick("updated_at", "updatedAt") };
}

interface Row {
  id: string;
  workspace_id: string;
  title: unknown;
  context: unknown;
  metrics: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function selectRows(db: SqliteDb, c: Columns, onlyId?: string): Row[] {
  const sql = `select ${castText(c.id, "id")}, ${castText(c.workspace, "workspace_id")}, ${castText(c.title, "title")}, ${castText(c.context, "context")}, ${castText(c.metrics, "metrics")}, ${castText(c.createdAt, "created_at")}, ${castText(c.updatedAt, "updated_at")} from conversations where ${quote(c.workspace)} is not null and ${quote(c.context)} is not null`;
  return onlyId === undefined ? db.all<Row>(sql) : db.all<Row>(`${sql} and cast(${quote(c.id)} as text) = ?`, onlyId);
}

/** Forge timestamps: RFC3339, "YYYY-MM-DD HH:MM:SS" (UTC) or epoch seconds/ms. */
function forgeTime(v: unknown): string | undefined {
  if (typeof v !== "string") return toIso(v);
  const t = v.trim();
  if (!t) return undefined;
  if (/^-?\d+$/.test(t)) return toIso(Number(t));
  const iso = t.replace(" ", "T");
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso);
  return toIso(iso.includes("T") && !hasZone ? `${iso}Z` : iso);
}

function parseContext(raw: unknown): { entries: Rec[]; root: unknown } {
  let value: unknown = raw;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) value = Buffer.from(value as Uint8Array).toString("utf8");
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { entries: [], root: null };
    }
  }
  if (Array.isArray(value)) return { entries: value.filter(isRecord), root: value };
  if (isRecord(value) && Array.isArray(value.messages)) return { entries: (value.messages as unknown[]).filter(isRecord), root: value };
  return { entries: [], root: value };
}

type Kind = "text" | "tool" | "image";

function variant(entry: Rec): { kind: Kind; payload: unknown } {
  const m = isRecord(entry.message) ? entry.message : undefined;
  if (m) {
    if ("text" in m) return { kind: "text", payload: m.text };
    if ("tool" in m) return { kind: "tool", payload: m.tool };
    if ("image" in m) return { kind: "image", payload: m.image };
  }
  if ("Text" in entry) return { kind: "text", payload: entry.Text };
  if ("Tool" in entry) return { kind: "tool", payload: entry.Tool };
  if ("Image" in entry) return { kind: "image", payload: entry.Image };
  const type = str(entry.type)?.toLowerCase();
  if (type === "tool") return { kind: "tool", payload: entry };
  if (type === "image") return { kind: "image", payload: entry };
  return { kind: "text", payload: entry };
}

const ENTRY_KEYS = ["usage", "timestamp", "created_at", "createdAt", "time", "cost", "cost_usd", "costUSD", "model"];

function mergePayload(entry: Rec, payload: unknown): Rec {
  const merged: Rec = isRecord(payload) ? { ...payload } : typeof payload === "string" ? { content: payload } : {};
  for (const k of ENTRY_KEYS) if (!(k in merged) && k in entry) merged[k] = entry[k];
  return merged;
}

function first(obj: Rec, keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

function firstString(obj: Rec, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/** Text of a payload: `text`, string `content`, or the text blocks of an array `content`. */
function payloadText(p: unknown): string {
  if (typeof p === "string") return p;
  if (!isRecord(p)) return "";
  const text = str(p.text);
  if (text !== undefined) return text;
  const content = p.content ?? p.message ?? p.body ?? p.value;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return extractText(content);
  const raw = str(p.raw_content) ?? str(p.rawContent);
  return raw ?? "";
}

function resultText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (isRecord(v) && Array.isArray(v.values)) {
    const t = extractText(v.values);
    if (t.trim()) return t;
  }
  const t = extractText(v);
  if (t.trim()) return t;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function role(p: Rec): string {
  return (firstString(p, ["role", "speaker", "author"]) ?? "").trim().toLowerCase();
}

function costOf(p: Rec): number | undefined {
  const usage = isRecord(p.usage) ? p.usage : undefined;
  const raw = first(usage ?? {}, ["cost", "cost_usd", "costUSD"]) ?? first(p, ["cost", "cost_usd", "costUSD"]);
  const v = isRecord(raw) ? first(raw, ["actual", "value", "amount"]) : raw;
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() && !isNaN(Number(v))) return Number(v);
  return undefined;
}

function textMessage(p: Rec, timestamp: string | undefined, model: string | undefined): Message | null {
  const r = role(p) || "user";
  const text = payloadText(p);
  if (r === "system") return null;
  if (r === "tool") return text.trim() ? { role: "tool", text: text.slice(0, 4000), timestamp } : null;
  const toolCalls: ToolCall[] = [];
  const calls = p.tool_calls ?? p.toolCalls;
  if (Array.isArray(calls)) {
    for (const tc of calls) {
      if (!isRecord(tc)) continue;
      const name = str(tc.name);
      if (!name) continue;
      toolCalls.push({ name, summary: summarizeToolInput(name, first(tc, ["arguments", "input", "args", "params"])) });
    }
  }
  const content = p.content ?? p.message ?? p.body ?? p.value;
  if (Array.isArray(content)) toolCalls.push(...extractToolCalls(content));
  if (r === "assistant") {
    if (!text.trim() && !toolCalls.length) return null;
    return { role: "assistant", text, timestamp, model, toolCalls: toolCalls.length ? toolCalls : undefined };
  }
  const cleaned = cleanPrompt(text);
  return cleaned ? { role: "user", text: cleaned, timestamp } : null;
}

function toolMessage(p: Rec, timestamp: string | undefined, model: string | undefined): Message | null {
  const hint = role(p);
  const name = firstString(p, ["name", "tool_name", "toolName"]) ?? "tool";
  const input = first(p, ["input", "arguments", "args", "params"]) ?? first(p, ["payload"]);
  const result = first(p, ["tool_result", "toolResult", "result", "output"]) ?? first(p, ["content"]);
  const isResult = hint === "tool" || hint === "user" || (result !== undefined && input === undefined);
  if (isResult) {
    const text = resultText(result ?? p);
    return text.trim() ? { role: "tool", text: text.slice(0, 4000), timestamp } : null;
  }
  return { role: "assistant", text: payloadText(p), timestamp, model, toolCalls: [{ name, summary: summarizeToolInput(name, input) }] };
}

function imageMessage(p: Rec, timestamp: string | undefined): Message | null {
  const r = role(p) || "user";
  if (r === "system") return null;
  const src = isRecord(p.source) ? p.source : p;
  const label = firstString(src, ["path", "url", "mime_type", "mimeType", "media_type"]) ?? "image";
  const text = `[image: ${label}]`;
  return r === "assistant" ? { role: "assistant", text, timestamp } : { role: "user", text, timestamp };
}

interface Converted {
  messages: Message[];
  model?: string;
  costUsd?: number;
}

/** Map one conversation's context entries to messages (mirrors CCHV's map_context_entry). */
export function convertForgeContext(entries: Rec[], createdAt: string | undefined, updatedAt: string | undefined): Converted {
  const messages: Message[] = [];
  let model: string | undefined;
  let cost = 0;
  let sawCost = false;
  entries.forEach((entry, index) => {
    const { kind, payload } = variant(entry);
    const p = mergePayload(entry, payload);
    const timestamp = forgeTime(first(p, ["timestamp", "created_at", "createdAt", "time"])) ?? (index === 0 && createdAt ? createdAt : updatedAt ?? createdAt);
    const m = firstString(p, ["model", "model_id", "modelId"]);
    if (m) model = m;
    const c = costOf(p);
    if (c !== undefined) {
      cost += c;
      sawCost = true;
    }
    const msg = kind === "tool" ? toolMessage(p, timestamp, m) : kind === "image" ? imageMessage(p, timestamp) : textMessage(p, timestamp, m);
    if (msg) messages.push(msg);
  });
  return { messages, model, costUsd: sawCost ? cost : undefined };
}

function collectCwds(value: unknown, votes: Map<string, number>, depth = 0) {
  if (depth > 12) return;
  if (Array.isArray(value)) {
    for (const v of value) collectCwds(v, votes, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  const cwd = str(value.cwd)?.trim();
  if (cwd) votes.set(cwd, (votes.get(cwd) ?? 0) + 1);
  for (const v of Object.values(value)) collectCwds(v, votes, depth + 1);
}

/** Most-voted cwd (ties: shorter path, then lexicographically greater), ignoring the bare home dir. */
function bestCwd(votes: Map<string, number>): string | undefined {
  const h = home().replace(/[\\/]+$/, "");
  let best: [string, number] | undefined;
  for (const [cwd, n] of votes) {
    if (cwd.replace(/[\\/]+$/, "") === h) continue;
    if (!best || n > best[1] || (n === best[1] && (cwd.length < best[0].length || (cwd.length === best[0].length && cwd > best[0])))) best = [cwd, n];
  }
  return best?.[0];
}

function workspaceProject(workspaceId: string, cwd: string | undefined): ProjectRef {
  if (cwd) return projectFromPath(cwd);
  return { path: `forgecode://workspace/${workspaceId}`, name: `Workspace ${workspaceId}` };
}

function readDb(dbPath: string, onlyId?: string): SessionDetail[] {
  const db = openSqliteReadOnly(dbPath);
  if (!db) return [];
  const out: SessionDetail[] = [];
  try {
    const cols = resolveColumns(db);
    if (!cols) return [];
    const mtime = fs.statSync(dbPath).mtimeMs;
    // cwd votes are aggregated per workspace, so the project is resolved across all rows.
    const all = selectRows(db, cols);
    const parsed = all.map((row) => ({ row, ctx: parseContext(row.context) }));
    const votesByWorkspace = new Map<string, Map<string, number>>();
    for (const p of parsed) {
      const ws = String(p.row.workspace_id);
      const votes = votesByWorkspace.get(ws) ?? new Map<string, number>();
      collectCwds(p.ctx.root, votes);
      votesByWorkspace.set(ws, votes);
    }
    const cwdByWorkspace = new Map<string, string | undefined>();
    for (const [ws, votes] of votesByWorkspace) cwdByWorkspace.set(ws, bestCwd(votes));
    for (const { row, ctx } of parsed) {
      const id = String(row.id);
      if (onlyId !== undefined && id !== onlyId) continue;
      const workspaceId = String(row.workspace_id);
      const createdAt = forgeTime(row.created_at);
      const updatedAt = forgeTime(row.updated_at);
      const conv = convertForgeContext(ctx.entries, createdAt, updatedAt);
      if (!conv.messages.length) continue;
      out.push(
        buildSession({
          tool: "forgecode",
          surface: "cli",
          nativeId: id,
          title: str(row.title)?.trim() || undefined,
          project: workspaceProject(workspaceId, cwdByWorkspace.get(workspaceId)),
          messages: conv.messages,
          source: sqliteSource(dbPath, id),
          startedAt: createdAt,
          endedAt: updatedAt,
          model: conv.model,
          fallbackTime: mtime,
          extra: { workspaceId, costUsd: conv.costUsd },
        }),
      );
    }
  } finally {
    db.close();
  }
  return out;
}

function scanDbs(ctx: ScanContext): ScanResult {
  const result: ScanResult = { sessions: [], seen: [], warnings: [] };
  for (const dbPath of dbFiles()) {
    const stat = statSafe(dbPath);
    if (!stat) continue;
    const wal = statSafe(dbPath + "-wal");
    const mtimeMs = Math.max(stat.mtimeMs, wal?.mtimeMs ?? 0);
    const size = stat.size + (wal?.size ?? 0);
    result.seen.push({ path: dbPath, mtimeMs, size });
    if (!ctx.full && ctx.isFresh(dbPath, mtimeMs, size)) continue;
    try {
      for (const d of readDb(dbPath)) result.sessions.push(stripDetail(d));
    } catch (err) {
      result.warnings.push(`${dbPath}: ${(err as Error).message}`);
    }
  }
  return result;
}

export const forgecode: SourceAdapter = {
  id: "forgecode",
  name: "ForgeCode",
  vendor: "Antinomy",
  surface: "cli",
  configHints: ["FORGE_CONFIG (base dir holding .forge.db; default ~/.forge)"],
  strategies: [
    { kind: "api", status: "reserved", description: "Forge has no local query API; `forge --resume`/`/conversation` read the same SQLite rows." },
    { kind: "sqlite", status: "implemented", description: "<FORGE_CONFIG|~/.forge>/.forge.db table conversations(id|conversation_id, workspace_id, title?, context JSON, metrics?, created_at?, updated_at?); context entries Text/Tool/Image in message.{text,tool,image} or Text/Tool/Image or type form." },
    { kind: "file", status: "unavailable", description: "~/.forge/logs/ and ~/.forge/.forge_history are detection-only artifacts (no transcript content)." },
  ],
  async detect() {
    const locs: { path: string; note?: string }[] = [];
    for (const base of baseDirs()) {
      locs.push({ path: path.join(base, ".forge.db"), note: "conversations db" });
      locs.push({ path: path.join(base, "logs"), note: "logs (detection only)" });
      locs.push({ path: path.join(base, ".forge_history"), note: "prompt history (detection only)" });
    }
    return detection(locs);
  },
  async scan(ctx) {
    return scanDbs(ctx);
  },
  async load(summary: SessionSummary) {
    const src = summary.source;
    return readDb(src.path, src.locator ?? summary.nativeId).find((s) => s.nativeId === summary.nativeId) ?? null;
  },
};
