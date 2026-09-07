import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Message, ScanContext, ScanResult, SessionDetail, SessionSummary, SourceAdapter, ToolId } from "../types";
import { readJsonl } from "../util/jsonl";
import { expand, listDirs, projectFromPath, statSafe } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { cleanPrompt, extractText, isRecord, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { openSqliteReadOnly } from "../util/sqlite";
import { detection, fileSource, memo } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * GitHub Copilot CLI and the GitHub Copilot desktop app share one store:
 * `~/.copilot/session-state/<id>/events.jsonl` (+ workspace.yaml). The app
 * additionally tracks its sessions in `~/.copilot/data.db`; the CLI keeps a
 * cross-session index in `session-store.db`. We parse the event log once and
 * attribute each session to the surface that produced it.
 */
function copilotHome(): string {
  return expand(process.env.COPILOT_HOME || "~/.copilot");
}

function sessionStateDir(): string {
  return path.join(copilotHome(), "session-state");
}

interface Workspace {
  id?: string;
  cwd?: string;
  git_root?: string;
  repository?: string;
  host_type?: string;
  branch?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
}

function readWorkspace(dir: string): Workspace {
  try {
    const parsed = YAML.parse(fs.readFileSync(path.join(dir, "workspace.yaml"), "utf8"));
    return isRecord(parsed) ? (parsed as Workspace) : {};
  } catch {
    return {};
  }
}

/** Session ids that the desktop app owns, from data.db when present. */
function desktopSessionIds(): Set<string> {
  const ids = new Set<string>();
  const db = openSqliteReadOnly(path.join(copilotHome(), "data.db"));
  if (!db) return ids;
  try {
    if (db.tables().includes("sessions")) {
      for (const row of db.all<{ id: string }>("select id from sessions")) ids.add(String(row.id));
    }
  } catch {
    /* schema drift */
  } finally {
    db.close();
  }
  return ids;
}

function classify(ws: Workspace, id: string, desktopIds: Set<string>): ToolId {
  const host = (ws.host_type ?? "").toLowerCase();
  if (/app|desktop|electron/.test(host)) return "copilot-desktop";
  if (/vscode|code/.test(host)) return "vscode-copilot";
  if (host === "cli" || host === "terminal") return "copilot-cli";
  return desktopIds.has(id) ? "copilot-desktop" : "copilot-cli";
}

async function parseSessionDir(dir: string, desktopIds: Set<string>): Promise<SessionDetail | null> {
  const eventsFile = path.join(dir, "events.jsonl");
  if (!fs.existsSync(eventsFile)) return null;
  const ws = readWorkspace(dir);
  const events = await readJsonl<Rec>(eventsFile);
  const messages: Message[] = [];
  let id = ws.id ?? path.basename(dir);
  let cwd = ws.cwd ?? ws.git_root;
  let branch = ws.branch;
  let repo = ws.repository;
  let model: string | undefined;
  let filesModified: unknown;

  for (const ev of events) {
    const type = str(ev.type);
    const data = isRecord(ev.data) ? ev.data : {};
    const ts = toIso(ev.timestamp);
    switch (type) {
      case "session.start": {
        id = str(data.sessionId) ?? id;
        const ctx = isRecord(data.context) ? data.context : {};
        cwd = cwd ?? str(ctx.cwd) ?? str(ctx.gitRoot);
        branch = branch ?? str(ctx.branch);
        repo = repo ?? str(ctx.repository);
        break;
      }
      case "session.model_change":
        model = str(data.model) ?? str(data.newModel) ?? model;
        break;
      case "user.message": {
        const text = cleanPrompt(extractText(data.content));
        if (text) messages.push({ role: "user", text, timestamp: ts });
        break;
      }
      case "assistant.message": {
        const text = extractText(data.content);
        const reqs = Array.isArray(data.toolRequests) ? (data.toolRequests as Rec[]) : [];
        const toolCalls = reqs.map((r) => ({ name: str(r.name) ?? str(r.toolName) ?? "tool", summary: str(r.intentionSummary) ?? summarizeToolInput(str(r.name) ?? "tool", r.arguments) }));
        if (text.trim() || toolCalls.length) messages.push({ role: "assistant", text, timestamp: ts, model: str(data.model) ?? model, toolCalls: toolCalls.length ? toolCalls : undefined });
        break;
      }
      case "tool.execution_start": {
        // Only record here if the assistant.message did not already list it.
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant" || !last.toolCalls?.length) {
          const name = str(data.toolName) ?? "tool";
          messages.push({ role: "assistant", text: "", timestamp: ts, toolCalls: [{ name, summary: summarizeToolInput(name, data.arguments) }] });
        }
        break;
      }
      case "session.shutdown": {
        model = model ?? str(data.model);
        const changes = isRecord(data.codeChanges) ? data.codeChanges : undefined;
        filesModified = changes?.filesModified;
        break;
      }
    }
  }
  if (!messages.length) return null;
  const tool = classify(ws, id, desktopIds);
  return buildSession({
    tool,
    surface: tool === "copilot-desktop" ? "desktop" : tool === "vscode-copilot" ? "ide" : "cli",
    nativeId: id,
    title: ws.summary,
    project: projectFromPath(cwd ?? repo),
    messages,
    source: fileSource(eventsFile),
    startedAt: ws.created_at,
    endedAt: ws.updated_at,
    model,
    gitBranch: branch,
    fallbackTime: fs.statSync(eventsFile).mtimeMs,
    extra: { repository: repo, hostType: ws.host_type, filesModified },
  });
}

async function scanAll(ctx: ScanContext): Promise<ScanResult> {
  return memo(ctx, "copilot:scan", async () => {
    const result: ScanResult = { sessions: [], seen: [], warnings: [] };
    const desktopIds = desktopSessionIds();
    for (const dir of listDirs(sessionStateDir())) {
      const eventsFile = path.join(dir, "events.jsonl");
      const stat = statSafe(eventsFile);
      if (!stat) continue;
      const ws = statSafe(path.join(dir, "workspace.yaml"));
      const mtimeMs = Math.max(stat.mtimeMs, ws?.mtimeMs ?? 0);
      result.seen.push({ path: eventsFile, mtimeMs, size: stat.size });
      if (!ctx.full && ctx.isFresh(eventsFile, mtimeMs, stat.size)) continue;
      try {
        const d = await parseSessionDir(dir, desktopIds);
        if (d) result.sessions.push(stripDetail(d));
      } catch (err) {
        result.warnings.push(`${eventsFile}: ${(err as Error).message}`);
      }
    }
    return result;
  });
}

function makeAdapter(id: "copilot-cli" | "copilot-desktop"): SourceAdapter {
  const isDesktop = id === "copilot-desktop";
  return {
    id,
    name: isDesktop ? "GitHub Copilot app (desktop)" : "GitHub Copilot CLI",
    vendor: "GitHub",
    surface: isDesktop ? "desktop" : "cli",
    configHints: ["COPILOT_HOME (default ~/.copilot)"],
    strategies: [
      { kind: "api", status: "reserved", description: "Sessions sync to your GitHub account (/chronicle); no public REST query surface yet." },
      { kind: "native-index", status: isDesktop ? "implemented" : "reserved", description: isDesktop ? "~/.copilot/data.db `sessions` table used to attribute sessions to the desktop app." : "~/.copilot/session-store.db powers /chronicle; schema is internal, reserved for enrichment." },
      { kind: "file", status: "implemented", description: "~/.copilot/session-state/<id>/events.jsonl + workspace.yaml (shared by CLI, desktop app and VS Code hosts)." },
    ],
    async detect() {
      return detection([
        { path: sessionStateDir() },
        { path: path.join(copilotHome(), isDesktop ? "data.db" : "session-store.db"), note: isDesktop ? "desktop app database" : "CLI session index" },
      ]);
    },
    async scan(ctx) {
      const all = await scanAll(ctx);
      return { sessions: all.sessions.filter((s) => s.tool === id), seen: all.seen, warnings: all.warnings };
    },
    async load(summary: SessionSummary) {
      const d = await parseSessionDir(path.dirname(summary.source.path), desktopSessionIds());
      if (!d) return null;
      // keep the tool the index attributed, even if classification drifted
      d.tool = summary.tool;
      d.key = summary.key;
      d.surface = summary.surface;
      return d;
    },
  };
}

export const copilotCli = makeAdapter("copilot-cli");
export const copilotDesktop = makeAdapter("copilot-desktop");

/** Exposed so the VS Code adapter can pick up Copilot sessions hosted by VS Code that land in ~/.copilot. */
export async function copilotSessionsForTool(ctx: ScanContext, tool: ToolId): Promise<ScanResult> {
  const all = await scanAll(ctx);
  // `seen` must include the shared store, otherwise reconcile would drop these sessions again.
  return { sessions: all.sessions.filter((s) => s.tool === tool), seen: all.seen, warnings: [] };
}

export { parseSessionDir as parseCopilotSessionDir, desktopSessionIds as copilotDesktopSessionIds };
