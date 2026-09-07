import fs from "node:fs";
import type { Detection, ScanContext, ScanResult, SessionDetail, SessionSummary, SourceRef } from "../types";
import { stripDetail } from "../util/session";
import { exists, statSafe } from "../util/paths";

export function fileSource(path: string, locator?: string): SourceRef {
  return { kind: "file", path, locator };
}

export function sqliteSource(path: string, locator?: string): SourceRef {
  return { kind: "sqlite", path, locator };
}

export function detection(paths: { path: string; note?: string }[], notes?: string[]): Detection {
  const locations = paths.map((p) => ({ path: p.path, exists: exists(p.path), note: p.note }));
  return { installed: locations.some((l) => l.exists), locations, notes };
}

/**
 * Generic "one or more sessions per file" scanner. Handles freshness checks,
 * fingerprints and error isolation so adapters only implement `parse`.
 */
export async function scanFiles(
  files: string[],
  ctx: ScanContext,
  parse: (file: string, stat: fs.Stats) => Promise<SessionDetail[] | SessionDetail | null>,
): Promise<ScanResult> {
  const result: ScanResult = { sessions: [], seen: [], warnings: [] };
  for (const file of files) {
    const stat = statSafe(file);
    if (!stat) continue;
    result.seen.push({ path: file, mtimeMs: stat.mtimeMs, size: stat.size });
    if (!ctx.full && ctx.isFresh(file, stat.mtimeMs, stat.size)) continue;
    try {
      const parsed = await parse(file, stat);
      if (!parsed) continue;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const d of list) {
        if (d.messageCount === 0 && !d.parts.length) continue;
        result.sessions.push(stripDetail(d));
        ctx.onSession?.(d);
      }
    } catch (err) {
      result.warnings.push(`${file}: ${(err as Error).message}`);
    }
  }
  return result;
}

/** Memoize an expensive per-scan computation across adapters sharing a store. */
export async function memo<T>(ctx: ScanContext, key: string, compute: () => Promise<T>): Promise<T> {
  const m = ctx.memo;
  if (m?.has(key)) return m.get(key) as T;
  const v = await compute();
  m?.set(key, v);
  return v;
}

export function summaryMatches(a: SessionSummary, file: string): boolean {
  return a.source.path === file;
}
