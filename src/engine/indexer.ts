import type { ScanContext, SourceAdapter, ToolId } from "./types";
import type { IndexStore } from "./index/store";
import { ADAPTERS } from "./registry";

export interface ScanReport {
  tool: ToolId;
  upserted: number;
  removed: number;
  warnings: string[];
  durationMs: number;
  error?: string;
}

export interface ScanOptions {
  tools?: ToolId[];
  full?: boolean;
  log?: (message: string) => void;
}

/**
 * Runs every adapter, feeds fresh sessions into the index and reconciles
 * removed sources. Adapters never touch the store directly.
 */
export async function runScan(store: IndexStore, opts: ScanOptions = {}): Promise<ScanReport[]> {
  const adapters = ADAPTERS.filter((a) => !opts.tools?.length || opts.tools.includes(a.id));
  const memo = new Map<string, unknown>();
  const reports: ScanReport[] = [];
  for (const adapter of adapters) {
    reports.push(await scanOne(store, adapter, { full: !!opts.full, log: opts.log, memo }));
  }
  return reports;
}

async function scanOne(store: IndexStore, adapter: SourceAdapter, base: Omit<ScanContext, "isFresh">): Promise<ScanReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const ctx: ScanContext = { ...base, isFresh: (p, m, s) => store.isFresh(adapter.id, p, m, s) };
  try {
    base.log?.(`scanning ${adapter.name}…`);
    const result = await adapter.scan(ctx);
    // Sessions may be attributed to a sibling tool (Copilot CLI/desktop/VS Code share a store).
    const own = result.sessions.filter((s) => s.tool === adapter.id);
    // A changed source file may now yield a different set of sessions: drop stale ones from those paths.
    const changedPaths = Array.from(new Set(own.map((s) => s.source.path)));
    store.deleteSessionsForPaths(adapter.id, changedPaths, new Set(own.map((s) => s.key)));
    store.upsertSessions(own);
    const removed = store.reconcileSeen(adapter.id, result.seen);
    store.recordRun(adapter.id, startedAt, own.length, removed, result.warnings);
    base.log?.(`${adapter.name}: +${own.length} sessions, -${removed}, ${result.warnings.length} warnings`);
    return { tool: adapter.id, upserted: own.length, removed, warnings: result.warnings, durationMs: Date.now() - t0 };
  } catch (err) {
    const message = (err as Error).message;
    store.recordRun(adapter.id, startedAt, 0, 0, [message]);
    base.log?.(`${adapter.name}: failed - ${message}`);
    return { tool: adapter.id, upserted: 0, removed: 0, warnings: [], durationMs: Date.now() - t0, error: message };
  }
}
