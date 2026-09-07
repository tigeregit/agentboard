import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Thin wrapper around `node:sqlite` (Node >= 22.13). Loaded lazily via
 * `process.getBuiltinModule` so bundlers (Turbopack/webpack) never try to
 * resolve it, and so we can degrade gracefully on older runtimes.
 */
export interface SqliteRow {
  [column: string]: unknown;
}

export interface SqliteDb {
  all<T = SqliteRow>(sql: string, ...params: unknown[]): T[];
  get<T = SqliteRow>(sql: string, ...params: unknown[]): T | undefined;
  run(sql: string, ...params: unknown[]): { changes: number | bigint };
  exec(sql: string): void;
  tables(): string[];
  columns(table: string): string[];
  close(): void;
}

// Minimal structural typing of the node:sqlite surface we use.
interface NodeSqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint };
}
interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean; open?: boolean },
  ) => NodeSqliteDatabase;
}

let cached: NodeSqliteModule | null | undefined;

function loadModule(): NodeSqliteModule | null {
  if (cached !== undefined) return cached;
  try {
    const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    let mod: unknown = getBuiltin ? getBuiltin("node:sqlite") : undefined;
    if (!mod) {
      const req = createRequire(import.meta.url);
      mod = req("node:sqlite");
    }
    cached = mod as NodeSqliteModule;
  } catch {
    cached = null;
  }
  return cached;
}

export function sqliteAvailable(): boolean {
  return loadModule() !== null;
}

function wrap(db: NodeSqliteDatabase): SqliteDb {
  return {
    all(sql, ...params) {
      return db.prepare(sql).all(...params) as never;
    },
    get(sql, ...params) {
      return db.prepare(sql).get(...params) as never;
    },
    run(sql, ...params) {
      return db.prepare(sql).run(...params);
    },
    exec(sql) {
      db.exec(sql);
    },
    tables() {
      return (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name);
    },
    columns(table) {
      return (db.prepare(`pragma table_info("${table.replace(/"/g, '""')}")`).all() as { name: string }[]).map((r) => r.name);
    },
    close() {
      db.close();
    },
  };
}

/** Open a database read-write (used for our own index). */
export function openSqlite(file: string): SqliteDb {
  const mod = loadModule();
  if (!mod) throw new Error("node:sqlite is unavailable; Node.js >= 22.13 is required");
  return wrap(new mod.DatabaseSync(file));
}

/**
 * Open a foreign database read-only. Agents keep their databases open in WAL
 * mode, so a direct read can hit `database is locked`; in that case we copy the
 * db (and its -wal sidecar) to a temp dir and read the copy.
 */
export function openSqliteReadOnly(file: string): SqliteDb | null {
  const mod = loadModule();
  if (!mod || !fs.existsSync(file)) return null;
  try {
    const db = wrap(new mod.DatabaseSync(file, { readOnly: true }));
    db.tables(); // force a read to surface lock errors early
    return db;
  } catch {
    /* fall through to copy */
  }
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-sqlite-"));
    const copy = path.join(tmp, path.basename(file));
    fs.copyFileSync(file, copy);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, copy + suffix);
    }
    const db = wrap(new mod.DatabaseSync(copy, { readOnly: false }));
    const close = db.close;
    db.close = () => {
      close();
      fs.rmSync(tmp, { recursive: true, force: true });
    };
    return db;
  } catch {
    return null;
  }
}

export function hasFts5(db: SqliteDb): boolean {
  try {
    db.exec("create virtual table if not exists __fts_probe using fts5(x); drop table __fts_probe;");
    return true;
  } catch {
    return false;
  }
}
