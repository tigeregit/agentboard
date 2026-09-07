import path from "node:path";
import type { DayBucket, ProjectStat, SessionQuery, SessionSummary, ToolId, ToolStat } from "../types";
import { agentboardHome } from "../util/paths";
import { localDay } from "../util/time";
import { openSqlite, type SqliteDb } from "../util/sqlite";

/**
 * Persistent index of session summaries at `~/.agentboard/index.db`.
 * Full transcripts are never copied here; `load` goes back to the source.
 */
const SCHEMA = `
create table if not exists sessions (
  key text primary key,
  tool text not null,
  surface text not null,
  native_id text not null,
  title text not null,
  project_path text not null,
  project_name text not null,
  started_at text not null,
  ended_at text not null,
  message_count integer not null,
  user_count integer not null,
  assistant_count integer not null,
  tool_call_count integer not null,
  model text,
  git_branch text,
  first_prompt text not null,
  prompt_text text not null,
  source_kind text not null,
  source_path text not null,
  source_locator text,
  parent_key text,
  extra text,
  indexed_at text not null
);
create index if not exists sessions_tool on sessions(tool);
create index if not exists sessions_ended on sessions(ended_at);
create index if not exists sessions_project on sessions(project_path);
create index if not exists sessions_source on sessions(source_path);
create table if not exists scan_state (
  tool text not null,
  path text not null,
  mtime_ms real not null,
  size integer not null,
  scanned_at text not null,
  primary key (tool, path)
);
create table if not exists scan_runs (
  id integer primary key autoincrement,
  started_at text not null,
  finished_at text,
  tool text not null,
  sessions_upserted integer default 0,
  sessions_removed integer default 0,
  warnings text
);
`;

interface Row {
  key: string;
  tool: string;
  surface: string;
  native_id: string;
  title: string;
  project_path: string;
  project_name: string;
  started_at: string;
  ended_at: string;
  message_count: number;
  user_count: number;
  assistant_count: number;
  tool_call_count: number;
  model: string | null;
  git_branch: string | null;
  first_prompt: string;
  prompt_text: string;
  source_kind: string;
  source_path: string;
  source_locator: string | null;
  parent_key: string | null;
  extra: string | null;
}

function rowToSummary(r: Row): SessionSummary {
  return {
    key: r.key,
    tool: r.tool as ToolId,
    surface: r.surface as SessionSummary["surface"],
    nativeId: r.native_id,
    title: r.title,
    project: { path: r.project_path, name: r.project_name },
    startedAt: r.started_at,
    endedAt: r.ended_at,
    messageCount: r.message_count,
    userMessageCount: r.user_count,
    assistantMessageCount: r.assistant_count,
    toolCallCount: r.tool_call_count,
    model: r.model ?? undefined,
    gitBranch: r.git_branch ?? undefined,
    firstPrompt: r.first_prompt,
    promptText: r.prompt_text,
    source: { kind: r.source_kind as SessionSummary["source"]["kind"], path: r.source_path, locator: r.source_locator ?? undefined },
    parentKey: r.parent_key ?? undefined,
    extra: r.extra ? (JSON.parse(r.extra) as Record<string, unknown>) : undefined,
  };
}

export class IndexStore {
  private db: SqliteDb;
  readonly file: string;

  constructor(file = path.join(agentboardHome(), "index.db")) {
    this.file = file;
    this.db = openSqlite(file);
    this.db.exec("pragma journal_mode = wal; pragma synchronous = normal;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  isFresh(tool: ToolId, p: string, mtimeMs: number, size: number): boolean {
    const row = this.db.get<{ mtime_ms: number; size: number }>("select mtime_ms, size from scan_state where tool = ? and path = ?", tool, p);
    return !!row && Math.abs(row.mtime_ms - mtimeMs) < 1 && row.size === size;
  }

  upsertSessions(list: SessionSummary[]) {
    const now = new Date().toISOString();
    const sql = `insert into sessions (key, tool, surface, native_id, title, project_path, project_name, started_at, ended_at,
      message_count, user_count, assistant_count, tool_call_count, model, git_branch, first_prompt, prompt_text,
      source_kind, source_path, source_locator, parent_key, extra, indexed_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(key) do update set tool=excluded.tool, surface=excluded.surface, title=excluded.title,
      project_path=excluded.project_path, project_name=excluded.project_name, started_at=excluded.started_at,
      ended_at=excluded.ended_at, message_count=excluded.message_count, user_count=excluded.user_count,
      assistant_count=excluded.assistant_count, tool_call_count=excluded.tool_call_count, model=excluded.model,
      git_branch=excluded.git_branch, first_prompt=excluded.first_prompt, prompt_text=excluded.prompt_text,
      source_kind=excluded.source_kind, source_path=excluded.source_path, source_locator=excluded.source_locator,
      parent_key=excluded.parent_key, extra=excluded.extra, indexed_at=excluded.indexed_at`;
    this.db.exec("begin");
    try {
      for (const s of list) {
        this.db.run(
          sql,
          s.key, s.tool, s.surface, s.nativeId, s.title, s.project.path, s.project.name, s.startedAt, s.endedAt,
          s.messageCount, s.userMessageCount, s.assistantMessageCount, s.toolCallCount, s.model ?? null, s.gitBranch ?? null,
          s.firstPrompt, s.promptText, s.source.kind, s.source.path, s.source.locator ?? null, s.parentKey ?? null,
          s.extra ? JSON.stringify(s.extra) : null, now,
        );
      }
      this.db.exec("commit");
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  /** Record fingerprints and drop sessions whose source path vanished for this tool. */
  reconcileSeen(tool: ToolId, seen: { path: string; mtimeMs: number; size: number }[]): number {
    const now = new Date().toISOString();
    this.db.exec("begin");
    try {
      this.db.run("delete from scan_state where tool = ?", tool);
      for (const s of seen) this.db.run("insert or replace into scan_state (tool, path, mtime_ms, size, scanned_at) values (?,?,?,?,?)", tool, s.path, s.mtimeMs, s.size, now);
      const removed = this.db.run(`delete from sessions where tool = ? and source_kind <> 'api' and source_path not in (select path from scan_state where tool = ?)`, tool, tool);
      this.db.exec("commit");
      return Number(removed.changes);
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  /** Sessions that were parsed from a source file which changed but no longer yields them (e.g. compaction). */
  deleteSessionsForPaths(tool: ToolId, paths: string[], keepKeys: Set<string>) {
    if (!paths.length) return;
    const placeholders = paths.map(() => "?").join(",");
    const rows = this.db.all<{ key: string }>(`select key from sessions where tool = ? and source_path in (${placeholders})`, tool, ...paths);
    for (const r of rows) if (!keepKeys.has(r.key)) this.db.run("delete from sessions where key = ?", r.key);
  }

  recordRun(tool: ToolId, startedAt: string, upserted: number, removed: number, warnings: string[]) {
    this.db.run("insert into scan_runs (started_at, finished_at, tool, sessions_upserted, sessions_removed, warnings) values (?,?,?,?,?,?)", startedAt, new Date().toISOString(), tool, upserted, removed, warnings.length ? JSON.stringify(warnings.slice(0, 50)) : null);
    this.db.run("delete from scan_runs where id not in (select id from scan_runs order by id desc limit 500)");
  }

  lastRuns(): { tool: ToolId; finishedAt: string; upserted: number; removed: number; warnings: string[] }[] {
    const rows = this.db.all<{ tool: string; finished_at: string; sessions_upserted: number; sessions_removed: number; warnings: string | null }>(
      `select tool, finished_at, sessions_upserted, sessions_removed, warnings from scan_runs r
       where id = (select max(id) from scan_runs where tool = r.tool)`,
    );
    return rows.map((r) => ({ tool: r.tool as ToolId, finishedAt: r.finished_at, upserted: r.sessions_upserted, removed: r.sessions_removed, warnings: r.warnings ? (JSON.parse(r.warnings) as string[]) : [] }));
  }

  private where(q: SessionQuery): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (q.tools?.length) {
      clauses.push(`tool in (${q.tools.map(() => "?").join(",")})`);
      params.push(...q.tools);
    }
    if (q.surface) {
      clauses.push("surface = ?");
      params.push(q.surface);
    }
    if (q.project) {
      clauses.push("(project_path like ? or project_name like ?)");
      params.push(`%${q.project}%`, `%${q.project}%`);
    }
    if (q.since) {
      clauses.push("ended_at >= ?");
      params.push(q.since);
    }
    if (q.until) {
      clauses.push("started_at < ?");
      params.push(q.until);
    }
    if (q.search) {
      for (const term of q.search.split(/\s+/).filter(Boolean)) {
        clauses.push("(title like ? or prompt_text like ? or project_name like ? or model like ? or key like ?)");
        params.push(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
      }
    }
    return { sql: clauses.length ? `where ${clauses.join(" and ")}` : "", params };
  }

  query(q: SessionQuery): { items: SessionSummary[]; total: number } {
    const { sql, params } = this.where(q);
    const total = this.db.get<{ n: number }>(`select count(*) n from sessions ${sql}`, ...params)?.n ?? 0;
    const order = q.order === "asc" ? "asc" : "desc";
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 2000);
    const offset = Math.max(q.offset ?? 0, 0);
    const rows = this.db.all<Row>(`select * from sessions ${sql} order by ended_at ${order} limit ? offset ?`, ...params, limit, offset);
    return { items: rows.map(rowToSummary), total };
  }

  get(key: string): SessionSummary | null {
    const row = this.db.get<Row>("select * from sessions where key = ?", key);
    if (row) return rowToSummary(row);
    // allow prefix match on native id for CLI convenience
    const rows = this.db.all<Row>("select * from sessions where key like ? or native_id like ? limit 2", `%${key}%`, `${key}%`);
    return rows.length === 1 ? rowToSummary(rows[0]) : null;
  }

  children(key: string): SessionSummary[] {
    return this.db.all<Row>("select * from sessions where parent_key = ? order by started_at", key).map(rowToSummary);
  }

  projects(q: SessionQuery = {}): ProjectStat[] {
    const { sql, params } = this.where(q);
    const rows = this.db.all<{ project_path: string; project_name: string; n: number; m: number; u: number; tools: string; first: string; last: string }>(
      `select project_path, project_name, count(*) n, sum(message_count) m, sum(user_count) u, group_concat(distinct tool) tools, min(started_at) first, max(ended_at) last
       from sessions ${sql} group by project_path order by last desc`,
      ...params,
    );
    return rows.map((r) => ({ path: r.project_path, name: r.project_name, sessionCount: r.n, messageCount: r.m, userMessageCount: r.u ?? 0, tools: r.tools.split(",") as ToolId[], firstActivity: r.first, lastActivity: r.last }));
  }

  toolStats(q: SessionQuery = {}): ToolStat[] {
    const { sql, params } = this.where(q);
    const rows = this.db.all<{ tool: string; n: number; m: number; u: number; last: string | null }>(`select tool, count(*) n, sum(message_count) m, sum(user_count) u, max(ended_at) last from sessions ${sql} group by tool order by n desc`, ...params);
    return rows.map((r) => ({ tool: r.tool as ToolId, sessionCount: r.n, messageCount: r.m, userMessageCount: r.u ?? 0, lastActivity: r.last }));
  }

  /** Activity per local day (sessions are bucketed by their last activity). */
  days(q: SessionQuery = {}): DayBucket[] {
    const { sql, params } = this.where(q);
    const rows = this.db.all<{ tool: string; ended_at: string; message_count: number; user_count: number }>(`select tool, ended_at, message_count, user_count from sessions ${sql}`, ...params);
    const map = new Map<string, DayBucket>();
    for (const r of rows) {
      const day = localDay(r.ended_at);
      const b = map.get(day) ?? { day, sessionCount: 0, messageCount: 0, userMessageCount: 0, byTool: {} };
      b.sessionCount++;
      b.messageCount += r.message_count;
      b.userMessageCount += r.user_count ?? 0;
      b.byTool[r.tool as ToolId] = (b.byTool[r.tool as ToolId] ?? 0) + 1;
      map.set(day, b);
    }
    return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
  }

  counts(): { sessions: number; tools: number; projects: number } {
    const r = this.db.get<{ s: number; t: number; p: number }>("select count(*) s, count(distinct tool) t, count(distinct project_path) p from sessions");
    return { sessions: r?.s ?? 0, tools: r?.t ?? 0, projects: r?.p ?? 0 };
  }
}
