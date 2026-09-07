import fs from "node:fs";
import path from "node:path";
import type { Message, ScanContext, ScanResult, SessionDetail, SessionSummary, SourceAdapter, ToolCall } from "../types";
import { readJsonSafe } from "../util/jsonl";
import { appDataRoots, expand, listDirs, projectFromPath } from "../util/paths";
import { buildSession } from "../util/session";
import { cleanPrompt, isRecord, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { openSqliteReadOnly } from "../util/sqlite";
import { detection, fileSource, scanFiles } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * Cline and its forks (Roo Code, Kilo Code) are VS Code extensions. Each task
 * is a directory under the host editor's
 * `User/globalStorage/<extension-id>/tasks/<taskId>/` holding
 * `ui_messages.json` (the rendered `ClineMessage[]` timeline: `type: say|ask`,
 * `say`/`ask` subtype, `text`, `ts`) and `api_conversation_history.json` (raw
 * API turns, not used). The task index (task text, `ts`, cwd, model) lives in
 * `state/taskHistory.json` (Cline), `tasks/_index.json` `entries[]` (Roo Code)
 * or, for Kilo Code and modern Cline/Roo builds that have not flushed to disk,
 * only in the extension's globalState row of the editor's global `state.vscdb`
 * (`ItemTable.key = <extension-id>`, value JSON with `taskHistory[]`).
 * The cwd field is `cwdOnTaskInitialization` (Cline) or `workspace` (Roo/Kilo).
 */

export const EXTENSIONS: { id: string; name: string }[] = [
  { id: "saoudrizwan.claude-dev", name: "Cline" },
  { id: "rooveterinaryinc.roo-cline", name: "Roo Code" },
  { id: "kilocode.kilo-code", name: "Kilo Code" },
];

const HOSTS = ["Code", "Code - Insiders", "VSCodium", "Codium", "Cursor", "Windsurf"];

/** `say` subtypes that are API bookkeeping / UI status rather than conversation. */
const SKIP_SAY = new Set([
  "api_req_started",
  "api_req_finished",
  "api_req_retried",
  "api_req_retry_delayed",
  "deleted_api_reqs",
  "shell_integration_warning",
  "shell_integration_warning_with_suggestion",
  "checkpoint_created",
  "checkpoint_saved",
  "load_mcp_documentation",
  "info",
  "task_progress",
  "hook_status",
  "hook_output_stream",
  "conditional_rules_applied",
  "mcp_server_request_started",
  "reasoning",
  "error",
  "condense_context",
  "condense_context_error",
]);

function globalStorageRoots(): string[] {
  const out: string[] = [];
  for (const host of HOSTS) for (const r of appDataRoots(host)) out.push(path.join(r, "User", "globalStorage"));
  if (process.env.VSCODE_USER_DIRS) {
    for (const u of process.env.VSCODE_USER_DIRS.split(path.delimiter)) if (u) out.push(path.join(expand(u), "globalStorage"));
  }
  return Array.from(new Set(out));
}

interface ExtStore {
  /** `<globalStorage>/<extension-id>` */
  base: string;
  ext: { id: string; name: string };
  host: string;
}

function isRealDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function storeFor(base: string): ExtStore {
  const id = path.basename(base);
  const ext = EXTENSIONS.find((e) => e.id === id) ?? { id, name: id };
  return { base, ext, host: path.basename(path.dirname(path.dirname(path.dirname(base)))) };
}

function stores(): ExtStore[] {
  const out: ExtStore[] = [];
  for (const root of globalStorageRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const ext of EXTENSIONS) {
      const base = path.join(root, ext.id);
      if (isRealDir(base)) out.push(storeFor(base));
    }
  }
  return out;
}

function taskFiles(store: ExtStore): string[] {
  const out: string[] = [];
  for (const dir of listDirs(path.join(store.base, "tasks"))) {
    const f = path.join(dir, "ui_messages.json");
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

// ---------- task index ----------

function indexFromGlobalState(base: string): Rec[] {
  const dbPath = path.join(path.dirname(base), "state.vscdb");
  const db = openSqliteReadOnly(dbPath);
  if (!db) return [];
  try {
    if (!db.tables().includes("ItemTable")) return [];
    const row = db.get<{ value: unknown }>("select value from ItemTable where key = ?", path.basename(base));
    let raw = row?.value;
    if (raw instanceof Uint8Array) raw = Buffer.from(raw).toString("utf8");
    if (typeof raw !== "string") return [];
    const parsed: unknown = JSON.parse(raw);
    const history = isRecord(parsed) ? parsed.taskHistory : undefined;
    return Array.isArray(history) ? history.filter(isRecord) : [];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Task index entries keyed by task id, trying the Cline, Roo and globalState layouts in order. */
export function loadTaskIndex(base: string): Map<string, Rec> {
  let items: Rec[] = [];
  const cline = readJsonSafe<unknown>(path.join(base, "state", "taskHistory.json"));
  if (Array.isArray(cline) && cline.length) items = cline.filter(isRecord);
  if (!items.length) {
    const roo = readJsonSafe<Rec>(path.join(base, "tasks", "_index.json"));
    if (Array.isArray(roo?.entries) && roo.entries.length) items = (roo.entries as unknown[]).filter(isRecord);
  }
  if (!items.length) items = indexFromGlobalState(base);
  const out = new Map<string, Rec>();
  for (const item of items) {
    const id = str(item.id);
    if (id) out.set(id, item);
  }
  return out;
}

function taskCwd(item: Rec | undefined): string | undefined {
  return str(item?.cwdOnTaskInitialization) ?? str(item?.workspace);
}

function taskLabel(item: Rec | undefined): string | undefined {
  return str(item?.modelId) ?? str(item?.apiConfigName) ?? str(item?.mode);
}

// ---------- ClineMessage conversion ----------

function mapToolName(name: string): string {
  switch (name) {
    case "readFile":
      return "Read";
    case "editedExistingFile":
    case "newFileCreated":
    case "fileDeleted":
      return "Write";
    case "listFilesTopLevel":
    case "listFilesRecursive":
    case "listCodeDefinitionNames":
      return "Glob";
    case "searchFiles":
      return "Grep";
    case "webFetch":
      return "WebFetch";
    case "webSearch":
      return "WebSearch";
    default:
      return name;
  }
}

function parseJsonText(text: string): Rec | null {
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function toolMessages(text: string, ts: string | undefined): Message[] {
  const data = parseJsonText(text) ?? {};
  const name = mapToolName(str(data.tool) ?? "unknown");
  const input: Rec = {};
  for (const k of ["path", "url", "query", "filePattern"]) if (typeof data[k] === "string") input[k] = data[k];
  const regex = str(data.regex);
  const call: ToolCall = { name, summary: regex ? `pattern: ${regex.slice(0, 120)} in ${str(data.path) || "."}` : summarizeToolInput(name, input) };
  const out: Message[] = [];
  const diff = str(data.diff);
  out.push({ role: "assistant", text: diff ? "```diff\n" + diff + "\n```" : "", timestamp: ts, toolCalls: [call] });
  const content = str(data.content);
  if (content) out.push({ role: "tool", text: content.slice(0, 4000), timestamp: ts });
  return out;
}

function commandMessage(text: string, ts: string | undefined): Message | null {
  if (!text) return null;
  return { role: "assistant", text: "", timestamp: ts, toolCalls: [{ name: "Bash", summary: summarizeToolInput("Bash", { command: text }) }] };
}

function mcpMessage(text: string, ts: string | undefined): Message | null {
  const data = parseJsonText(text);
  if (!data) return text ? { role: "assistant", text, timestamp: ts } : null;
  const name = str(data.toolName) ?? str(data.uri) ?? str(data.serverName) ?? "mcp";
  const args = data.arguments ?? { server: str(data.serverName) };
  return { role: "assistant", text: "", timestamp: ts, toolCalls: [{ name, summary: summarizeToolInput(name, args) }] };
}

function browserMessage(text: string, ts: string | undefined): Message | null {
  const data = parseJsonText(text);
  if (!data) return text ? { role: "assistant", text, timestamp: ts } : null;
  const name = "browser_action";
  const input = { action: str(data.action), url: str(data.url), coordinate: str(data.coordinate), text: str(data.text) };
  return { role: "assistant", text: "", timestamp: ts, toolCalls: [{ name, summary: summarizeToolInput(name, input) }] };
}

function browserLaunchMessage(text: string, ts: string | undefined): Message | null {
  if (!text) return null;
  return { role: "assistant", text: "", timestamp: ts, toolCalls: [{ name: "browser_action", summary: `url: ${text.slice(0, 160)}` }] };
}

/** `followup` / `plan_mode_respond` / `act_mode_respond` payloads: the agent's question plus the option the user picked. */
function respondMessages(text: string, ts: string | undefined): Message[] {
  if (!text) return [];
  const data = parseJsonText(text);
  if (!data) return [{ role: "assistant", text, timestamp: ts }];
  const out: Message[] = [];
  const question = str(data.question) ?? str(data.response);
  if (question) out.push({ role: "assistant", text: question, timestamp: ts });
  const selected = str(data.selected);
  if (selected) out.push({ role: "user", text: cleanPrompt(selected), timestamp: ts });
  return out;
}

/** Convert a `ClineMessage[]` timeline (ui_messages.json) into normalized messages. */
export function convertClineMessages(raw: unknown[]): Message[] {
  const out: Message[] = [];
  let sawApiRequest = false;
  const push = (m: Message | Message[] | null) => {
    if (!m) return;
    for (const x of Array.isArray(m) ? m : [m]) if (x.text.trim() || x.toolCalls?.length) out.push(x);
  };
  for (const m of raw) {
    if (!isRecord(m)) continue;
    const ts = toIso(m.ts);
    const text = str(m.text) ?? "";
    const type = str(m.type);
    if (type === "say") {
      const say = str(m.say) ?? "";
      if (say === "api_req_started") sawApiRequest = true;
      if (SKIP_SAY.has(say)) continue;
      switch (say) {
        case "text":
          // The task itself is recorded as the first `say: text` before any API request.
          if (!sawApiRequest && !out.some((x) => x.role === "user")) push({ role: "user", text: cleanPrompt(text), timestamp: ts });
          else push({ role: "assistant", text, timestamp: ts });
          break;
        case "task":
          push({ role: "user", text: cleanPrompt(text), timestamp: ts });
          break;
        case "completion_result":
          push({ role: "assistant", text, timestamp: ts });
          break;
        case "tool":
          push(toolMessages(text, ts));
          break;
        case "command":
          push(commandMessage(text, ts));
          break;
        case "command_output":
        case "mcp_server_response":
        case "browser_action_result":
          if (text) push({ role: "tool", text: text.slice(0, 4000), timestamp: ts });
          break;
        case "use_mcp_server":
          push(mcpMessage(text, ts));
          break;
        case "browser_action":
          push(browserMessage(text, ts));
          break;
        case "browser_action_launch":
          push(browserLaunchMessage(text, ts));
          break;
        case "user_feedback":
        case "user_feedback_diff":
          push({ role: "user", text: cleanPrompt(text), timestamp: ts });
          break;
        default:
          push({ role: "assistant", text, timestamp: ts });
      }
    } else if (type === "ask") {
      switch (str(m.ask)) {
        case "followup":
        case "plan_mode_respond":
        case "act_mode_respond":
          push(respondMessages(text, ts));
          break;
        case "tool":
          push(toolMessages(text, ts));
          break;
        case "command":
          push(commandMessage(text, ts));
          break;
        case "use_mcp_server":
          push(mcpMessage(text, ts));
          break;
        case "browser_action_launch":
          push(browserLaunchMessage(text, ts));
          break;
        default:
          break; // permission / resume / completion prompts
      }
    }
  }
  return out;
}

// ---------- sessions ----------

function parseTask(file: string, index?: Map<string, Rec>): SessionDetail | null {
  const raw = readJsonSafe<unknown>(file);
  if (!Array.isArray(raw)) return null;
  const taskDir = path.dirname(file);
  const taskId = path.basename(taskDir);
  const store = storeFor(path.dirname(path.dirname(taskDir)));
  const item = (index ?? loadTaskIndex(store.base)).get(taskId);
  const messages = convertClineMessages(raw);
  const task = str(item?.task);
  if (task && !messages.some((m) => m.role === "user")) messages.unshift({ role: "user", text: cleanPrompt(task), timestamp: toIso(item?.ts) });
  if (!messages.length) return null;
  const extra: Rec = { extension: store.ext.name, extensionId: store.ext.id, host: store.host };
  for (const k of ["mode", "apiConfigName", "tokensIn", "tokensOut", "totalCost", "isFavorited"]) if (item?.[k] !== undefined) extra[k] = item[k];
  return buildSession({
    tool: "cline",
    surface: "ide",
    nativeId: `${store.ext.id}/${taskId}`,
    title: task || taskLabel(item),
    project: projectFromPath(taskCwd(item)),
    messages,
    source: fileSource(file),
    startedAt: item?.ts,
    model: str(item?.modelId),
    fallbackTime: fs.statSync(file).mtimeMs,
    extra,
  });
}

async function scanStores(ctx: ScanContext): Promise<ScanResult> {
  const result: ScanResult = { sessions: [], seen: [], warnings: [] };
  for (const store of stores()) {
    let index: Map<string, Rec> | undefined;
    const r = await scanFiles(taskFiles(store), ctx, async (file) => {
      index = index ?? loadTaskIndex(store.base);
      return parseTask(file, index);
    });
    result.sessions.push(...r.sessions);
    result.seen.push(...r.seen);
    result.warnings.push(...r.warnings);
  }
  return result;
}

export const cline: SourceAdapter = {
  id: "cline",
  name: "Cline / Roo Code / Kilo Code",
  vendor: "Cline family",
  surface: "ide",
  configHints: ["VSCODE_USER_DIRS (extra VS Code `User` folders, path-delimited)", `Probes ${HOSTS.join(", ")} for ${EXTENSIONS.map((e) => e.id).join(", ")}`],
  strategies: [
    { kind: "file", status: "implemented", description: "User/globalStorage/<extension-id>/tasks/<taskId>/ui_messages.json (ClineMessage[]: say/ask timeline with tool JSON payloads)." },
    { kind: "file", status: "implemented", description: "Task index for title/cwd/model: state/taskHistory.json (Cline) or tasks/_index.json entries[] (Roo Code); cwd from cwdOnTaskInitialization or workspace." },
    { kind: "sqlite", status: "implemented", description: "Fallback task index from the editor's global state.vscdb ItemTable row keyed by the extension id (taskHistory[]), the only index Kilo Code keeps." },
    { kind: "file", status: "reserved", description: "tasks/<taskId>/api_conversation_history.json (raw Anthropic-shaped API turns) duplicates ui_messages.json; not read." },
  ],
  async detect() {
    const roots = globalStorageRoots();
    const existing = roots.filter((r) => fs.existsSync(r));
    const locations = existing.length
      ? existing.flatMap((r) => EXTENSIONS.map((e) => ({ path: path.join(r, e.id), note: `${e.name} (${path.basename(path.dirname(path.dirname(r)))})` })))
      : roots.map((r) => ({ path: r, note: "VS Code globalStorage" }));
    return detection(locations);
  },
  async scan(ctx) {
    return scanStores(ctx);
  },
  async load(summary: SessionSummary) {
    return parseTask(summary.source.path);
  },
};
