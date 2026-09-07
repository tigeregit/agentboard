import fs from "node:fs";
import path from "node:path";
import type { ScanContext, ScanResult, SessionDetail, SessionSummary, SourceAdapter } from "../types";
import { projectFromPath, statSafe } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { openSqliteReadOnly, type SqliteDb } from "../util/sqlite";
import { detection, sqliteSource } from "./_shared";
import { convertConversationState, dataLocalDirs, keyHash, parseConversationState } from "./q-conversation";

/**
 * Amazon Q Developer CLI (`q chat`) keeps one resumable conversation per
 * working directory in `<data_local_dir>/amazon-q/data.sqlite3`, table
 * `conversations(key TEXT PRIMARY KEY, value TEXT)` where `key` is the cwd and
 * `value` a serialized `ConversationState` (see q-conversation.ts). The v1
 * table has no timestamps: session bounds come from `history[].user.timestamp`
 * and fall back to the database mtime.
 */
function dbCandidates(): string[] {
  return dataLocalDirs().map((d) => path.join(d, "amazon-q", "data.sqlite3"));
}

function dbFiles(): string[] {
  return dbCandidates().filter((p) => fs.existsSync(p));
}

function sessionFromRow(dbPath: string, key: string, value: unknown, fallbackTime: number): SessionDetail | null {
  const state = parseConversationState(value);
  if (!state) return null;
  const conv = convertConversationState(state);
  if (!conv.messages.length) return null;
  return buildSession({
    tool: "amazon-q",
    surface: "cli",
    nativeId: conv.conversationId ?? keyHash(key),
    project: projectFromPath(key),
    messages: conv.messages,
    source: sqliteSource(dbPath, key),
    model: conv.model,
    fallbackTime,
    extra: { cwd: key },
  });
}

function readDb(dbPath: string, onlyKey?: string): SessionDetail[] {
  const db: SqliteDb | null = openSqliteReadOnly(dbPath);
  if (!db) return [];
  const out: SessionDetail[] = [];
  try {
    if (!db.tables().includes("conversations")) return [];
    const mtime = fs.statSync(dbPath).mtimeMs;
    const rows = onlyKey === undefined ? db.all<{ key: string; value: unknown }>("select key, value from conversations") : db.all<{ key: string; value: unknown }>("select key, value from conversations where key = ?", onlyKey);
    for (const row of rows) {
      const d = sessionFromRow(dbPath, String(row.key), row.value, mtime);
      if (d) out.push(d);
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

export const amazonQ: SourceAdapter = {
  id: "amazon-q",
  name: "Amazon Q CLI",
  vendor: "AWS",
  surface: "cli",
  configHints: ["XDG_DATA_HOME (Linux data dir, default ~/.local/share)", "LOCALAPPDATA (Windows data dir)"],
  strategies: [
    { kind: "api", status: "reserved", description: "Amazon Q CLI has no local query API; `q chat --resume` reads the same SQLite row." },
    { kind: "sqlite", status: "implemented", description: "<data_local_dir>/amazon-q/data.sqlite3 table conversations(key=cwd, value=ConversationState JSON); one conversation per cwd, history[] of {user,assistant} turns." },
  ],
  async detect() {
    return detection(dbCandidates().map((p) => ({ path: p, note: "q chat conversations (one per cwd)" })));
  },
  async scan(ctx) {
    return scanDbs(ctx);
  },
  async load(summary: SessionSummary) {
    const src = summary.source;
    return readDb(src.path, src.locator).find((s) => s.nativeId === summary.nativeId) ?? null;
  },
};
