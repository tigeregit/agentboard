import type { ScanContext, SessionDetail, SourceAdapter, ToolId } from "./types";
import type { IndexStore } from "./index/store";
import { ADAPTERS } from "./registry";

export interface ScanReport {
  tool: ToolId;
  upserted: number;
  removed: number;
  /** Sessions whose parts were (re)indexed in this run. */
  partsIndexed: number;
  warnings: string[];
  durationMs: number;
  error?: string;
}

export interface ScanOptions {
  tools?: ToolId[];
  full?: boolean;
  /** Skip the part index (summaries only). */
  noParts?: boolean;
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
    reports.push(await scanOne(store, adapter, { full: !!opts.full, log: opts.log, memo }, opts));
  }
  return reports;
}

async function scanOne(store: IndexStore, adapter: SourceAdapter, base: Omit<ScanContext, "isFresh">, opts: ScanOptions): Promise<ScanReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  // Details handed over by adapters during the scan, so parts need no second read of the source.
  const delivered = new Map<string, SessionDetail>();
  const ctx: ScanContext = {
    ...base,
    isFresh: (p, m, s) => store.isFresh(adapter.id, p, m, s),
    onSession: opts.noParts ? undefined : (d) => delivered.set(d.key, d),
  };
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

    let partsIndexed = 0;
    if (!opts.noParts) {
      // 1. parts for sessions parsed in this run
      for (const s of own) {
        const d = delivered.get(s.key);
        if (d) {
          store.parts.replaceSession(s.key, d.parts, d.richParts ? "rich" : "derived");
          partsIndexed++;
        }
      }
      // 2. backfill: sessions (fresh or historical) that still have no parts → re-read through load()
      const pending = store.keysWithoutParts(adapter.id);
      if (pending.length) base.log?.(`${adapter.name}: indexing parts for ${pending.length} sessions…`);
      for (const key of pending) {
        const summary = store.get(key);
        if (!summary) continue;
        try {
          const d = await adapter.load(summary);
          if (d) {
            store.parts.replaceSession(key, d.parts, d.richParts ? "rich" : "derived");
            partsIndexed++;
          } else {
            store.parts.replaceSession(key, [], "unavailable");
          }
        } catch (err) {
          result.warnings.push(`${key}: parts not indexed (${(err as Error).message})`);
          store.parts.replaceSession(key, [], "unavailable");
        }
      }
    }

    store.recordRun(adapter.id, startedAt, own.length, removed, result.warnings);
    base.log?.(`${adapter.name}: +${own.length} sessions, -${removed}, ${partsIndexed} parts-indexed, ${result.warnings.length} warnings`);
    return { tool: adapter.id, upserted: own.length, removed, partsIndexed, warnings: result.warnings, durationMs: Date.now() - t0 };
  } catch (err) {
    const message = (err as Error).message;
    store.recordRun(adapter.id, startedAt, 0, 0, [message]);
    base.log?.(`${adapter.name}: failed - ${message}`);
    return { tool: adapter.id, upserted: 0, removed: 0, partsIndexed: 0, warnings: [], durationMs: Date.now() - t0, error: message };
  }
}
