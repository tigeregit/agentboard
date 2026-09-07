import path from "node:path";
import fs from "node:fs";
import type { Message, SessionDetail, SourceAdapter } from "../types";
import { readJsonl } from "../util/jsonl";
import { expand, projectFromPath, walk } from "../util/paths";
import { buildSession } from "../util/session";
import { cleanPrompt, extractText, isRecord, normalizeRole, str, summarizeToolInput } from "../util/text";
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

const INJECTED_PREFIXES = ["<environment_context>", "<user_instructions>", "<permissions instructions>", "# AGENTS.md", "<turn_aborted>"];

function isInjected(text: string): boolean {
  const t = text.trimStart();
  return INJECTED_PREFIXES.some((p) => t.startsWith(p));
}

async function parseFile(file: string): Promise<SessionDetail | null> {
  const records = await readJsonl<Rec>(file);
  const messages: Message[] = [];
  let id: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let model: string | undefined;
  let started: unknown;
  let sawEventUserMessages = false;

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
      continue;
    }
    if (type === "turn_context" && payload) {
      cwd = cwd ?? str(payload.cwd);
      model = model ?? str(payload.model);
      continue;
    }
    if (type === "event_msg" && payload) {
      const pt = str(payload.type);
      if (pt === "user_message") {
        const text = cleanPrompt(extractText(payload.message));
        if (text && !isInjected(text)) {
          sawEventUserMessages = true;
          messages.push({ role: "user", text, timestamp: ts });
        }
      } else if (pt === "turn_context") {
        model = model ?? str(payload.model);
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
      if (role === "user") {
        if (sawEventUserMessages) continue; // event_msg already captured the clean prompt
        const cleaned = cleanPrompt(text);
        if (!cleaned || isInjected(cleaned)) continue;
        messages.push({ role, text: cleaned, timestamp: ts });
      } else if (role === "assistant") {
        if (text.trim()) messages.push({ role, text, timestamp: ts, model: str(item.model) });
      }
    } else if (itemType === "function_call" || itemType === "custom_tool_call" || itemType === "local_shell_call") {
      const name = str(item.name) ?? (itemType === "local_shell_call" ? "shell" : "tool");
      const args = item.arguments ?? item.input ?? item.action;
      messages.push({ role: "assistant", text: "", timestamp: ts, toolCalls: [{ name, summary: summarizeToolInput(name, args) }] });
    } else if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      const out = extractText(item.output);
      if (out) messages.push({ role: "tool", text: out.slice(0, 4000), timestamp: ts });
    }
  }
  if (!messages.length) return null;
  const base = path.basename(file, ".jsonl");
  const nativeId = id ?? base.replace(/^rollout-/, "");
  return buildSession({
    tool: "codex",
    surface: "cli",
    nativeId,
    project: projectFromPath(cwd),
    messages,
    source: fileSource(file),
    startedAt: started,
    model,
    gitBranch: branch,
    fallbackTime: fs.statSync(file).mtimeMs,
  });
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
