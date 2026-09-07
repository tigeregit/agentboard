import fs from "node:fs";
import path from "node:path";
import type { ScanContext, ScanResult, SessionDetail, SessionSummary, SourceAdapter } from "../types";
import { projectFromPath, statSafe } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { openSqliteReadOnly, type SqliteDb } from "../util/sqlite";
import { detection, sqliteSource } from "./_shared";
import { convertConversationState, dataLocalDirs, keyHash, parseConversationState } from "./q-conversation";

/**
 * Kiro CLI (the rebranded Amazon Q CLI) stores chats in
 * `<data_local_dir>/kiro-cli/data.sqlite3`, table
 * `conversations_v2(key, conversation_id, value, created_at, updated_at)`:
 * `key` is the cwd, `value` the same serialized `ConversationState` as Amazon Q
 * (see q-conversation.ts) and the timestamps are epoch milliseconds. Many
 * conversations may share one cwd. Databases that still only carry the v1
 * `conversations(key, value)` table are read the Amazon Q way.
 */
function dbCandidates(): string[] {
  return dataLocalDirs().map((d) => path.join(d, "kiro-cli", "data.sqlite3"));
}

function dbFiles(): string[] {
  return dbCandidates().filter((p) => fs.existsSync(p));
}

interface V2Row {
  key: string;
  conversation_id: string;
  value: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function sessionFromRow(dbPath: string, row: V2Row, fallbackTime: number): SessionDetail | null {
  const state = parseConversationState(row.value);
  if (!state) return null;
  const conv = convertConversationState(state);
  if (!conv.messages.length) return null;
  const id = row.conversation_id ? String(row.conversation_id) : conv.conversationId ?? keyHash(row.key);
  return buildSession({
    tool: "kiro",
    surface: "cli",
    nativeId: id,
    project: projectFromPath(row.key),
    messages: conv.messages,
    source: sqliteSource(dbPath, id),
    startedAt: row.created_at,
    endedAt: row.updated_at,
    model: conv.model,
    fallbackTime,
    extra: { cwd: row.key },
  });
}

function readDb(dbPath: string, onlyId?: string): SessionDetail[] {
  const db: SqliteDb | null = openSqliteReadOnly(dbPath);
  if (!db) return [];
  const out: SessionDetail[] = [];
  try {
    const tables = db.tables();
    const mtime = fs.statSync(dbPath).mtimeMs;
    let rows: V2Row[] = [];
    if (tables.includes("conversations_v2")) {
      const sql = "select key, conversation_id, value, created_at, updated_at from conversations_v2";
      rows = onlyId === undefined ? db.all<V2Row>(`${sql} order by updated_at desc`) : db.all<V2Row>(`${sql} where conversation_id = ?`, onlyId);
    } else if (tables.includes("conversations")) {
      const v1 = db.all<{ key: string; value: unknown }>("select key, value from conversations");
      rows = v1.map((r) => ({ key: String(r.key), conversation_id: "", value: r.value, created_at: undefined, updated_at: undefined }));
    }
    for (const row of rows) {
      const d = sessionFromRow(dbPath, { ...row, key: String(row.key) }, mtime);
      if (d && (onlyId === undefined || d.nativeId === onlyId)) out.push(d);
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

export const kiro: SourceAdapter = {
  id: "kiro",
  name: "Kiro CLI",
  vendor: "AWS",
  surface: "cli",
  configHints: ["XDG_DATA_HOME (Linux data dir, default ~/.local/share)", "LOCALAPPDATA (Windows data dir)"],
  strategies: [
    { kind: "api", status: "reserved", description: "Kiro CLI has no local query API; `kiro-cli chat --resume` reads the same SQLite rows." },
    { kind: "sqlite", status: "implemented", description: "<data_local_dir>/kiro-cli/data.sqlite3 table conversations_v2(key=cwd, conversation_id, value=ConversationState JSON, created_at, updated_at ms); v1 conversations(key, value) fallback." },
  ],
  async detect() {
    return detection(dbCandidates().map((p) => ({ path: p, note: "kiro-cli chat conversations" })));
  },
  async scan(ctx) {
    return scanDbs(ctx);
  },
  async load(summary: SessionSummary) {
    const src = summary.source;
    return readDb(src.path, src.locator ?? summary.nativeId).find((s) => s.nativeId === summary.nativeId) ?? null;
  },
};
