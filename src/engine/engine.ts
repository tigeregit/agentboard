import type { Detection, SessionDetail, SessionQuery, SessionSummary, SourceAdapter, Strategy, ToolId } from "./types";
import { IndexStore } from "./index/store";
import { runScan, type ScanOptions, type ScanReport } from "./indexer";
import { ADAPTERS, adapterFor } from "./registry";
import { periodRange, summarize, type Period, type PeriodSummary } from "./summary";
import { browserProviderFor } from "./webchat/browser";

export interface SourceStatus {
  id: ToolId;
  name: string;
  vendor: string;
  surface: SourceAdapter["surface"];
  strategies: Strategy[];
  configHints: string[];
  detection: Detection;
  sessionCount: number;
  lastActivity: string | null;
  lastScan: { finishedAt: string; upserted: number; removed: number; warnings: string[] } | null;
}

/**
 * Single facade used by both the CLI and the dashboard API routes.
 * Cheap to construct; holds one SQLite handle to the index.
 */
export class Engine {
  readonly store: IndexStore;

  constructor(indexFile?: string) {
    this.store = new IndexStore(indexFile);
  }

  close() {
    this.store.close();
  }

  scan(opts: ScanOptions = {}): Promise<ScanReport[]> {
    return runScan(this.store, opts);
  }

  list(q: SessionQuery) {
    return this.store.query(q);
  }

  getSummary(key: string): SessionSummary | null {
    return this.store.get(key);
  }

  async getDetail(key: string): Promise<SessionDetail | null> {
    const summary = this.store.get(key);
    if (!summary) return null;
    const adapter = adapterFor(summary.tool);
    if (!adapter) return null;
    const browser = browserProviderFor(summary);
    if (browser && summary.source.kind === "api" && (await browser.available())) {
      const d = await browser.fetchConversation({ id: summary.nativeId });
      if (d) return d;
    }
    const detail = await adapter.load(summary);
    if (!detail) return null;
    // Keep index-level fields authoritative (title edits, attribution) but take the transcript from source.
    return { ...detail, key: summary.key, tool: summary.tool, surface: summary.surface, title: detail.title || summary.title };
  }

  children(key: string) {
    return this.store.children(key);
  }

  projects(q: SessionQuery = {}) {
    return this.store.projects(q);
  }

  toolStats(q: SessionQuery = {}) {
    return this.store.toolStats(q);
  }

  days(q: SessionQuery = {}) {
    return this.store.days(q);
  }

  counts() {
    return this.store.counts();
  }

  async sources(): Promise<SourceStatus[]> {
    const stats = new Map(this.store.toolStats().map((s) => [s.tool, s]));
    const runs = new Map(this.store.lastRuns().map((r) => [r.tool, r]));
    const out: SourceStatus[] = [];
    for (const a of ADAPTERS) {
      let detection: Detection;
      try {
        detection = await a.detect();
      } catch (err) {
        detection = { installed: false, locations: [], notes: [`detect failed: ${(err as Error).message}`] };
      }
      const st = stats.get(a.id);
      const run = runs.get(a.id);
      out.push({
        id: a.id,
        name: a.name,
        vendor: a.vendor,
        surface: a.surface,
        strategies: a.strategies,
        configHints: a.configHints,
        detection,
        sessionCount: st?.sessionCount ?? 0,
        lastActivity: st?.lastActivity ?? null,
        lastScan: run ? { finishedAt: run.finishedAt, upserted: run.upserted, removed: run.removed, warnings: run.warnings } : null,
      });
    }
    return out;
  }

  periodSummary(period: Period, anchor: Date = new Date(), filters: Omit<SessionQuery, "since" | "until" | "limit" | "offset"> = {}): PeriodSummary {
    const range = periodRange(period, anchor);
    const q: SessionQuery = { ...filters, since: range.since, until: range.until, limit: 2000, order: "asc" };
    const { items } = this.store.query(q);
    return summarize(range, items, this.store.toolStats(q), this.store.projects(q));
  }
}

let shared: Engine | null = null;

/** Process-wide engine for the Next.js server (one SQLite handle per process). */
export function getEngine(): Engine {
  if (!shared) shared = new Engine();
  return shared;
}
