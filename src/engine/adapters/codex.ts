import path from "node:path";
import fs from "node:fs";
import type { SessionDetail, SourceAdapter, ToolId } from "../types";
import { PartList } from "../parts/derive";
import { parseArgs, splitInjected } from "../parts/classify";
import { readJsonl } from "../util/jsonl";
import { expand, projectFromPath, walk } from "../util/paths";
import { buildSession } from "../util/session";
import { extractText, isRecord, normalizeRole, str } from "../util/text";
import { toIso } from "../util/time";
import { detection, fileSource, scanFiles } from "./_shared";

type Rec = Record<string, unknown>;

function codexHome(): string {
  return expand(process.env.CODEX_HOME || "~/.codex");
}

function rolloutFiles(): string[] {
  const out: string[] = [];
  for (const sub of ["sessions", "archived_sessions"]) {
    out.push(...walk(path.join(codexHome(), sub), (_p, n) => n.startsWith("rollout-") && n.endsWith(".jsonl"), { maxDepth: 5 }));
  }
  return out;
}

/**
 * Codex wraps tool output in a small header:
 *   Chunk ID: …\nWall time: …\nProcess exited with code N\nOriginal token count: …\nOutput:\n<body>
 * or for apply_patch: `Exit code: 0\nWall time: …\nOutput:\n<body>`.
 */
function unwrapOutput(raw: string): { text: string; exitCode?: number; truncated?: boolean } {
  const m = raw.match(/^(?:Chunk ID: .*\n)?(?:Wall time: .*\n)?(?:(?:Process exited with code|Exit code:?) (-?\d+)\n)?(?:Wall time: .*\n)?(?:Original token count: (\d+)\n)?Output:\n/);
  if (!m) return { text: raw };
  const body = raw.slice(m[0].length);
  const exitCode = m[1] !== undefined ? Number(m[1]) : undefined;
  return { text: body, exitCode, truncated: /\n\[\.\.\. omitted \d+ of \d+ lines \.\.\.\]/.test(body) || undefined };
}

/** Parse one Codex-format rollout file; `tool` tags the session (Open Interpreter reuses this format verbatim). */
export async function parseCodexRollout(file: string, tool: ToolId): Promise<SessionDetail | null> {
  const records = await readJsonl<Rec>(file);
  const list = new PartList();
  let id: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let model: string | undefined;
  let started: unknown;
  // Prefer the clean `event_msg/user_message` prompts when the file has them; the response_item copy carries injected context too.
  const hasEventUserMessages = records.some((r) => r.type === "event_msg" && isRecord(r.payload) && r.payload.type === "user_message");
  const callNames = new Map<string, string>(); // call_id → tool name
  const callFiles = new Map<string, string[]>(); // call_id → absolute files from patch_apply_end
  let lastAssistant: ReturnType<PartList["push"]> | undefined;

  for (const r of records) {
    const type = str(r.type);
    const payload = isRecord(r.payload) ? r.payload : undefined;
    const ts = toIso(r.timestamp);

    if (type === "session_meta" && payload) {
      id = str(payload.id) ?? str(payload.session_id) ?? id;
      cwd = str(payload.cwd) ?? cwd;
      started = payload.timestamp ?? r.timestamp;
      const git = isRecord(payload.git) ? payload.git : undefined;
      branch = str(git?.branch) ?? branch;
      continue;
    }
    // legacy first line: {id, timestamp, instructions, git}
    if (!type && str(r.id) && r.timestamp && !r.role) {
      id = str(r.id);
      started = r.timestamp;
      const git = isRecord(r.git) ? r.git : undefined;
      branch = str(git?.branch) ?? branch;
      cwd = str(r.cwd) ?? cwd;
      if (typeof r.instructions === "string" && r.instructions.trim()) list.push({ kind: "context", role: "system", form: "system", text: r.instructions, timestamp: ts });
      continue;
    }
    if (type === "turn_context" && payload) {
      cwd = cwd ?? str(payload.cwd);
      model = model ?? str(payload.model);
      continue;
    }
    if (type === "compacted") {
      const msg = str(r.message) ?? str(payload?.message) ?? "";
      const hist = Array.isArray(r.replacement_history) ? r.replacement_history.length : Array.isArray(payload?.replacement_history) ? (payload!.replacement_history as unknown[]).length : 0;
      list.push({ kind: "compaction", role: "system", text: msg || `context compacted (${hist} replacement messages)`, timestamp: ts });
      continue;
    }
    if (type === "event_msg" && payload) {
      const pt = str(payload.type);
      if (pt === "user_message") {
        list.pushUserText(extractText(payload.message), { timestamp: ts });
      } else if (pt === "turn_context") {
        model = model ?? str(payload.model);
      } else if (pt === "patch_apply_end") {
        const callId = str(payload.call_id);
        const changes = isRecord(payload.changes) ? Object.keys(payload.changes) : [];
        if (callId && changes.length) callFiles.set(callId, changes);
      } else if (pt === "token_count") {
        const info = isRecord(payload.info) ? payload.info : undefined;
        const last = isRecord(info?.last_token_usage) ? info!.last_token_usage : undefined;
        if (last && lastAssistant) lastAssistant.usage = { input: Number(last.input_tokens) || undefined, output: Number(last.output_tokens) || undefined };
      } else if (pt === "turn_aborted") {
        list.push({ kind: "event", role: "system", text: `turn aborted: ${str(payload.reason) ?? "unknown"}`, timestamp: ts });
      } else if (pt === "agent_reasoning" || pt === "agent_reasoning_delta") {
        // Codex also logs reasoning summaries as events for some versions.
        const text = str(payload.text) ?? str(payload.delta);
        if (text && pt === "agent_reasoning") list.push({ kind: "reasoning", role: "assistant", text, timestamp: ts });
      }
      continue;
    }
    const item = type === "response_item" && payload ? payload : !type && r.role ? r : type === "message" ? r : null;
    if (!item) continue;
    const itemType = str(item.type) ?? "message";
    if (itemType === "message") {
      const role = normalizeRole(item.role);
      if (!role) continue;
      const text = extractText(item.content);
      if (!text.trim()) continue;
      if (role === "system") {
        list.push({ kind: "context", role: "system", form: text.includes("<permissions instructions>") ? "instructions" : "system", text, timestamp: ts });
      } else if (role === "user") {
        if (hasEventUserMessages) {
          // Only the injected wrappers are new information here; the prompt itself came from event_msg.
          const { context } = splitInjected(text);
          for (const c of context) list.push({ kind: "context", role: "user", form: c.form, text: c.text, timestamp: ts });
        } else {
          list.pushUserText(text, { timestamp: ts });
        }
      } else if (role === "assistant") {
        lastAssistant = list.push({ kind: "reply", role: "assistant", text, timestamp: ts, model: str(item.model) });
      }
    } else if (itemType === "reasoning") {
      const summary = Array.isArray(item.summary) ? extractText(item.summary) : "";
      const content = Array.isArray(item.content) ? extractText(item.content) : "";
      const text = [summary, content].filter(Boolean).join("\n");
      if (text.trim()) list.push({ kind: "reasoning", role: "assistant", text, timestamp: ts });
    } else if (itemType === "function_call" || itemType === "custom_tool_call" || itemType === "local_shell_call" || itemType === "tool_search_call" || itemType === "web_search_call") {
      const name = str(item.name) ?? (itemType === "local_shell_call" ? "shell" : itemType === "tool_search_call" ? "tool_search" : itemType === "web_search_call" ? "web_search" : "tool");
      const args = parseArgs(item.arguments ?? item.input ?? item.action);
      const callId = str(item.call_id) ?? str(item.id);
      if (callId) callNames.set(callId, name);
      lastAssistant = list.pushToolCall(name, args, { callId, timestamp: ts });
    } else if (itemType === "function_call_output" || itemType === "custom_tool_call_output" || itemType === "tool_search_output") {
      const callId = str(item.call_id);
      const raw = itemType === "tool_search_output" ? JSON.stringify(item.tools ?? item.output ?? "") : extractText(item.output);
      if (!raw) continue;
      const { text, exitCode, truncated } = unwrapOutput(raw);
      list.pushToolResult(text, { callId, exitCode, isError: exitCode !== undefined ? exitCode !== 0 : undefined, truncated, timestamp: ts, name: callId ? callNames.get(callId) : undefined, files: callId ? callFiles.get(callId) : undefined });
    }
  }
  list.linkResults();
  // Absolute paths from patch_apply_end also enrich the matching edit call.
  for (const p of list.parts) {
    if (p.kind === "tool_call" && p.tool?.callId && callFiles.has(p.tool.callId)) p.files = Array.from(new Set([...(p.files ?? []), ...callFiles.get(p.tool.callId)!]));
  }
  if (!list.parts.length) return null;
  const base = path.basename(file, ".jsonl");
  const nativeId = id ?? base.replace(/^rollout-/, "");
  return buildSession({
    tool,
    surface: "cli",
    nativeId,
    project: projectFromPath(cwd),
    parts: list.parts,
    source: fileSource(file),
    startedAt: started,
    model,
    gitBranch: branch,
    fallbackTime: fs.statSync(file).mtimeMs,
  });
}

function parseFile(file: string): Promise<SessionDetail | null> {
  return parseCodexRollout(file, "codex");
}

export const codex: SourceAdapter = {
  id: "codex",
  name: "Codex CLI",
  vendor: "OpenAI",
  surface: "cli",
  configHints: ["CODEX_HOME (default ~/.codex)"],
  strategies: [
    { kind: "api", status: "reserved", description: "`codex app-server` JSON-RPC exposes thread/list + thread/read; adapter hook reserved." },
    { kind: "file", status: "implemented", description: "~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (+ archived_sessions/)." },
  ],
  async detect() {
    return detection([{ path: path.join(codexHome(), "sessions") }, { path: path.join(codexHome(), "archived_sessions") }]);
  },
  async scan(ctx) {
    return scanFiles(rolloutFiles(), ctx, parseFile);
  },
  async load(summary) {
    return parseFile(summary.source.path);
  },
};
