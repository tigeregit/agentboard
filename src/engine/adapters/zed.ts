import fs from "node:fs";
import path from "node:path";
import { decompress } from "fzstd";
import type { Message, ScanContext, ScanResult, SessionDetail, SessionSummary, SourceAdapter, ToolCall } from "../types";
import { home, projectFromPath, statSafe, xdgDataHome } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { cleanPrompt, isRecord, str, summarizeToolInput } from "../util/text";
import { openSqliteReadOnly, type SqliteDb } from "../util/sqlite";
import { detection, sqliteSource } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * Zed's Agent Panel keeps every thread in one SQLite file under the Zed data
 * dir (`~/Library/Application Support/Zed` on macOS, `$XDG_DATA_HOME/zed` on
 * Linux, `%LOCALAPPDATA%\Zed` on Windows): `threads/threads.db`, table
 * `threads(id, summary, updated_at, data_type, data, folder_paths?, created_at?)`.
 * `data` is the serialized `DbThread` JSON, stored plain (`data_type = "json"`)
 * or zstd-compressed (`"zstd"`, decoded in-process with fzstd).
 * `DbThread.messages[]` are externally tagged: `{"User":{content:[{Text}|
 * {Mention}|{Image}]}}`, `{"Agent":{content:[{Text}|{Thinking}|
 * {RedactedThinking}|{ToolUse}], tool_results:{<id>:{content,is_error}}}}`,
 * `"Resume"`, `{"Compaction":..}`; the legacy `SerializedThread` shape
 * (`{role, segments:[{type:"text"|"thinking"}]}`) is handled as a fallback.
 * Optional columns are discovered via `PRAGMA table_info` so older schemas work.
 */

function dataDirs(): string[] {
  const h = home();
  const out = [path.join(h, "Library", "Application Support", "Zed"), path.join(xdgDataHome(), "zed")];
  if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, "Zed"));
  return Array.from(new Set(out));
}

function dbPaths(): string[] {
  return dataDirs().map((d) => path.join(d, "threads", "threads.db"));
}

// ---------- DbThread decoding ----------

function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return Buffer.from(v, "utf8");
  return null;
}

export function decodeThreadData(dataType: unknown, data: unknown): Rec | null {
  const bytes = toBytes(data);
  if (!bytes) return null;
  const plain = dataType === "zstd" ? decompress(bytes) : bytes;
  const parsed: unknown = JSON.parse(Buffer.from(plain).toString("utf8"));
  return isRecord(parsed) ? parsed : null;
}

function tagged(item: unknown, tag: string): unknown {
  return isRecord(item) && tag in item ? item[tag] : undefined;
}

function userText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const text = str(tagged(item, "Text"));
    if (text) {
      parts.push(text);
      continue;
    }
    const mention = tagged(item, "Mention");
    const mentionText = isRecord(mention) ? str(mention.content) : undefined;
    if (mentionText) parts.push(mentionText);
  }
  return parts.join("\n");
}

function agentContent(content: unknown): { text: string; toolCalls: ToolCall[] } {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      const text = str(tagged(item, "Text"));
      if (text) texts.push(text);
      const tool = tagged(item, "ToolUse");
      if (isRecord(tool)) {
        const name = str(tool.name) ?? "unknown";
        toolCalls.push({ name, summary: summarizeToolInput(name, tool.input ?? tool.raw_input) });
      }
    }
  }
  return { text: texts.join("\n"), toolCalls };
}

/** `Vec<LanguageModelToolResultContent>`: `{"Text": ..}` / `{"Image": ..}` items, a bare string, or a single item. */
function toolResultText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(toolResultText).filter(Boolean).join("\n");
  if (isRecord(v)) {
    const text = str(v.Text) ?? str(v.text);
    if (text !== undefined) return text;
    if ("Image" in v || "image" in v) return "[image]";
    return JSON.stringify(v);
  }
  return v === null || v === undefined ? "" : String(v);
}

function legacySegments(segments: unknown): string {
  if (!Array.isArray(segments)) return "";
  return segments
    .filter(isRecord)
    .filter((s) => s.type === "text")
    .map((s) => str(s.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

export function convertThreadMessages(thread: Rec): Message[] {
  const out: Message[] = [];
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  for (const msg of messages) {
    const user = tagged(msg, "User");
    if (user !== undefined) {
      const text = cleanPrompt(userText(isRecord(user) ? user.content : undefined));
      if (text) out.push({ role: "user", text });
      continue;
    }
    const agent = tagged(msg, "Agent");
    if (agent !== undefined) {
      const a = isRecord(agent) ? agent : {};
      const { text, toolCalls } = agentContent(a.content);
      if (text.trim() || toolCalls.length) out.push({ role: "assistant", text, toolCalls: toolCalls.length ? toolCalls : undefined });
      const results = isRecord(a.tool_results) ? a.tool_results : {};
      for (const res of Object.values(results)) {
        if (!isRecord(res)) continue;
        const body = toolResultText(res.content);
        if (body.trim()) out.push({ role: "tool", text: body.slice(0, 4000) });
      }
      continue;
    }
    if (isRecord(msg) && typeof msg.role === "string") {
      const text = legacySegments(msg.segments);
      if (!text.trim()) continue;
      if (msg.role === "assistant") out.push({ role: "assistant", text });
      else if (msg.role === "user") out.push({ role: "user", text: cleanPrompt(text) });
    }
    // "Resume" / {"Compaction": ..} carry no conversation.
  }
  return out;
}

// ---------- threads.db ----------

interface ThreadRow {
  id: string;
  summary: string | null;
  updated_at: string | null;
  created_at: string | null;
  folder_paths: string | null;
  data_type: string | null;
  data: unknown;
}

function firstFolder(folderPaths: string | null): string | undefined {
  if (!folderPaths) return undefined;
  try {
    const v: unknown = JSON.parse(folderPaths);
    return Array.isArray(v) ? str(v[0]) || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** Fallback cwd + branch from the thread's initial project snapshot. */
function snapshotInfo(thread: Rec): { cwd?: string; branch?: string } {
  const snap = isRecord(thread.initial_project_snapshot) ? thread.initial_project_snapshot : undefined;
  const worktrees = Array.isArray(snap?.worktree_snapshots) ? snap.worktree_snapshots.filter(isRecord) : [];
  const first = worktrees[0];
  const git = isRecord(first?.git_state) ? first.git_state : undefined;
  return { cwd: str(first?.worktree_path), branch: str(git?.current_branch) };
}

function selectRows(db: SqliteDb, onlyId?: string): ThreadRow[] {
  if (!db.tables().includes("threads")) return [];
  const cols = new Set(db.columns("threads"));
  const col = (name: string) => (cols.has(name) ? name : `null as ${name}`);
  const sql = `select id, ${col("summary")}, ${col("updated_at")}, ${col("created_at")}, ${col("folder_paths")}, ${col("data_type")}, data from threads`;
  return onlyId ? db.all<ThreadRow>(`${sql} where id = ?`, onlyId) : db.all<ThreadRow>(sql);
}

export function readThreadsDb(dbPath: string, onlyId?: string, warnings?: string[]): SessionDetail[] {
  const db = openSqliteReadOnly(dbPath);
  if (!db) return [];
  const out: SessionDetail[] = [];
  const fallbackTime = fs.statSync(dbPath).mtimeMs;
  try {
    for (const row of selectRows(db, onlyId)) {
      let thread: Rec | null;
      try {
        thread = decodeThreadData(row.data_type ?? "json", row.data);
      } catch (err) {
        warnings?.push(`${dbPath} thread ${row.id}: ${(err as Error).message}`);
        continue;
      }
      if (!thread) continue;
      const messages = convertThreadMessages(thread);
      if (!messages.length) continue;
      const snap = snapshotInfo(thread);
      const model = isRecord(thread.model) ? thread.model : undefined;
      const title = str(row.summary)?.trim() || str(thread.title)?.trim() || str(thread.summary)?.trim();
      out.push(
        buildSession({
          tool: "zed",
          surface: "ide",
          nativeId: row.id,
          title,
          project: projectFromPath(firstFolder(row.folder_paths) ?? snap.cwd),
          messages,
          source: sqliteSource(dbPath, row.id),
          startedAt: row.created_at,
          endedAt: row.updated_at ?? thread.updated_at,
          model: str(model?.model),
          gitBranch: snap.branch,
          fallbackTime,
          extra: { dataType: row.data_type ?? "json", provider: str(model?.provider), profile: str(thread.profile) },
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
  for (const dbPath of dbPaths()) {
    const stat = statSafe(dbPath);
    if (!stat) continue;
    const wal = statSafe(dbPath + "-wal");
    const mtimeMs = Math.max(stat.mtimeMs, wal?.mtimeMs ?? 0);
    const size = stat.size + (wal?.size ?? 0);
    result.seen.push({ path: dbPath, mtimeMs, size });
    if (!ctx.full && ctx.isFresh(dbPath, mtimeMs, size)) continue;
    try {
      for (const d of readThreadsDb(dbPath, undefined, result.warnings)) result.sessions.push(stripDetail(d));
    } catch (err) {
      result.warnings.push(`${dbPath}: ${(err as Error).message}`);
    }
  }
  return result;
}

export const zed: SourceAdapter = {
  id: "zed",
  name: "Zed (Agent Panel)",
  vendor: "Zed Industries",
  surface: "ide",
  configHints: ["XDG_DATA_HOME (Linux data dir, default ~/.local/share)", "LOCALAPPDATA (Windows)"],
  strategies: [
    { kind: "sqlite", status: "implemented", description: "<Zed data dir>/threads/threads.db `threads` table (id, summary, updated_at, created_at?, folder_paths?, data_type json|zstd, data = DbThread JSON)." },
    { kind: "api", status: "reserved", description: "Zed exposes agent threads to external agents over ACP only; no read API for the thread store." },
  ],
  async detect() {
    return detection(dbPaths().map((p) => ({ path: p, note: "Agent Panel threads" })));
  },
  async scan(ctx) {
    return scanDbs(ctx);
  },
  async load(summary: SessionSummary) {
    if (summary.source.kind !== "sqlite") return null;
    return readThreadsDb(summary.source.path, summary.nativeId)[0] ?? null;
  },
};
