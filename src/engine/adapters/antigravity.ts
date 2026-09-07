import fs from "node:fs";
import path from "node:path";
import type { Message, ScanContext, ScanResult, SessionDetail, SourceAdapter } from "../types";
import { readJsonl, readJsonSafe } from "../util/jsonl";
import { exists, expand, home, listDirs, projectFromPath, statSafe, walk } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { cleanPrompt, isRecord, str } from "../util/text";
import { toIso } from "../util/time";
import { detection, fileSource, scanFiles } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * Two stores share the Antigravity product name and both may coexist:
 *
 *  - Antigravity CLI (`~/.gemini/antigravity-cli`, reverse-engineered):
 *      history.jsonl                     index, one line per prompt
 *                                        {display, timestamp(ms), workspace, type?, conversationId?}
 *      brain/<uuid>/.system_generated/logs/transcript_full.jsonl
 *                                        step records {step_index, source, type, status, content?, created_at?}
 *    `conversations/<uuid>.db`, `implicit/*.pb`, per-conversation markdown and
 *    `scratch/` are not parsed.
 *
 *  - Antigravity desktop app (`~/.gemini/antigravity`, else an external
 *    `<appData>/<App>/User/globalStorage/<x>/` dir holding `monitor-state.json`):
 *      monitor-state.json, monitor-state.archive-YYYY-MM.json
 *                                        antigravity-token-monitor state {sessions: {id: {latest, lifecycle}}}
 *      brain/<id>/task.md | implementation_plan.md | walkthrough.md
 *                                        first `# ` heading is the session label
 *      .token-monitor/rpc-cache/v1/<id>/usage.jsonl   {recordType:"usage", sequence, model, *Tokens, raw.chatModel.chatStartMetadata.createdAt}
 *      .token-monitor/rpc-cache/v1/<id>/steps.jsonl   {recordType:"step"} rows (counted only)
 *      .token-monitor/rpc-cache/v1/<id>/manifest.json {exportedAt, serverLastModifiedMs, stepCount}
 *      conversations/<id>.pb             protobuf transcript, undocumented schema, skipped
 *    The desktop store carries no prose; like CCHV we synthesize one
 *    user/assistant pair per usage record (`#<seq> <model>` / token counts).
 */

// ---------- Antigravity CLI ----------

const CLI_ROOT = "~/.gemini/antigravity-cli";

interface IndexEntry {
  display?: string;
  timestampMs?: number;
  workspace?: string;
}

function cliRoot(): string {
  return expand(CLI_ROOT);
}

function nonEmpty(v: unknown): string | undefined {
  const s = str(v)?.trim();
  return s || undefined;
}

/** First `history.jsonl` entry per conversation: the opening prompt doubles as title. */
async function readCliIndex(root: string): Promise<Map<string, IndexEntry>> {
  const index = new Map<string, IndexEntry>();
  const file = path.join(root, "history.jsonl");
  if (!statSafe(file)?.isFile()) return index;
  for (const rec of await readJsonl<Rec>(file)) {
    if (!isRecord(rec)) continue;
    const id = str(rec.conversationId);
    if (!id || index.has(id)) continue;
    index.set(id, { display: nonEmpty(rec.display), timestampMs: typeof rec.timestamp === "number" ? rec.timestamp : undefined, workspace: nonEmpty(rec.workspace) });
  }
  return index;
}

function cliTranscriptPath(sessionDir: string): string {
  return path.join(sessionDir, ".system_generated", "logs", "transcript_full.jsonl");
}

function cliTranscripts(root: string): string[] {
  return listDirs(path.join(root, "brain"))
    .map(cliTranscriptPath)
    .filter((p) => statSafe(p)?.isFile());
}

async function parseCliTranscript(file: string, index: Map<string, IndexEntry>): Promise<SessionDetail | null> {
  const sessionDir = path.dirname(path.dirname(path.dirname(file)));
  const conversationId = path.basename(sessionDir);
  const entry = index.get(conversationId);
  const mtime = fs.statSync(file).mtimeMs;
  let ts = toIso(entry?.timestampMs) ?? toIso(mtime);
  const messages: Message[] = [];
  for (const rec of await readJsonl<Rec>(file)) {
    if (!isRecord(rec)) continue;
    ts = toIso(rec.created_at) ?? ts;
    const source = str(rec.source) ?? "";
    const type = str(rec.type) ?? "";
    if (type === "CONVERSATION_HISTORY" || source === "SYSTEM") continue;
    const content = nonEmpty(rec.content);
    if (!content) continue;
    if (source === "USER_EXPLICIT" || type === "USER_INPUT") {
      const cleaned = cleanPrompt(content);
      if (cleaned) messages.push({ role: "user", text: cleaned, timestamp: ts });
    } else if (source === "MODEL") {
      const toolCalls = type && type !== "PLANNER_RESPONSE" ? [{ name: type }] : undefined;
      messages.push({ role: "assistant", text: content, timestamp: ts, toolCalls });
    }
  }
  if (!messages.length) return null;
  return buildSession({
    tool: "antigravity",
    surface: "cli",
    nativeId: conversationId,
    title: entry?.display,
    project: projectFromPath(entry?.workspace ?? path.dirname(path.dirname(sessionDir))),
    messages,
    source: fileSource(file),
    startedAt: entry?.timestampMs,
    fallbackTime: mtime,
    extra: { layout: "cli", workspace: entry?.workspace ?? null },
  });
}

// ---------- Antigravity desktop ----------

const MODEL_ALIASES: Record<string, string> = {
  MODEL_PLACEHOLDER_M37: "gemini-3.1-pro-high",
  MODEL_PLACEHOLDER_M36: "gemini-3.1-pro-low",
  MODEL_PLACEHOLDER_M18: "gemini-3-flash",
  MODEL_PLACEHOLDER_M8: "gemini-3-pro-high",
  MODEL_PLACEHOLDER_M7: "gemini-3-pro-low",
  MODEL_PLACEHOLDER_M9: "gemini-3-pro-image",
  MODEL_PLACEHOLDER_M26: "claude-opus-4-6-thinking",
  MODEL_PLACEHOLDER_M35: "claude-sonnet-4-6-thinking",
  MODEL_PLACEHOLDER_M12: "claude-opus-4-5-thinking",
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: "gpt-oss-120b-medium",
  MODEL_CLAUDE_4_5_SONNET: "claude-sonnet-4-5",
  MODEL_CLAUDE_4_5_SONNET_THINKING: "claude-sonnet-4-5-thinking",
};

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const LABEL_FILES = ["task.md", "implementation_plan.md", "walkthrough.md"];

function defaultDesktopRoot(): string {
  return expand("~/.gemini/antigravity");
}

function rpcCacheRoot(root: string): string {
  return path.join(root, ".token-monitor", "rpc-cache", "v1");
}

/** `<appData>/<App>/User/globalStorage/<x>/monitor-state.json` across platform config roots. */
function externalStateDirs(): string[] {
  const h = home();
  const bases = [path.join(h, "Library", "Application Support"), process.env.XDG_CONFIG_HOME || path.join(h, ".config"), process.env.APPDATA].filter((p): p is string => !!p);
  const out: string[] = [];
  for (const base of new Set(bases)) {
    for (const app of listDirs(base)) {
      for (const dir of listDirs(path.join(app, "User", "globalStorage"))) {
        if (exists(path.join(dir, "monitor-state.json"))) out.push(dir);
      }
    }
  }
  return out;
}

function desktopRoot(): string {
  const def = defaultDesktopRoot();
  if (exists(def)) return def;
  return externalStateDirs()[0] ?? def;
}

interface DesktopSession {
  id: string;
  label: string;
  /** Directory holding the session's artifacts (brain/ dir or rpc-cache dir). */
  dir: string;
  lastModifiedMs: number;
  lastSeenMs?: number;
  lifecycle: "active" | "archived";
  source: string;
  totals?: Rec;
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

function mtimeMs(p: string): number {
  return statSafe(p)?.mtimeMs ?? 0;
}

/** monitor-state.json + archives merged (archives oldest→newest, active wins). */
function loadMonitorState(root: string): DesktopSession[] {
  const files: string[] = [];
  try {
    for (const name of fs.readdirSync(root).filter((n) => /^monitor-state\.archive-.*\.json$/i.test(n)).sort()) files.push(path.join(root, name));
  } catch {
    return [];
  }
  files.push(path.join(root, "monitor-state.json"));
  const merged = new Map<string, DesktopSession>();
  for (const file of files) {
    if (!statSafe(file)?.isFile()) continue;
    const state = readJsonSafe<Rec>(file);
    if (!isRecord(state?.sessions)) continue;
    for (const [id, s] of Object.entries(state.sessions)) {
      if (!isRecord(s) || !isRecord(s.latest)) continue;
      const latest = s.latest;
      const lifecycle = isRecord(s.lifecycle) ? s.lifecycle : {};
      merged.set(id, {
        id,
        label: str(latest.label) ?? id,
        dir: str(latest.filePath) ?? path.join(rpcCacheRoot(root), id),
        lastModifiedMs: num(latest.lastModifiedMs),
        lastSeenMs: num(lifecycle.lastSeenAt) || undefined,
        lifecycle: str(lifecycle.status) === "archived" ? "archived" : "active",
        source: str(latest.source) ?? "monitor-state",
        totals: latest,
      });
    }
  }
  return Array.from(merged.values());
}

function resolveLabel(dir: string, fallback: string): string {
  for (const name of LABEL_FILES) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const m = line.trim().match(/^# (.*)$/);
      if (m) return m[1].trim().replace(/^Task:/, "").trim();
    }
  }
  return fallback;
}

function readManifest(dir: string): { exportedAt: number; serverLastModifiedMs: number; stepCount: number } {
  const v = readJsonSafe<Rec>(path.join(dir, "manifest.json"));
  return { exportedAt: num(v?.exportedAt), serverLastModifiedMs: num(v?.serverLastModifiedMs), stepCount: num(v?.stepCount) };
}

function isJunk(name: string): boolean {
  const n = name.toLowerCase();
  return n === ".ds_store" || n === "thumbs.db" || n.endsWith("~");
}

/** brain/<id> dirs joined with rpc-cache artifacts, then rpc-cache-only dirs (archived). */
function scanTokenMonitorSources(root: string): DesktopSession[] {
  const rpc = rpcCacheRoot(root);
  const out: DesktopSession[] = [];
  const seen = new Set<string>();
  for (const dir of listDirs(path.join(root, "brain"))) {
    const id = path.basename(dir);
    if (!SESSION_ID_RE.test(id)) continue;
    const files = walk(dir, (_p, n) => !isJunk(n), { maxDepth: 6 });
    const pb = path.join(root, "conversations", `${id}.pb`);
    if (statSafe(pb)?.isFile()) files.push(pb);
    if (!files.length) continue;
    let lastModified = Math.max(0, ...files.map(mtimeMs));
    const rpcDir = path.join(rpc, id);
    const usage = path.join(rpcDir, "usage.jsonl");
    const steps = path.join(rpcDir, "steps.jsonl");
    const hasRpc = exists(usage) || exists(steps);
    if (hasRpc) {
      const manifest = readManifest(rpcDir);
      lastModified = Math.max(lastModified, mtimeMs(usage), mtimeMs(steps), manifest.exportedAt, manifest.serverLastModifiedMs);
    }
    seen.add(id);
    out.push({ id, label: resolveLabel(dir, id), dir: hasRpc ? rpcDir : dir, lastModifiedMs: lastModified, lifecycle: "active", source: hasRpc ? "rpc-artifact" : "filesystem" });
  }
  for (const dir of listDirs(rpc)) {
    const id = path.basename(dir);
    if (!SESSION_ID_RE.test(id) || seen.has(id)) continue;
    const usage = path.join(dir, "usage.jsonl");
    const steps = path.join(dir, "steps.jsonl");
    if (!exists(usage) && !exists(steps)) continue;
    const manifest = readManifest(dir);
    const lastModified = Math.max(mtimeMs(usage), mtimeMs(steps), manifest.exportedAt, manifest.serverLastModifiedMs) || mtimeMs(dir);
    out.push({ id, label: resolveLabel(dir, id), dir, lastModifiedMs: lastModified, lifecycle: "archived", source: "rpc-artifact" });
  }
  return out;
}

/** Mirrors CCHV's load_antigravity_state_impl: monitor state, then rpc-cache/brain, then external monitor states. */
function desktopSessions(root: string): DesktopSession[] {
  if (exists(root)) {
    const state = loadMonitorState(root);
    if (state.length) return state;
    const built = scanTokenMonitorSources(root);
    if (built.length) return built;
  }
  for (const ext of externalStateDirs()) {
    if (ext === root) continue;
    const state = loadMonitorState(ext);
    if (state.length) return state;
  }
  return [];
}

function admitUsage(p: string): string | undefined {
  return statSafe(p)?.isFile() ? p : undefined;
}

/** `<dir>/usage.jsonl`, else the rpc-cache copy for brain-only / monitor-state sessions. */
function usagePathFor(root: string, s: DesktopSession): string | undefined {
  return admitUsage(path.join(s.dir, "usage.jsonl")) ?? admitUsage(path.join(rpcCacheRoot(root), s.id, "usage.jsonl"));
}

async function parseDesktopSession(root: string, s: DesktopSession, usagePath: string): Promise<SessionDetail | null> {
  const messages: Message[] = [];
  let stepCount = 0;
  const models = new Set<string>();
  for (const rec of await readJsonl<Rec>(usagePath)) {
    if (!isRecord(rec)) continue;
    if (str(rec.recordType) === "step") stepCount++;
    if (str(rec.recordType) !== "usage") continue;
    const sequence = num(rec.sequence);
    const rawModel = str(rec.model) ?? "unknown";
    const model = MODEL_ALIASES[rawModel] ?? rawModel;
    models.add(model);
    const raw = isRecord(rec.raw) ? rec.raw : {};
    const chat = isRecord(raw.chatModel) ? raw.chatModel : {};
    const meta = isRecord(chat.chatStartMetadata) ? chat.chatStartMetadata : {};
    const ts = toIso(meta.createdAt);
    messages.push({ role: "user", text: `#${sequence} ${model}`, timestamp: ts, model });
    messages.push({ role: "assistant", text: `in=${num(rec.inputTokens)} out=${num(rec.outputTokens)} cr=${num(rec.cacheReadTokens)} cw=${num(rec.cacheWriteTokens)}`, timestamp: ts, model });
  }
  if (!messages.length) return null;
  const rpcDir = path.join(rpcCacheRoot(root), s.id);
  const manifest = readManifest(exists(path.join(s.dir, "manifest.json")) ? s.dir : rpcDir);
  const stepsFile = [path.join(s.dir, "steps.jsonl"), path.join(rpcDir, "steps.jsonl")].find((p) => statSafe(p)?.isFile());
  if (stepsFile) stepCount += (await readJsonl<Rec>(stepsFile)).filter((r) => isRecord(r) && str(r.recordType) === "step").length;
  const short = s.id.slice(0, 8);
  return buildSession({
    tool: "antigravity",
    surface: "ide",
    nativeId: s.id,
    title: s.label !== s.id ? s.label : `Antigravity session ${short}`,
    project: projectFromPath(root),
    messages,
    source: fileSource(usagePath, s.id),
    model: models.size === 1 ? Array.from(models)[0] : undefined,
    fallbackTime: s.lastSeenMs ?? (s.lastModifiedMs || fs.statSync(usagePath).mtimeMs),
    extra: {
      layout: "desktop",
      lifecycle: s.lifecycle,
      source: s.source,
      stepCount: stepCount || manifest.stepCount || undefined,
      inputTokens: s.totals ? num(s.totals.inputTokens) : undefined,
      outputTokens: s.totals ? num(s.totals.outputTokens) : undefined,
      totalTokens: s.totals ? num(s.totals.totalTokens) : undefined,
      pbTranscript: exists(path.join(root, "conversations", `${s.id}.pb`)) ? "present (not parsed)" : undefined,
    },
  });
}

async function scanDesktop(ctx: ScanContext): Promise<ScanResult> {
  const result: ScanResult = { sessions: [], seen: [], warnings: [] };
  const root = desktopRoot();
  for (const s of desktopSessions(root)) {
    const usagePath = usagePathFor(root, s);
    const stat = usagePath ? statSafe(usagePath) : null;
    if (!usagePath || !stat) continue;
    result.seen.push({ path: usagePath, mtimeMs: stat.mtimeMs, size: stat.size });
    if (!ctx.full && ctx.isFresh(usagePath, stat.mtimeMs, stat.size)) continue;
    try {
      const d = await parseDesktopSession(root, s, usagePath);
      if (d && d.messageCount) result.sessions.push(stripDetail(d));
    } catch (err) {
      result.warnings.push(`${usagePath}: ${(err as Error).message}`);
    }
  }
  return result;
}

export const antigravity: SourceAdapter = {
  id: "antigravity",
  name: "Antigravity",
  vendor: "Google",
  surface: "ide",
  configHints: ["~/.gemini/antigravity (desktop; falls back to <appData>/<App>/User/globalStorage/*/monitor-state.json)", "~/.gemini/antigravity-cli (CLI); no env override"],
  strategies: [
    { kind: "file", status: "implemented", description: "Antigravity CLI: ~/.gemini/antigravity-cli/history.jsonl index + brain/<uuid>/.system_generated/logs/transcript_full.jsonl step records (USER_EXPLICIT/USER_INPUT → user, MODEL → assistant; SYSTEM/CONVERSATION_HISTORY skipped)." },
    { kind: "file", status: "implemented", description: "Antigravity desktop: monitor-state[.archive-*].json session map, brain/<id> labels (task.md heading) and .token-monitor/rpc-cache/v1/<id>/{usage.jsonl,steps.jsonl,manifest.json}; usage records become synthetic per-call turns (token counts only, no prose)." },
    { kind: "file", status: "unavailable", description: "~/.gemini/antigravity/conversations/<id>.pb protobuf transcripts have no public schema; CCHV only greps them for browser-tool overlay strings, which is not ported." },
    { kind: "file", status: "reserved", description: "<dataDir>/Antigravity/logs/*/ls-main.log `window.updateActuationOverlay` lines (browser tool names per cascadeId)." },
    { kind: "sqlite", status: "unavailable", description: "~/.gemini/antigravity-cli/conversations/<uuid>.db stores protobuf blobs; not parsed." },
  ],
  async detect() {
    const root = desktopRoot();
    const cli = cliRoot();
    const d = detection([
      { path: root, note: "desktop app root" },
      { path: rpcCacheRoot(root), note: "token-monitor rpc-cache (usage.jsonl)" },
      { path: path.join(root, "brain"), note: "desktop brain artifacts" },
      { path: path.join(root, "monitor-state.json"), note: "antigravity-token-monitor state" },
      { path: path.join(root, "conversations"), note: "protobuf transcripts (not parsed)" },
      { path: path.join(cli, "history.jsonl"), note: "Antigravity CLI index" },
      { path: path.join(cli, "brain"), note: "Antigravity CLI transcripts" },
    ]);
    if (exists(path.join(root, "conversations"))) d.notes = ["Desktop conversation prose lives in conversations/<id>.pb (undocumented protobuf); only token usage per call is indexed."];
    return d;
  },
  async scan(ctx) {
    const root = cliRoot();
    const index = await readCliIndex(root);
    const result = await scanFiles(cliTranscripts(root), ctx, (file) => parseCliTranscript(file, index));
    const desktop = await scanDesktop(ctx);
    result.sessions.push(...desktop.sessions);
    result.seen.push(...desktop.seen);
    result.warnings.push(...desktop.warnings);
    return result;
  },
  async load(summary) {
    const src = summary.source.path;
    if (path.basename(src) === "transcript_full.jsonl") return parseCliTranscript(src, await readCliIndex(cliRoot()));
    const root = desktopRoot();
    const s = desktopSessions(root).find((x) => x.id === summary.nativeId) ?? { id: summary.nativeId, label: resolveLabel(path.dirname(src), summary.nativeId), dir: path.dirname(src), lastModifiedMs: mtimeMs(src), lifecycle: "active" as const, source: "rpc-artifact" };
    return parseDesktopSession(root, s, src);
  },
};
