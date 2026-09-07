import fs from "node:fs";
import path from "node:path";
import type { Message, ScanContext, ScanResult, SessionDetail, SessionSummary, SourceAdapter, ToolCall } from "../types";
import { expand, projectFromPath, statSafe, xdgDataHome } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { cleanPrompt, isRecord, normalizeRole, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { openSqliteReadOnly, type SqliteDb } from "../util/sqlite";
import { detection, sqliteSource } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * Goose (Block) has kept every session in one SQLite store since ~v1.10:
 * `<data-dir>/goose/sessions/sessions.db` with
 *  - `sessions(id, name, description, working_dir, created_at, updated_at, ...)`
 *    (`TIMESTAMP` text "YYYY-MM-DD HH:MM:SS" in UTC), grouped by `working_dir`;
 *  - `messages(id, message_id, session_id, role, content_json, created_timestamp)`
 *    where `content_json` is an array of internally tagged `MessageContent`
 *    items: `text`, `toolRequest{id, toolCall.value{name, arguments}}`,
 *    `toolResponse{id, toolResult{status, value.content[] | error}}`,
 *    `thinking` / `redactedThinking` (dropped).
 * Path candidates mirror Goose's etcetera strategy: `GOOSE_PATH_ROOT`, the XDG
 * data dir, `~/Library/Application Support/Block/goose`, `%APPDATA%\Block\goose\data`.
 */
function dbCandidates(): string[] {
  const out: string[] = [];
  const root = process.env.GOOSE_PATH_ROOT?.trim();
  if (root) out.push(path.join(expand(root), "data", "sessions", "sessions.db"));
  out.push(path.join(xdgDataHome(), "goose", "sessions", "sessions.db"));
  out.push(expand("~/.local/share/goose/sessions/sessions.db"));
  out.push(expand("~/Library/Application Support/Block/goose/sessions/sessions.db"));
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, "Block", "goose", "data", "sessions", "sessions.db"));
  return Array.from(new Set(out));
}

function dbFiles(): string[] {
  return dbCandidates().filter((p) => fs.existsSync(p));
}

/** SQLite `TIMESTAMP` text is UTC without a designator; mark it so it is not parsed as local time. */
function utcText(v: unknown): string | undefined {
  if (typeof v !== "string") return toIso(v);
  const t = v.trim().replace(" ", "T");
  if (!t) return undefined;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(t);
  return toIso(t.includes("T") && !hasZone ? `${t}Z` : t);
}

interface SessionRow {
  id: string;
  name: unknown;
  description: unknown;
  working_dir: unknown;
  created_at: unknown;
  updated_at: unknown;
  total_tokens: unknown;
  provider_name: unknown;
}

interface MessageRow {
  id: number;
  message_id: unknown;
  role: string;
  content_json: unknown;
  created_timestamp: unknown;
}

function toolResponseText(item: Rec): string {
  const result = isRecord(item.toolResult) ? item.toolResult : undefined;
  if (!result) return "";
  if (result.status === "error") return str(result.error) ?? "";
  const value = isRecord(result.value) ? result.value : undefined;
  const content = Array.isArray(value?.content) ? (value!.content as unknown[]) : [];
  return content
    .map((c) => (isRecord(c) ? str(c.text) : undefined))
    .filter((t): t is string => !!t)
    .join("\n");
}

function rowMessages(row: MessageRow): Message[] {
  const role = normalizeRole(row.role);
  if (!role || role === "system") return [];
  let items: unknown;
  try {
    items = typeof row.content_json === "string" ? JSON.parse(row.content_json) : row.content_json;
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const timestamp = toIso(row.created_timestamp);
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const toolOutputs: string[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    switch (str(item.type)) {
      case "text": {
        const t = str(item.text);
        if (t) texts.push(t);
        break;
      }
      case "toolRequest": {
        const call = isRecord(item.toolCall) ? item.toolCall : undefined;
        const value = isRecord(call?.value) ? call!.value : undefined;
        const name = str(value?.name) ?? "unknown";
        toolCalls.push({ name, summary: summarizeToolInput(name, value?.arguments) });
        break;
      }
      case "toolResponse": {
        const out = toolResponseText(item);
        if (out.trim()) toolOutputs.push(out);
        break;
      }
      default:
        break;
    }
  }
  const messages: Message[] = [];
  const text = texts.join("\n");
  if (role === "user") {
    const cleaned = cleanPrompt(text);
    if (cleaned) messages.push({ role, text: cleaned, timestamp });
  } else if (text.trim() || toolCalls.length) {
    messages.push({ role: "assistant", text, timestamp, toolCalls: toolCalls.length ? toolCalls : undefined });
  }
  for (const out of toolOutputs) messages.push({ role: "tool", text: out.slice(0, 4000), timestamp });
  return messages;
}

function sessionSelect(db: SqliteDb): string {
  const cols = new Set(db.columns("sessions"));
  const pick = (c: string) => (cols.has(c) ? `"${c}"` : `null as "${c}"`);
  return `select "id", ${pick("name")}, ${pick("description")}, ${pick("working_dir")}, ${pick("created_at")}, ${pick("updated_at")}, ${pick("total_tokens")}, ${pick("provider_name")} from sessions`;
}

function readDb(dbPath: string, onlyId?: string): SessionDetail[] {
  const db = openSqliteReadOnly(dbPath);
  if (!db) return [];
  const out: SessionDetail[] = [];
  try {
    const tables = db.tables();
    if (!tables.includes("sessions") || !tables.includes("messages")) return [];
    const mtime = fs.statSync(dbPath).mtimeMs;
    const hasMessageId = db.columns("messages").includes("message_id");
    const base = sessionSelect(db);
    const rows = onlyId === undefined ? db.all<SessionRow>(`${base} order by updated_at desc`) : db.all<SessionRow>(`${base} where id = ?`, onlyId);
    for (const s of rows) {
      const id = String(s.id);
      const msgRows = db.all<MessageRow>(`select id, ${hasMessageId ? "message_id" : "null as message_id"}, role, content_json, created_timestamp from messages where session_id = ? order by id`, id);
      const messages = msgRows.flatMap(rowMessages);
      if (!messages.length) continue;
      const cwd = str(s.working_dir)?.trim();
      const description = str(s.description)?.trim();
      const name = str(s.name)?.trim();
      out.push(
        buildSession({
          tool: "goose",
          surface: "cli",
          nativeId: id,
          title: description || name || undefined,
          project: projectFromPath(cwd || undefined),
          messages,
          source: sqliteSource(dbPath, id),
          startedAt: utcText(s.created_at),
          endedAt: utcText(s.updated_at),
          fallbackTime: mtime,
          extra: { name, totalTokens: typeof s.total_tokens === "number" ? s.total_tokens : undefined, provider: str(s.provider_name) },
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

export const goose: SourceAdapter = {
  id: "goose",
  name: "Goose",
  vendor: "Block",
  surface: "cli",
  configHints: ["GOOSE_PATH_ROOT (root holding data/sessions/sessions.db)", "XDG_DATA_HOME (Linux data dir, default ~/.local/share)"],
  strategies: [
    { kind: "api", status: "reserved", description: "goose-server (goosed) exposes /sessions over HTTP for the desktop app; not queried." },
    { kind: "sqlite", status: "implemented", description: "<data-dir>/goose/sessions/sessions.db tables sessions(id, name, description, working_dir, created_at, updated_at) + messages(session_id, role, content_json[], created_timestamp); text/toolRequest/toolResponse items, thinking dropped." },
    { kind: "file", status: "unavailable", description: "Pre-1.10 ~/.local/share/goose/sessions/*.jsonl logs were migrated into sessions.db by Goose itself." },
  ],
  async detect() {
    return detection(dbCandidates().map((p) => ({ path: p, note: "goose sessions.db" })));
  },
  async scan(ctx) {
    return scanDbs(ctx);
  },
  async load(summary: SessionSummary) {
    const src = summary.source;
    return readDb(src.path, src.locator ?? summary.nativeId).find((s) => s.nativeId === summary.nativeId) ?? null;
  },
};
