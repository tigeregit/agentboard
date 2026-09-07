import fs from "node:fs";
import path from "node:path";
import type { Message, ScanContext, ScanResult, SessionDetail, SessionSummary, Surface, ToolId } from "../types";
import { readJsonSafe } from "../util/jsonl";
import { listDirs, projectFromPath, statSafe } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { extractText, isRecord, normalizeRole, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { openSqliteReadOnly, type SqliteDb } from "../util/sqlite";
import { sqliteSource } from "./_shared";

/**
 * OpenCode's relational store (`session` -> `message` -> `part`, JSON `data`
 * columns) is shared by OpenCode itself and by the OpenCode-derived agents
 * ZCode (`~/.zcode/cli/db/db.sqlite`) and MiniMax Code. One reader serves all.
 */

type Rec = Record<string, unknown>;

interface PartRow {
  id: string;
  message_id: string;
  data: string;
}
interface MessageRow {
  id: string;
  session_id: string;
  time_created: number | string | null;
  data: string;
}
interface SessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  time_created: number | string | null;
  time_updated: number | string | null;
  parent_id: string | null;
  version?: string | null;
}

function parseJson(s: unknown): Rec {
  if (typeof s !== "string") return isRecord(s) ? s : {};
  try {
    const v = JSON.parse(s);
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

export function partsToMessage(role: string, info: Rec, parts: Rec[], fallbackTime: unknown): Message | null {
  const r = normalizeRole(role);
  if (!r) return null;
  const texts: string[] = [];
  const toolCalls: Message["toolCalls"] = [];
  let ts: string | undefined;
  for (const p of parts) {
    const type = str(p.type);
    const ptime = isRecord(p.time) ? p.time : undefined;
    ts = ts ?? toIso(ptime?.start ?? ptime?.created);
    if (type === "text") {
      const t = str(p.text);
      if (t && p.synthetic !== true) texts.push(t);
    } else if (type === "tool" || type === "tool-invocation") {
      const name = str(p.tool) ?? str(p.toolName) ?? "tool";
      const state = isRecord(p.state) ? p.state : undefined;
      toolCalls.push({ name, summary: summarizeToolInput(name, state?.input ?? p.input ?? p.args) });
    }
  }
  const infoTime = isRecord(info.time) ? info.time : undefined;
  const timestamp = toIso(infoTime?.created) ?? ts ?? toIso(fallbackTime);
  const text = texts.join("\n");
  if (!text.trim() && !toolCalls.length) return null;
  return { role: r, text, timestamp, model: str(info.modelID) ?? str(info.model), toolCalls: toolCalls.length ? toolCalls : undefined };
}

export function hasOpencodeSchema(db: SqliteDb): boolean {
  const t = new Set(db.tables());
  return t.has("session") && t.has("message") && t.has("part");
}

export interface FamilyOptions {
  tool: ToolId;
  surface: Surface;
  dbPath: string;
}

export function readOpencodeDb(opts: FamilyOptions, onlySessionId?: string): SessionDetail[] {
  const db = openSqliteReadOnly(opts.dbPath);
  if (!db) return [];
  try {
    if (!hasOpencodeSchema(db)) return [];
    const cols = new Set(db.columns("session"));
    const sessionCols = ["id", "directory", "title", "time_created", "time_updated", cols.has("parent_id") ? "parent_id" : "null as parent_id", cols.has("version") ? "version" : "null as version"];
    const sessions = onlySessionId
      ? db.all<SessionRow>(`select ${sessionCols.join(",")} from session where id = ?`, onlySessionId)
      : db.all<SessionRow>(`select ${sessionCols.join(",")} from session`);
    if (!sessions.length) return [];

    const messagesBySession = new Map<string, MessageRow[]>();
    const msgRows = onlySessionId
      ? db.all<MessageRow>("select id, session_id, time_created, data from message where session_id = ? order by time_created, id", onlySessionId)
      : db.all<MessageRow>("select id, session_id, time_created, data from message order by time_created, id");
    for (const m of msgRows) {
      const list = messagesBySession.get(m.session_id) ?? [];
      list.push(m);
      messagesBySession.set(m.session_id, list);
    }
    const partsByMessage = new Map<string, Rec[]>();
    const partRows = onlySessionId
      ? db.all<PartRow>("select p.id, p.message_id, p.data from part p join message m on m.id = p.message_id where m.session_id = ? order by p.id", onlySessionId)
      : db.all<PartRow>("select id, message_id, data from part order by id");
    for (const p of partRows) {
      const list = partsByMessage.get(p.message_id) ?? [];
      list.push(parseJson(p.data));
      partsByMessage.set(p.message_id, list);
    }

    let modelUsage: Map<string, string> | undefined;
    if (db.tables().includes("model_usage")) {
      modelUsage = new Map();
      for (const row of db.all<{ session_id: string; model_id: string }>("select session_id, model_id from model_usage")) {
        if (!modelUsage.has(row.session_id)) modelUsage.set(row.session_id, row.model_id);
      }
    }

    const out: SessionDetail[] = [];
    for (const s of sessions) {
      const messages: Message[] = [];
      for (const m of messagesBySession.get(s.id) ?? []) {
        const info = parseJson(m.data);
        const msg = partsToMessage(str(info.role) ?? "", info, partsByMessage.get(m.id) ?? [], m.time_created);
        if (msg) messages.push(msg);
      }
      if (!messages.length) continue;
      out.push(
        buildSession({
          tool: opts.tool,
          surface: opts.surface,
          nativeId: s.id,
          title: s.title,
          project: projectFromPath(s.directory),
          messages,
          source: sqliteSource(opts.dbPath, s.id),
          startedAt: s.time_created,
          endedAt: s.time_updated,
          model: modelUsage?.get(s.id),
          parentKey: s.parent_id ? `${opts.tool}:${s.parent_id}` : undefined,
          extra: s.version ? { version: s.version } : undefined,
        }),
      );
    }
    return out;
  } finally {
    db.close();
  }
}

/** Legacy per-file JSON storage (`storage/session`, `storage/message`, `storage/part`). */
export function readLegacyStorage(opts: { tool: ToolId; surface: Surface; storageDir: string }, onlySessionId?: string): SessionDetail[] {
  const sessionRoot = path.join(opts.storageDir, "session");
  const out: SessionDetail[] = [];
  const sessionFiles: string[] = [];
  for (const dir of listDirs(sessionRoot)) {
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) sessionFiles.push(path.join(dir, f));
  }
  for (const sf of sessionFiles) {
    const info = readJsonSafe<Rec>(sf);
    if (!info) continue;
    const id = str(info.id) ?? path.basename(sf, ".json");
    if (onlySessionId && id !== onlySessionId) continue;
    const msgDir = path.join(opts.storageDir, "message", id);
    const messages: Message[] = [];
    for (const mf of listJson(msgDir)) {
      const m = readJsonSafe<Rec>(mf);
      if (!m) continue;
      const mid = str(m.id) ?? path.basename(mf, ".json");
      const parts = listJson(path.join(opts.storageDir, "part", mid))
        .map((pf) => readJsonSafe<Rec>(pf))
        .filter((p): p is Rec => !!p);
      // very old versions embed `parts` in the message itself
      const embedded = Array.isArray(m.parts) ? (m.parts as Rec[]) : [];
      const msg = partsToMessage(str(m.role) ?? "", m, parts.length ? parts : embedded, undefined);
      if (msg) messages.push(msg);
    }
    if (!messages.length) continue;
    const time = isRecord(info.time) ? info.time : {};
    out.push(
      buildSession({
        tool: opts.tool,
        surface: opts.surface,
        nativeId: id,
        title: str(info.title),
        project: projectFromPath(str(info.directory)),
        messages,
        source: { kind: "file", path: sf },
        startedAt: time.created,
        endedAt: time.updated,
      }),
    );
  }
  return out;
}

function listJson(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Scan helper for a set of candidate DB files with freshness tracking. */
export function scanDbFiles(ctx: ScanContext, dbs: FamilyOptions[]): ScanResult {
  const result: ScanResult = { sessions: [], seen: [], warnings: [] };
  for (const opts of dbs) {
    const stat = statSafe(opts.dbPath);
    if (!stat) continue;
    // WAL sidecar changes don't bump the main file mtime; fold it into the fingerprint.
    const wal = statSafe(opts.dbPath + "-wal");
    const mtimeMs = Math.max(stat.mtimeMs, wal?.mtimeMs ?? 0);
    const size = stat.size + (wal?.size ?? 0);
    result.seen.push({ path: opts.dbPath, mtimeMs, size });
    if (!ctx.full && ctx.isFresh(opts.dbPath, mtimeMs, size)) continue;
    try {
      for (const d of readOpencodeDb(opts)) result.sessions.push(stripDetail(d));
    } catch (err) {
      result.warnings.push(`${opts.dbPath}: ${(err as Error).message}`);
    }
  }
  return result;
}

export function loadFromDb(summary: SessionSummary, surface: Surface): SessionDetail | null {
  if (summary.source.kind !== "sqlite") return null;
  const list = readOpencodeDb({ tool: summary.tool, surface, dbPath: summary.source.path }, summary.nativeId);
  return list[0] ?? null;
}

/** Text extraction for OpenCode HTTP API message payloads (`{info, parts}`). */
export function apiMessageToMessage(entry: Rec): Message | null {
  const info = isRecord(entry.info) ? entry.info : entry;
  const parts = Array.isArray(entry.parts) ? (entry.parts as Rec[]) : [];
  const msg = partsToMessage(str(info.role) ?? "", info, parts, undefined);
  if (msg) return msg;
  const text = extractText(info.content);
  const role = normalizeRole(info.role);
  return role && text ? { role, text } : null;
}
