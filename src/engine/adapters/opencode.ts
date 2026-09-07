import fs from "node:fs";
import path from "node:path";
import type { Message, ScanContext, ScanResult, SessionDetail, SessionSummary, SourceAdapter } from "../types";
import { expand, projectFromPath, xdgDataHome } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { isRecord, str } from "../util/text";
import { detection } from "./_shared";
import { apiMessageToMessage, loadFromDb, readLegacyStorage, scanDbFiles, type FamilyOptions } from "./opencode-family";

function dataDir(): string {
  return path.join(xdgDataHome(), "opencode");
}

function dbCandidates(): FamilyOptions[] {
  const out: string[] = [];
  if (process.env.OPENCODE_DB) out.push(expand(process.env.OPENCODE_DB));
  const dir = dataDir();
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^opencode(-[\w.]+)?\.db$/.test(f)) out.push(path.join(dir, f));
    }
  } catch {
    /* not installed */
  }
  // some builds keep the db inside storage/
  out.push(path.join(dir, "storage", "opencode.db"));
  return Array.from(new Set(out)).map((dbPath) => ({ tool: "opencode", surface: "cli" as const, dbPath }));
}

function serverUrl(): string | undefined {
  return process.env.OPENCODE_SERVER_URL?.replace(/\/$/, "");
}

/** Native query API: `opencode serve` exposes /session and /session/:id/message. */
async function scanViaApi(url: string): Promise<ScanResult> {
  const result: ScanResult = { sessions: [], seen: [], warnings: [] };
  const res = await fetch(`${url}/session`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`GET /session -> ${res.status}`);
  const sessions = (await res.json()) as Record<string, unknown>[];
  for (const s of sessions) {
    const id = str(s.id);
    if (!id) continue;
    try {
      const detail = await loadViaApi(url, id, s);
      if (detail) result.sessions.push(stripDetail(detail));
    } catch (err) {
      result.warnings.push(`${id}: ${(err as Error).message}`);
    }
  }
  result.seen.push({ path: url, mtimeMs: Date.now(), size: sessions.length });
  return result;
}

async function loadViaApi(url: string, id: string, info?: Record<string, unknown>): Promise<SessionDetail | null> {
  if (!info) {
    const r = await fetch(`${url}/session/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    info = (await r.json()) as Record<string, unknown>;
  }
  const res = await fetch(`${url}/session/${encodeURIComponent(id)}/message`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`GET /session/${id}/message -> ${res.status}`);
  const entries = (await res.json()) as Record<string, unknown>[];
  const messages = entries.map(apiMessageToMessage).filter((m): m is Message => !!m);
  if (!messages.length) return null;
  const time = isRecord(info.time) ? info.time : {};
  return buildSession({
    tool: "opencode",
    surface: "cli",
    nativeId: id,
    title: str(info.title),
    project: projectFromPath(str(info.directory)),
    messages,
    source: { kind: "api", path: url, locator: id },
    startedAt: time.created,
    endedAt: time.updated,
  });
}

export const opencode: SourceAdapter = {
  id: "opencode",
  name: "OpenCode",
  vendor: "Anomaly / SST",
  surface: "cli",
  configHints: ["OPENCODE_SERVER_URL (use a running `opencode serve`)", "OPENCODE_DB", "XDG_DATA_HOME (default ~/.local/share)"],
  strategies: [
    { kind: "api", status: "implemented", description: "`opencode serve` HTTP API (GET /session, /session/:id/message) when OPENCODE_SERVER_URL is set." },
    { kind: "sqlite", status: "implemented", description: "~/.local/share/opencode/opencode.db (session / message / part tables)." },
    { kind: "file", status: "implemented", description: "Legacy ~/.local/share/opencode/storage/{session,message,part}/*.json." },
  ],
  async detect() {
    const d = detection([
      ...dbCandidates().map((c) => ({ path: c.dbPath })),
      { path: path.join(dataDir(), "storage", "session"), note: "legacy JSON storage" },
    ]);
    if (serverUrl()) d.notes = [`API strategy active: ${serverUrl()}`];
    return d;
  },
  async scan(ctx: ScanContext) {
    const url = serverUrl();
    if (url) {
      try {
        return await scanViaApi(url);
      } catch (err) {
        ctx.log?.(`opencode: API ${url} failed (${(err as Error).message}); falling back to local store`);
      }
    }
    const result = scanDbFiles(ctx, dbCandidates());
    const legacy = path.join(dataDir(), "storage");
    if (fs.existsSync(path.join(legacy, "session"))) {
      const key = path.join(legacy, "session");
      const stat = fs.statSync(key);
      result.seen.push({ path: key, mtimeMs: stat.mtimeMs, size: 0 });
      if (ctx.full || !ctx.isFresh(key, stat.mtimeMs, 0)) {
        for (const d of readLegacyStorage({ tool: "opencode", surface: "cli", storageDir: legacy })) result.sessions.push(stripDetail(d));
      }
    }
    return result;
  },
  async load(summary: SessionSummary) {
    if (summary.source.kind === "api") return loadViaApi(summary.source.path, summary.nativeId);
    if (summary.source.kind === "sqlite") return loadFromDb(summary, "cli");
    const storageDir = path.dirname(path.dirname(path.dirname(summary.source.path)));
    return readLegacyStorage({ tool: "opencode", surface: "cli", storageDir }, summary.nativeId)[0] ?? null;
  },
};
