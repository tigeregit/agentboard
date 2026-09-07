import fs from "node:fs";
import path from "node:path";
import type { Detection, Message, ScanContext, ScanResult, SessionDetail, SessionSummary, SourceAdapter, ToolCall } from "../types";
import { expand, home, projectFromPath, statSafe } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { cleanPrompt, isRecord, normalizeRole, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { openSqliteReadOnly, type SqliteDb } from "../util/sqlite";
import { sqliteSource } from "./_shared";

/**
 * Crush (Charmbracelet) stores history per project in `<project>/.crush/crush.db`;
 * there is no global root, so discovery is a depth-limited (4) scan of
 * `~/{client,projects,code,src,dev,work,repos}` and `$HOME` (skipping dot
 * dirs, node_modules/target/dist/build and symlinks, max 200 dbs), plus any
 * roots listed in `AGENTBOARD_CRUSH_DIRS`.
 * Tables: `sessions(id, parent_session_id?, title, created_at, updated_at, ...)`
 * and `messages(id, session_id, role, parts, model?, provider?, created_at)`;
 * `parts` is a JSON array of `{type, data}` items: `text{text}`,
 * `tool_call{id, name, input (JSON string)}`, `tool_result{tool_call_id,
 * content, is_error}`, `reasoning{thinking}` (dropped), `finish`/`image_url`/
 * `binary` (ignored). Epochs are seconds (or ms in newer builds).
 */
const MAX_DBS = 200;
const MAX_DEPTH = 4;
const CODE_ROOTS = ["client", "projects", "code", "src", "dev", "work", "repos"];
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build"]);

function isDir(p: string): boolean {
  return statSafe(p)?.isDirectory() ?? false;
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function searchRoots(): string[] {
  const h = home();
  const out: string[] = [];
  for (const extra of process.env.AGENTBOARD_CRUSH_DIRS?.split(path.delimiter) ?? []) if (extra.trim()) out.push(expand(extra.trim()));
  for (const sub of CODE_ROOTS) {
    const d = path.join(h, sub);
    if (isDir(d)) out.push(d);
  }
  out.push(h);
  return Array.from(new Set(out));
}

function discoverDbs(max = MAX_DBS): string[] {
  const found = new Set<string>();
  const visit = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || found.size >= max || isSymlink(dir)) return;
    const db = path.join(dir, ".crush", "crush.db");
    if (statSafe(db)?.isFile() && !isSymlink(db)) found.add(db);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.size >= max) return;
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      visit(path.join(dir, e.name), depth + 1);
    }
  };
  for (const root of searchRoots()) {
    if (found.size >= max) break;
    visit(root, 0);
  }
  return Array.from(found).sort();
}

function projectDirOf(dbPath: string): string {
  return path.dirname(path.dirname(dbPath));
}

interface SessionRow {
  id: string;
  title: unknown;
  created_at: unknown;
  updated_at: unknown;
  parent_session_id: unknown;
}

interface MessageRow {
  id: string;
  role: string;
  parts: unknown;
  created_at: unknown;
  model: unknown;
}

function partsToMessages(row: MessageRow): Message[] {
  const role = normalizeRole(row.role);
  if (!role || role === "system") return [];
  let items: unknown;
  try {
    items = typeof row.parts === "string" ? JSON.parse(row.parts) : row.parts;
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const timestamp = toIso(row.created_at);
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const results: string[] = [];
  for (const part of items) {
    if (!isRecord(part)) continue;
    const data = isRecord(part.data) ? part.data : undefined;
    switch (str(part.type)) {
      case "text": {
        const t = str(data?.text);
        if (t) texts.push(t);
        break;
      }
      case "tool_call": {
        if (!data) break;
        const name = str(data.name) ?? "unknown";
        toolCalls.push({ name, summary: summarizeToolInput(name, data.input) });
        break;
      }
      case "tool_result": {
        const content = str(data?.content) ?? "";
        if (content.trim()) results.push(content);
        break;
      }
      default:
        break;
    }
  }
  const out: Message[] = [];
  const text = texts.join("\n");
  if (role === "user") {
    const cleaned = cleanPrompt(text);
    if (cleaned) out.push({ role: "user", text: cleaned, timestamp });
  } else if (role === "assistant" && (text.trim() || toolCalls.length)) {
    out.push({ role: "assistant", text, timestamp, model: str(row.model), toolCalls: toolCalls.length ? toolCalls : undefined });
  }
  for (const r of results) out.push({ role: "tool", text: r.slice(0, 4000), timestamp });
  return out;
}

function readDb(dbPath: string, onlyId?: string): SessionDetail[] {
  const db: SqliteDb | null = openSqliteReadOnly(dbPath);
  if (!db) return [];
  const out: SessionDetail[] = [];
  try {
    const tables = db.tables();
    if (!tables.includes("sessions") || !tables.includes("messages")) return [];
    const mtime = fs.statSync(dbPath).mtimeMs;
    const sCols = new Set(db.columns("sessions"));
    const mCols = new Set(db.columns("messages"));
    const parentCol = sCols.has("parent_session_id") ? '"parent_session_id"' : "null as parent_session_id";
    const modelCol = mCols.has("model") ? '"model"' : "null as model";
    const base = `select "id", "title", "created_at", "updated_at", ${parentCol} from sessions`;
    const rows = onlyId === undefined ? db.all<SessionRow>(`${base} order by updated_at desc`) : db.all<SessionRow>(`${base} where id = ?`, onlyId);
    const project = projectFromPath(projectDirOf(dbPath));
    for (const s of rows) {
      const id = String(s.id);
      const msgRows = db.all<MessageRow>(`select "id", "role", "parts", "created_at", ${modelCol} from messages where session_id = ? order by created_at, id`, id);
      const messages = msgRows.flatMap(partsToMessages);
      if (!messages.length) continue;
      const parent = str(s.parent_session_id)?.trim();
      out.push(
        buildSession({
          tool: "crush",
          surface: "cli",
          nativeId: id,
          title: str(s.title)?.trim() || undefined,
          project,
          messages,
          source: sqliteSource(dbPath, id),
          startedAt: s.created_at,
          endedAt: s.updated_at,
          parentKey: parent ? `crush:${parent}` : undefined,
          fallbackTime: mtime,
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
  for (const dbPath of discoverDbs()) {
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

export const crush: SourceAdapter = {
  id: "crush",
  name: "Crush",
  vendor: "Charm",
  surface: "cli",
  configHints: ["AGENTBOARD_CRUSH_DIRS (path-delimited list of extra roots to scan for <project>/.crush/crush.db)"],
  strategies: [
    { kind: "api", status: "reserved", description: "Crush has no daemon / query API; sessions live only in per-project SQLite files." },
    { kind: "sqlite", status: "implemented", description: "<project>/.crush/crush.db tables sessions(id, title, parent_session_id, created_at, updated_at) + messages(session_id, role, parts JSON, model, created_at); discovered under ~/{client,projects,code,src,dev,work,repos} and $HOME (depth 4)." },
  ],
  async detect(): Promise<Detection> {
    const dbs = discoverDbs();
    const roots = searchRoots();
    const locations = [
      ...dbs.map((p) => ({ path: p, exists: true, note: "crush.db" })),
      ...roots.map((r) => ({ path: path.join(r, "**", ".crush", "crush.db"), exists: dbs.some((d) => d.startsWith(r + path.sep)), note: "scanned root (depth 4)" })),
    ];
    return { installed: dbs.length > 0, locations };
  },
  async scan(ctx) {
    return scanDbs(ctx);
  },
  async load(summary: SessionSummary) {
    const src = summary.source;
    return readDb(src.path, src.locator ?? summary.nativeId).find((s) => s.nativeId === summary.nativeId) ?? null;
  },
};
