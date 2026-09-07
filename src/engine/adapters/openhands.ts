import fs from "node:fs";
import path from "node:path";
import type { Message, ScanContext, ScanResult, SessionDetail, SourceAdapter } from "../types";
import { readJsonSafe } from "../util/jsonl";
import { expand, listDirs, projectFromPath, statSafe } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { cleanPrompt, isRecord, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { detection, fileSource } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * Classic OpenHands 0.x (`openhands/events`) file store:
 * `~/.openhands/sessions/<sid>/events/<N>.json` (N = integer event id, 0-based)
 * plus `<sid>/metadata.json` (title, created_at, last_updated_at, llm_model,
 * selected_repository, ...). Each event is `event_to_dict()`: top-level
 * `action` (ActionType) or `observation` (ObservationType) is the
 * discriminator, `source` is user|agent|environment, `action == "message"`
 * is a chat turn (`args.content`), any other action is a tool call
 * (`args.{command,code,path,thought}`) and an observation is its result
 * (`content`, linked via `cause` = action id). Older docker setups mounted the
 * store at `~/.openhands-state`, so both roots are probed.
 */
const SKIPPED_ACTIONS = new Set(["system", "null", "change_agent_state"]);

function storeRoots(): string[] {
  return Array.from(new Set(["~/.openhands", "~/.openhands-state"].map(expand)));
}

function sessionsDirs(): string[] {
  return storeRoots()
    .map((r) => path.join(r, "sessions"))
    .filter((p) => fs.existsSync(p));
}

interface OpenHandsSession {
  sid: string;
  dir: string;
  eventsDir: string;
}

function sessions(): OpenHandsSession[] {
  const out: OpenHandsSession[] = [];
  for (const root of sessionsDirs()) {
    for (const dir of listDirs(root)) {
      const eventsDir = path.join(dir, "events");
      if (statSafe(eventsDir)?.isDirectory()) out.push({ sid: path.basename(dir), dir, eventsDir });
    }
  }
  return out;
}

/** `events/<N>.json` sorted by integer N. */
function eventFiles(eventsDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(eventsDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d+\.json$/.test(n))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((n) => path.join(eventsDir, n));
}

function fingerprint(s: OpenHandsSession): { mtimeMs: number; size: number } {
  let mtimeMs = statSafe(s.dir)?.mtimeMs ?? 0;
  let size = 0;
  for (const f of [...eventFiles(s.eventsDir), path.join(s.dir, "metadata.json")]) {
    const st = statSafe(f);
    if (!st) continue;
    mtimeMs = Math.max(mtimeMs, st.mtimeMs);
    size += st.size;
  }
  return { mtimeMs, size };
}

function contentText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Mirror of CCHV `convert_event`: one classic event dict -> one message (or none). */
export function convertOpenHandsEvent(event: Rec): Message | null {
  const source = str(event.source) ?? "";
  const timestamp = toIso(event.timestamp);
  const args = isRecord(event.args) ? event.args : {};
  const action = str(event.action);
  if (action) {
    if (SKIPPED_ACTIONS.has(action)) return null;
    if (action === "message") {
      const text = str(args.content) ?? str(event.message) ?? "";
      if (!text.trim()) return null;
      if (source === "user") {
        const cleaned = cleanPrompt(text);
        return cleaned ? { role: "user", text: cleaned, timestamp } : null;
      }
      return { role: "assistant", text, timestamp };
    }
    const thought = str(args.thought) ?? "";
    return { role: "assistant", text: thought, timestamp, toolCalls: [{ name: action, summary: summarizeToolInput(action, args) }] };
  }
  if (str(event.observation) !== undefined) {
    const out = contentText(event.content);
    if (!out.trim()) return null;
    const prefix = event.observation === "error" ? "[error] " : "";
    return { role: "tool", text: (prefix + out).slice(0, 4000), timestamp };
  }
  return null;
}

function workspaceFromMeta(meta: Rec | null): string | undefined {
  if (!meta) return undefined;
  for (const k of ["workspace", "workspace_dir", "workspace_base", "working_directory", "cwd"]) {
    const v = meta[k];
    if (typeof v === "string" && v.trim()) return v;
    if (isRecord(v)) {
      const inner = str(v.path) ?? str(v.working_directory) ?? str(v.cwd);
      if (inner) return inner;
    }
  }
  return undefined;
}

function parseSession(s: OpenHandsSession): SessionDetail | null {
  const files = eventFiles(s.eventsDir);
  if (!files.length) return null;
  const messages: Message[] = [];
  for (const f of files) {
    const event = readJsonSafe<Rec>(f);
    if (!isRecord(event)) continue;
    const msg = convertOpenHandsEvent(event);
    if (msg) messages.push(msg);
  }
  if (!messages.length) return null;
  const meta = readJsonSafe<Rec>(path.join(s.dir, "metadata.json"));
  const workspace = workspaceFromMeta(meta);
  const repo = str(meta?.selected_repository);
  const branch = str(meta?.selected_branch);
  const mtime = Math.max(...files.map((f) => statSafe(f)?.mtimeMs ?? 0), statSafe(s.dir)?.mtimeMs ?? 0);
  return buildSession({
    tool: "openhands",
    surface: "cli",
    nativeId: s.sid,
    title: str(meta?.title),
    project: projectFromPath(workspace ?? path.dirname(path.dirname(s.dir))),
    messages,
    source: fileSource(s.dir),
    startedAt: meta?.created_at,
    endedAt: meta?.last_updated_at,
    model: str(meta?.llm_model),
    gitBranch: branch,
    fallbackTime: mtime,
    extra: { eventCount: files.length, repository: repo, trigger: str(meta?.trigger), conversationId: str(meta?.conversation_id) },
  });
}

function scanSessions(ctx: ScanContext): ScanResult {
  const result: ScanResult = { sessions: [], seen: [], warnings: [] };
  for (const s of sessions()) {
    const fp = fingerprint(s);
    result.seen.push({ path: s.dir, ...fp });
    if (!ctx.full && ctx.isFresh(s.dir, fp.mtimeMs, fp.size)) continue;
    try {
      const d = parseSession(s);
      if (d && d.messageCount > 0) result.sessions.push(stripDetail(d));
    } catch (err) {
      result.warnings.push(`${s.dir}: ${(err as Error).message}`);
    }
  }
  return result;
}

export const openhands: SourceAdapter = {
  id: "openhands",
  name: "OpenHands",
  vendor: "All Hands AI",
  surface: "cli",
  configHints: ["~/.openhands/sessions (classic file_store_path default)", "~/.openhands-state/sessions (older docker mount)"],
  strategies: [
    { kind: "api", status: "reserved", description: "OpenHands server REST API (/api/conversations/<id>/events) when the app server is running; not used, files are read directly." },
    { kind: "file", status: "implemented", description: "~/.openhands/sessions/<sid>/events/<N>.json (action|observation discriminator, source user|agent|environment, args.content / content, cause link) + <sid>/metadata.json (title, created_at, last_updated_at, llm_model, selected_repository/branch)." },
    { kind: "file", status: "reserved", description: "OpenHands V1 (software-agent-sdk / new CLI): per-conversation persistence dir (~/.openhands/conversations/<conversation_id>/ or a cwd-relative workspace dir) holding base_state.json + events/<timestamp>-<event_id>.json with kind-tagged event records; different schema, not covered." },
  ],
  async detect() {
    return detection(storeRoots().map((r) => ({ path: path.join(r, "sessions"), note: "<sid>/events/<N>.json + metadata.json" })));
  },
  async scan(ctx) {
    return scanSessions(ctx);
  },
  async load(summary) {
    const dir = summary.source.path;
    return parseSession({ sid: path.basename(dir), dir, eventsDir: path.join(dir, "events") });
  },
};
