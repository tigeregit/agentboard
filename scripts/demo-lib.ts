import type { SqliteDb } from "../src/engine/util/sqlite";

/** Shared helpers handed to per-tool fixture generators in scripts/fixtures/. */
export interface Demo {
  /** Fake $HOME every fixture must write under. */
  HOME: string;
  now: number;
  /** One hour / one day in ms. */
  H: number;
  D: number;
  PROJECTS: string[];
  PROMPTS: string[];
  REPLIES: string[];
  TOOLS: string[];
  rnd<T>(list: T[], i: number): T;
  ensure(p: string): string;
  write(p: string, content: string | Buffer): void;
  jsonl(lines: unknown[]): string;
  iso(t: number): string;
  uuid(seed: string): string;
  md5ish(s: string): string;
  /** Deterministic turn plan for session `i` starting at `start`. */
  turns(i: number, start: number): { user: string; reply: string; tool: string; t: number }[];
  /** Allocates the next session slot: index, start time and project cwd. */
  next(): { i: number; start: number; cwd: string };
  /** zstd stored-block frame (Node 22.14 has no encoder). */
  compress(input: Uint8Array): Uint8Array;
  openSqlite(file: string): SqliteDb;
}

export type Fixture = (d: Demo) => void;
