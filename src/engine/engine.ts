import type { Detection, Part, SessionDetail, SessionQuery, SessionSummary, SourceAdapter, Strategy, ToolId } from "./types";
import { IndexStore } from "./index/store";
import type { PartsStore } from "./index/parts-store";
import { outlineOf } from "./parts/derive";
import type { PartQuery, SessionOutline } from "./parts/types";
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
  private inflight: Promise<ScanReport[]> | null = null;

  constructor(indexFile?: string) {
    this.store = new IndexStore(indexFile);
  }

  close() {
    this.store.close();
  }

  /**
   * Re-index. Concurrent callers (several dashboard requests, the auto-refresh
   * timer, POST /api/scan) share one run; a full or tool-restricted scan
   * requested while an incremental run is active waits for it and then runs.
   */
  async scan(opts: ScanOptions = {}): Promise<ScanReport[]> {
    const plain = !opts.full && !opts.tools?.length;
    if (this.inflight) {
      const current = this.inflight;
      if (plain) return current;
      await current.catch(() => undefined);
    }
    const run = runScan(this.store, opts).finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  get scanning(): boolean {
    return this.inflight !== null;
  }

  /** ISO time of the most recent completed scan of any tool, if the index was ever built. */
  lastScanAt(): string | undefined {
    return this.store.lastRuns().map((r) => r.finishedAt).sort().at(-1);
  }

  /**
   * Keeps the index current without an external `agentboard scan`: runs an
   * incremental scan when the last one is older than `maxAgeMs` (or the index
   * is empty), otherwise returns immediately. Incremental scans only re-read
   * files whose size/mtime changed, so this is cheap enough to call per request.
   */
  async ensureFresh(maxAgeMs = autoScanIntervalMs()): Promise<boolean> {
    const last = this.lastScanAt();
    if (last && maxAgeMs <= 0) return false;
    const age = last ? Date.now() - new Date(last).getTime() : Infinity;
    if (age < maxAgeMs) return false;
    await this.scan();
    return true;
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

  // ---------- parts (transcript-level retrieval) ----------

  /** Parts of one session from the index; falls back to re-reading the source when the session was never part-indexed. */
  async parts(key: string, filter: Parameters<PartsStore["partsOf"]>[1] = {}): Promise<Part[]> {
    const summary = this.store.get(key);
    if (!summary) return [];
    if (!this.store.parts.meta(summary.key)) {
      const d = await this.getDetail(summary.key);
      if (d) this.store.parts.replaceSession(summary.key, d.parts, d.richParts ? "rich" : "derived");
    }
    return this.store.parts.partsOf(summary.key, filter);
  }

  async outline(key: string): Promise<SessionOutline | null> {
    const summary = this.store.get(key);
    if (!summary) return null;
    const parts = await this.parts(summary.key);
    return outlineOf(summary.key, parts);
  }

  grep(q: PartQuery) {
    if (q.sessionKey) {
      const s = this.store.get(q.sessionKey);
      if (s) q = { ...q, sessionKey: s.key };
    }
    return this.store.parts.search(q);
  }

  files(q: Parameters<PartsStore["files"]>[0] = {}) {
    if (q.sessionKey) {
      const s = this.store.get(q.sessionKey);
      if (s) q = { ...q, sessionKey: s.key };
    }
    return this.store.parts.files(q);
  }

  partCounts() {
    return this.store.parts.counts();
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

/** How stale the index may get before a dashboard request triggers an incremental scan. 0 disables. */
export function autoScanIntervalMs(): number {
  const raw = process.env.AGENTBOARD_AUTO_SCAN_SECONDS;
  if (raw === undefined || raw === "") return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 60_000;
}

let shared: Engine | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

/**
 * Process-wide engine for the Next.js server (one SQLite handle per process).
 * Also arms a background refresh so the index stays current while the server
 * runs, even when nobody is looking at the dashboard.
 */
export function getEngine(): Engine {
  if (!shared) {
    shared = new Engine();
    const every = autoScanIntervalMs();
    if (every > 0 && !refreshTimer) {
      refreshTimer = setInterval(() => {
        shared?.ensureFresh(every).catch(() => undefined);
      }, every);
      refreshTimer.unref();
    }
  }
  return shared;
}
