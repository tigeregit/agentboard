import type { SqliteDb } from "../util/sqlite";
import type { FileStat, Part, PartHit, PartKind, PartQuery, ToolCategory } from "../parts/types";
import type { Role } from "../types";

/**
 * Part index: every session's typed parts with an FTS5 trigram index over the
 * text, so retrieval works across sessions (`grep`) and inside one session
 * (`show --grep`, `--kind`, `--turn`) without re-reading sources.
 *
 * The trigram tokenizer gives substring matching for CJK and identifiers and
 * powers `snippet()`. Queries shorter than 3 characters fall back to LIKE.
 */
export const PARTS_SCHEMA = `
create table if not exists parts (
  id integer primary key,
  session_key text not null,
  seq integer not null,
  turn integer not null,
  kind text not null,
  role text not null,
  form text,
  tool_name text,
  category text,
  call_id text,
  is_error integer,
  exit_code integer,
  timestamp text,
  model text,
  files text,
  child text,
  bytes integer not null,
  text text not null,
  meta text,
  unique (session_key, seq)
);
create index if not exists parts_session on parts(session_key, turn);
create index if not exists parts_kind on parts(kind, category);
create index if not exists parts_tool on parts(tool_name);
create index if not exists parts_error on parts(is_error) where is_error = 1;
create virtual table if not exists parts_fts using fts5(text, files, tool_name, content='parts', content_rowid='id', tokenize='trigram');
create trigger if not exists parts_ai after insert on parts begin
  insert into parts_fts(rowid, text, files, tool_name) values (new.id, new.text, new.files, new.tool_name);
end;
create trigger if not exists parts_ad after delete on parts begin
  insert into parts_fts(parts_fts, rowid, text, files, tool_name) values ('delete', old.id, old.text, old.files, old.tool_name);
end;
create table if not exists parts_meta (
  session_key text primary key,
  part_count integer not null,
  fidelity text not null,
  indexed_at text not null
);
`;

/** Index caps: tool output is stored up to this many chars; everything else is kept whole up to a sanity limit. */
export const RESULT_TEXT_CAP = 16_000;
export const PART_TEXT_CAP = 200_000;

interface PartRow {
  session_key: string;
  seq: number;
  turn: number;
  kind: string;
  role: string;
  form: string | null;
  tool_name: string | null;
  category: string | null;
  call_id: string | null;
  is_error: number | null;
  exit_code: number | null;
  timestamp: string | null;
  model: string | null;
  files: string | null;
  child: string | null;
  bytes: number;
  text: string;
  meta: string | null;
}

interface HitRow extends PartRow {
  s_tool: string;
  s_title: string;
  s_project: string;
  s_when: string | null;
  snippet: string | null;
}

function rowToPart(r: PartRow): Part {
  const meta = r.meta ? (JSON.parse(r.meta) as { args?: unknown; usage?: Part["usage"]; truncated?: boolean; command?: string }) : {};
  const p: Part = {
    seq: r.seq,
    turn: r.turn,
    kind: r.kind as PartKind,
    role: r.role as Role,
    text: r.text,
    bytes: r.bytes,
    timestamp: r.timestamp ?? undefined,
    model: r.model ?? undefined,
    form: (r.form as Part["form"]) ?? undefined,
    files: r.files ? r.files.split("\n").filter(Boolean) : undefined,
    child: r.child ?? undefined,
    usage: meta.usage,
  };
  if (r.tool_name) p.tool = { name: r.tool_name, category: (r.category as ToolCategory) ?? "other", callId: r.call_id ?? undefined, args: meta.args, command: meta.command };
  if (r.kind === "tool_result") p.result = { callId: r.call_id ?? undefined, isError: r.is_error === null ? undefined : r.is_error === 1, exitCode: r.exit_code ?? undefined, truncated: meta.truncated };
  return p;
}

export class PartsStore {
  constructor(private db: SqliteDb) {
    db.exec(PARTS_SCHEMA);
  }

  replaceSession(key: string, parts: Part[], fidelity: "rich" | "derived" | "unavailable") {
    const now = new Date().toISOString();
    this.db.exec("begin");
    try {
      this.db.run("delete from parts where session_key = ?", key);
      const sql = `insert into parts (session_key, seq, turn, kind, role, form, tool_name, category, call_id, is_error, exit_code, timestamp, model, files, child, bytes, text, meta)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
      for (const p of parts) {
        const cap = p.kind === "tool_result" ? RESULT_TEXT_CAP : PART_TEXT_CAP;
        const text = p.text.length > cap ? p.text.slice(0, cap) : p.text;
        const meta: Record<string, unknown> = {};
        if (p.tool?.args !== undefined && p.kind !== "tool_result") {
          const s = JSON.stringify(p.tool.args);
          if (s && s.length <= 20_000) meta.args = p.tool.args;
        }
        if (p.tool?.command) meta.command = p.tool.command.slice(0, 4000);
        if (p.usage) meta.usage = p.usage;
        if (p.result?.truncated) meta.truncated = true;
        this.db.run(
          sql,
          key, p.seq, p.turn, p.kind, p.role, p.form ?? null, p.tool?.name ?? null, p.tool?.category ?? null,
          p.tool?.callId ?? p.result?.callId ?? null,
          p.result?.isError === undefined ? null : p.result.isError ? 1 : 0,
          p.result?.exitCode ?? null,
          p.timestamp ?? null, p.model ?? null,
          p.files?.length ? p.files.join("\n") : null,
          p.child ?? null,
          p.bytes ?? p.text.length, text,
          Object.keys(meta).length ? JSON.stringify(meta) : null,
        );
      }
      this.db.run("insert or replace into parts_meta (session_key, part_count, fidelity, indexed_at) values (?,?,?,?)", key, parts.length, fidelity, now);
      this.db.exec("commit");
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  deleteSession(key: string) {
    this.db.run("delete from parts where session_key = ?", key);
    this.db.run("delete from parts_meta where session_key = ?", key);
  }

  /** Keys that have summaries but no indexed parts (or a stale count). */
  missing(keys: string[]): string[] {
    if (!keys.length) return [];
    const have = new Set(this.db.all<{ session_key: string }>(`select session_key from parts_meta where session_key in (${keys.map(() => "?").join(",")})`, ...keys).map((r) => r.session_key));
    return keys.filter((k) => !have.has(k));
  }

  /** Remove parts whose session no longer exists in the sessions table. */
  gc(): number {
    const n = this.db.run("delete from parts where session_key not in (select key from sessions)").changes;
    this.db.run("delete from parts_meta where session_key not in (select key from sessions)");
    return Number(n);
  }

  meta(key: string): { partCount: number; fidelity: string; indexedAt: string } | null {
    const r = this.db.get<{ part_count: number; fidelity: string; indexed_at: string }>("select part_count, fidelity, indexed_at from parts_meta where session_key = ?", key);
    return r ? { partCount: r.part_count, fidelity: r.fidelity, indexedAt: r.indexed_at } : null;
  }

  /** All parts of one session, optionally filtered. */
  partsOf(key: string, f: { kinds?: PartKind[]; categories?: ToolCategory[]; turns?: [number, number]; seqs?: [number, number]; file?: string; toolName?: string; onlyErrors?: boolean; text?: string } = {}): Part[] {
    const clauses = ["session_key = ?"];
    const params: unknown[] = [key];
    if (f.kinds?.length) {
      clauses.push(`kind in (${f.kinds.map(() => "?").join(",")})`);
      params.push(...f.kinds);
    }
    if (f.categories?.length) {
      clauses.push(`category in (${f.categories.map(() => "?").join(",")})`);
      params.push(...f.categories);
    }
    if (f.turns) {
      clauses.push("turn between ? and ?");
      params.push(f.turns[0], f.turns[1]);
    }
    if (f.seqs) {
      clauses.push("seq between ? and ?");
      params.push(f.seqs[0], f.seqs[1]);
    }
    if (f.file) {
      clauses.push("files like ?");
      params.push(`%${f.file}%`);
    }
    if (f.toolName) {
      clauses.push("lower(tool_name) = lower(?)");
      params.push(f.toolName);
    }
    if (f.onlyErrors) clauses.push("is_error = 1");
    if (f.text) {
      clauses.push("text like ?");
      params.push(`%${f.text}%`);
    }
    return this.db.all<PartRow>(`select * from parts where ${clauses.join(" and ")} order by seq`, ...params).map(rowToPart);
  }

  /** Cross-session part search. */
  search(q: PartQuery): { hits: PartHit[]; total: number } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const text = q.text?.trim();
    // Trigram FTS needs >= 3 chars per token; shorter tokens (common in CJK) use LIKE on the same rows.
    const tokens = text ? text.split(/\s+/).filter(Boolean) : [];
    const longTokens = tokens.filter((t) => t.length >= 3);
    const shortTokens = tokens.filter((t) => t.length < 3);
    let from = "parts p join sessions s on s.key = p.session_key";
    let snippetSql = "null";
    if (longTokens.length) {
      from = "parts_fts f join parts p on p.id = f.rowid join sessions s on s.key = p.session_key";
      clauses.push("parts_fts match ?");
      params.push(ftsQuery(longTokens.join(" ")));
      snippetSql = "snippet(parts_fts, 0, '⟦', '⟧', '…', 24)";
    }
    for (const t of shortTokens) {
      clauses.push("(p.text like ? or p.files like ?)");
      params.push(`%${t}%`, `%${t}%`);
    }
    if (q.kinds?.length) {
      clauses.push(`p.kind in (${q.kinds.map(() => "?").join(",")})`);
      params.push(...q.kinds);
    }
    if (q.categories?.length) {
      clauses.push(`p.category in (${q.categories.map(() => "?").join(",")})`);
      params.push(...q.categories);
    }
    if (q.toolName) {
      clauses.push("lower(p.tool_name) = lower(?)");
      params.push(q.toolName);
    }
    if (q.file) {
      clauses.push("p.files like ?");
      params.push(`%${q.file}%`);
    }
    if (q.sessionKey) {
      clauses.push("p.session_key = ?");
      params.push(q.sessionKey);
    }
    if (q.role) {
      clauses.push("p.role = ?");
      params.push(q.role);
    }
    if (q.onlyErrors) clauses.push("p.is_error = 1");
    if (q.tools?.length) {
      clauses.push(`s.tool in (${q.tools.map(() => "?").join(",")})`);
      params.push(...q.tools);
    }
    if (q.project) {
      clauses.push("(s.project_path like ? or s.project_name like ?)");
      params.push(`%${q.project}%`, `%${q.project}%`);
    }
    if (q.since) {
      clauses.push("coalesce(p.timestamp, s.ended_at) >= ?");
      params.push(q.since);
    }
    if (q.until) {
      clauses.push("coalesce(p.timestamp, s.started_at) < ?");
      params.push(q.until);
    }
    const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
    const total = this.db.get<{ n: number }>(`select count(*) n from ${from} ${where}`, ...params)?.n ?? 0;
    const order = q.order === "asc" ? "asc" : "desc";
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 500);
    const offset = Math.max(q.offset ?? 0, 0);
    const rows = this.db.all<HitRow>(
      `select p.*, s.tool s_tool, s.title s_title, s.project_name s_project, coalesce(p.timestamp, s.started_at) s_when, ${snippetSql} snippet from ${from} ${where}
       order by coalesce(p.timestamp, s.ended_at) ${order}, p.session_key, p.seq ${order} limit ? offset ?`,
      ...params, limit, offset,
    );
    const hits = rows.map((r) => ({
      sessionKey: r.session_key,
      tool: r.s_tool,
      title: r.s_title,
      project: r.s_project,
      seq: r.seq,
      turn: r.turn,
      kind: r.kind as PartKind,
      role: r.role as Role,
      category: (r.category as ToolCategory) ?? undefined,
      toolName: r.tool_name ?? undefined,
      form: (r.form as PartHit["form"]) ?? undefined,
      isError: r.is_error === 1 ? true : undefined,
      timestamp: r.timestamp ?? r.s_when ?? undefined,
      files: r.files ? r.files.split("\n").filter(Boolean) : undefined,
      snippet: r.snippet ?? likeSnippet(r.text, shortTokens[0] ?? text, 160),
      bytes: r.bytes,
    }));
    return { hits, total };
  }

  /** Files touched across sessions. */
  files(q: { tools?: string[]; project?: string; since?: string; until?: string; sessionKey?: string; file?: string; limit?: number } = {}): FileStat[] {
    const clauses = ["p.files is not null", "p.kind in ('tool_call','plan')"];
    const params: unknown[] = [];
    if (q.sessionKey) {
      clauses.push("p.session_key = ?");
      params.push(q.sessionKey);
    }
    if (q.tools?.length) {
      clauses.push(`s.tool in (${q.tools.map(() => "?").join(",")})`);
      params.push(...q.tools);
    }
    if (q.project) {
      clauses.push("(s.project_path like ? or s.project_name like ?)");
      params.push(`%${q.project}%`, `%${q.project}%`);
    }
    if (q.since) {
      clauses.push("coalesce(p.timestamp, s.ended_at) >= ?");
      params.push(q.since);
    }
    if (q.until) {
      clauses.push("coalesce(p.timestamp, s.started_at) < ?");
      params.push(q.until);
    }
    const rows = this.db.all<{ session_key: string; category: string | null; files: string; ts: string | null }>(
      `select p.session_key, p.category, p.files, coalesce(p.timestamp, s.ended_at) ts from parts p join sessions s on s.key = p.session_key where ${clauses.join(" and ")}`,
      ...params,
    );
    const map = new Map<string, FileStat & { keys: Set<string> }>();
    for (const r of rows) {
      for (const f of r.files.split("\n")) {
        if (!f || (q.file && !f.includes(q.file))) continue;
        const e = map.get(f) ?? { path: f, edits: 0, reads: 0, sessions: 0, sessionKeys: [], keys: new Set<string>(), lastActivity: undefined };
        if (r.category === "edit") e.edits++;
        else e.reads++;
        e.keys.add(r.session_key);
        if (r.ts && (!e.lastActivity || r.ts > e.lastActivity)) e.lastActivity = r.ts;
        map.set(f, e);
      }
    }
    const out = Array.from(map.values()).map(({ keys, ...rest }) => ({ ...rest, sessions: keys.size, sessionKeys: Array.from(keys) }));
    out.sort((a, b) => b.edits * 3 + b.reads - (a.edits * 3 + a.reads));
    return out.slice(0, q.limit ?? 100);
  }

  counts(): { parts: number; sessions: number; byKind: Record<string, number> } {
    const r = this.db.get<{ n: number; s: number }>("select count(*) n, count(distinct session_key) s from parts");
    const byKind: Record<string, number> = {};
    for (const k of this.db.all<{ kind: string; n: number }>("select kind, count(*) n from parts group by kind")) byKind[k.kind] = k.n;
    return { parts: r?.n ?? 0, sessions: r?.s ?? 0, byKind };
  }
}

/** Turn free text into an FTS5 query: each whitespace token becomes a quoted phrase (AND). */
export function ftsQuery(text: string): string {
  const tokens = text.split(/\s+/).filter((t) => t.length >= 3);
  if (!tokens.length) return `"${text.replace(/"/g, '""')}"`;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

function likeSnippet(text: string, needle: string | undefined, width: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (!needle) return one.length > width ? one.slice(0, width - 1) + "…" : one;
  const i = one.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return one.length > width ? one.slice(0, width - 1) + "…" : one;
  const start = Math.max(0, i - Math.floor(width / 3));
  const end = Math.min(one.length, start + width);
  return (start > 0 ? "…" : "") + one.slice(start, i) + "⟦" + one.slice(i, i + needle.length) + "⟧" + one.slice(i + needle.length, end) + (end < one.length ? "…" : "");
}
