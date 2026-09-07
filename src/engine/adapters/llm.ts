import fs from "node:fs";
import path from "node:path";
import type { Message, ScanContext, ScanResult, SessionDetail, SessionSummary, SourceAdapter } from "../types";
import { appDataRoots, expand, projectFromPath, statSafe } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { cleanPrompt, str } from "../util/text";
import { toIso } from "../util/time";
import { openSqliteReadOnly, type SqliteDb } from "../util/sqlite";
import { detection, sqliteSource } from "./_shared";

/**
 * Simon Willison's `llm` CLI logs every prompt to
 * `<config_dir>/io.datasette.llm/logs.db` (`LLM_USER_PATH` overrides the dir;
 * config_dir = ~/.config on Linux, ~/Library/Application Support on macOS,
 * %APPDATA% on Windows). Tables: `conversations(id, name, model)` and
 * `responses(id, model, prompt, system, response, conversation_id,
 * datetime_utc, input_tokens, output_tokens, ...)`. Each conversation is one
 * session (a user + assistant pair per response row); responses with a NULL
 * `conversation_id` are bucketed into one "Ungrouped prompts" session. `llm`
 * has no cwd concept so the directory holding logs.db is the project.
 */
const NO_CONVERSATION = "__none__";

function dbCandidates(): string[] {
  const out: string[] = [];
  const override = process.env.LLM_USER_PATH?.trim();
  if (override) out.push(path.join(expand(override), "logs.db"));
  for (const root of appDataRoots("io.datasette.llm")) out.push(path.join(root, "logs.db"));
  return Array.from(new Set(out));
}

function dbFiles(): string[] {
  return dbCandidates().filter((p) => fs.existsSync(p));
}

/** `datetime_utc` is UTC without a designator (`2026-06-20T10:00:00.123`); mark it so it is not parsed as local time. */
function utcText(v: unknown): string | undefined {
  if (typeof v !== "string") return toIso(v);
  const t = v.trim().replace(" ", "T");
  if (!t) return undefined;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(t);
  return toIso(t.includes("T") && !hasZone ? `${t}Z` : t);
}

interface ResponseRow {
  id: string;
  conversation_id: unknown;
  prompt: unknown;
  response: unknown;
  model: unknown;
  datetime_utc: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

function responseSelect(db: SqliteDb): string {
  const cols = new Set(db.columns("responses"));
  const pick = (c: string) => (cols.has(c) ? `"${c}"` : `null as "${c}"`);
  return `select "id", ${pick("conversation_id")}, ${pick("prompt")}, ${pick("response")}, ${pick("model")}, ${pick("datetime_utc")}, ${pick("input_tokens")}, ${pick("output_tokens")} from responses`;
}

function readDb(dbPath: string, onlyId?: string): SessionDetail[] {
  const db = openSqliteReadOnly(dbPath);
  if (!db) return [];
  const out: SessionDetail[] = [];
  try {
    const tables = db.tables();
    if (!tables.includes("responses")) return [];
    const mtime = fs.statSync(dbPath).mtimeMs;
    const names = new Map<string, { name?: string; model?: string }>();
    if (tables.includes("conversations")) {
      for (const c of db.all<{ id: unknown; name: unknown; model: unknown }>("select id, name, model from conversations")) {
        names.set(String(c.id), { name: str(c.name)?.trim() || undefined, model: str(c.model) });
      }
    }
    const base = responseSelect(db);
    const order = " order by datetime_utc, id";
    let rows: ResponseRow[];
    if (onlyId === undefined) rows = db.all<ResponseRow>(base + order);
    else if (onlyId === NO_CONVERSATION) rows = db.all<ResponseRow>(`${base} where conversation_id is null${order}`);
    else rows = db.all<ResponseRow>(`${base} where conversation_id = ?${order}`, onlyId);

    const groups = new Map<string, ResponseRow[]>();
    for (const r of rows) {
      const key = r.conversation_id == null ? NO_CONVERSATION : String(r.conversation_id);
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const [convId, list] of groups) {
      const messages: Message[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      for (const r of list) {
        const timestamp = utcText(r.datetime_utc);
        const prompt = cleanPrompt(str(r.prompt) ?? "");
        if (prompt) messages.push({ role: "user", text: prompt, timestamp });
        const response = str(r.response) ?? "";
        if (response.trim()) messages.push({ role: "assistant", text: response, timestamp, model: str(r.model) });
        inputTokens += num(r.input_tokens);
        outputTokens += num(r.output_tokens);
      }
      if (!messages.length) continue;
      const meta = names.get(convId);
      out.push(
        buildSession({
          tool: "llm",
          surface: "cli",
          nativeId: convId,
          title: convId === NO_CONVERSATION ? "Ungrouped prompts" : meta?.name,
          project: projectFromPath(path.dirname(dbPath)),
          messages,
          source: sqliteSource(dbPath, convId),
          model: meta?.model,
          fallbackTime: mtime,
          extra: { responses: list.length, inputTokens: inputTokens || undefined, outputTokens: outputTokens || undefined },
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

export const llm: SourceAdapter = {
  id: "llm",
  name: "llm CLI",
  vendor: "Datasette",
  surface: "cli",
  configHints: ["LLM_USER_PATH (dir holding logs.db; default <config_dir>/io.datasette.llm)", "XDG_CONFIG_HOME (Linux config dir, default ~/.config)"],
  strategies: [
    { kind: "native-index", status: "reserved", description: "`llm logs` / `llm logs -q` query the same logs.db (FTS on prompt/response); shelling out is unnecessary when the db is readable." },
    { kind: "sqlite", status: "implemented", description: "<config_dir>/io.datasette.llm/logs.db tables conversations(id, name, model) + responses(id, prompt, response, model, conversation_id, datetime_utc, input_tokens, output_tokens); NULL conversation_id rows form one 'Ungrouped prompts' session." },
  ],
  async detect() {
    return detection(dbCandidates().map((p) => ({ path: p, note: "llm logs.db" })));
  },
  async scan(ctx) {
    return scanDbs(ctx);
  },
  async load(summary: SessionSummary) {
    const src = summary.source;
    return readDb(src.path, src.locator ?? summary.nativeId).find((s) => s.nativeId === summary.nativeId) ?? null;
  },
};
