import fs from "node:fs";
import path from "node:path";
import type { Message, SessionDetail, SourceAdapter } from "../types";
import { readJsonSafe } from "../util/jsonl";
import { appDataRoots, expand, projectFromPath, walk } from "../util/paths";
import { buildSession } from "../util/session";
import { cleanPrompt, extractText, isRecord, str, summarizeToolInput } from "../util/text";
import { detection, fileSource, scanFiles } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * Trae has two very different surfaces:
 *  - Trae IDE / SOLO (ByteDance, VS Code fork): chats live in
 *    `<AppData>/Trae[ CN]/ModularData/ai-agent/database.db`, a SQLCipher-4
 *    encrypted store whose key only exists in process memory. Not readable;
 *    we detect it and point to the in-app export.
 *  - trae-agent (open-source CLI): `trajectories/trajectory_<ts>.json` files
 *    with `agent_steps[]` / `llm_interactions[]`. Fully parsed.
 */
function trajectoryRoots(): string[] {
  const roots = [process.env.TRAE_TRAJECTORY_DIR, ...(process.env.AGENTBOARD_TRAE_TRAJECTORY_DIRS?.split(path.delimiter) ?? []), "~/.trae-agent/trajectories", "~/.trae-agent"].filter((p): p is string => !!p);
  return Array.from(new Set(roots.map(expand)));
}

function trajectoryFiles(): string[] {
  const out = new Set<string>();
  for (const root of trajectoryRoots()) {
    for (const f of walk(root, (_p, n) => /^trajectory[_-].*\.json$/.test(n), { maxDepth: 4 })) out.add(f);
  }
  return Array.from(out);
}

function ideDatabases(): string[] {
  const out: string[] = [];
  for (const app of ["Trae", "Trae CN"]) {
    for (const root of appDataRoots(app)) out.push(path.join(root, "ModularData", "ai-agent", "database.db"));
  }
  return Array.from(new Set(out));
}

function parseTrajectory(file: string): SessionDetail | null {
  const t = readJsonSafe<Rec>(file);
  if (!t) return null;
  const messages: Message[] = [];
  const task = str(t.task);
  if (task) messages.push({ role: "user", text: cleanPrompt(task), timestamp: str(t.start_time) });
  const steps = Array.isArray(t.agent_steps) ? (t.agent_steps as Rec[]) : [];
  for (const step of steps) {
    const ts = str(step.timestamp);
    const resp = isRecord(step.llm_response) ? step.llm_response : undefined;
    const text = extractText(resp?.content);
    const calls = Array.isArray(step.tool_calls) ? (step.tool_calls as Rec[]) : Array.isArray(resp?.tool_calls) ? (resp!.tool_calls as Rec[]) : [];
    const toolCalls = calls.map((c) => {
      const name = str(c.name) ?? "tool";
      return { name, summary: summarizeToolInput(name, c.arguments) };
    });
    if (text.trim() || toolCalls.length) messages.push({ role: "assistant", text, timestamp: ts, model: str(resp?.model) ?? str(t.model), toolCalls: toolCalls.length ? toolCalls : undefined });
    const results = Array.isArray(step.tool_results) ? (step.tool_results as Rec[]) : [];
    for (const r of results) {
      const out = str(r.result) ?? str(r.error);
      if (out) messages.push({ role: "tool", text: out.slice(0, 4000), timestamp: ts });
    }
  }
  if (messages.length === 1 && steps.length === 0) {
    // fall back to raw llm_interactions when steps were not recorded
    const inter = Array.isArray(t.llm_interactions) ? (t.llm_interactions as Rec[]) : [];
    for (const i of inter) {
      const resp = isRecord(i.response) ? i.response : undefined;
      const text = extractText(resp?.content);
      if (text.trim()) messages.push({ role: "assistant", text, timestamp: str(i.timestamp), model: str(i.model) });
    }
  }
  const final = str(t.final_result);
  if (final && !messages.some((m) => m.role === "assistant" && m.text.includes(final))) messages.push({ role: "assistant", text: final, timestamp: str(t.end_time) });
  if (!messages.length) return null;
  // trajectories/ sits inside the project that trae-cli ran in
  const dir = path.dirname(file);
  const project = path.basename(dir) === "trajectories" ? path.dirname(dir) : dir;
  return buildSession({
    tool: "trae",
    surface: "cli",
    nativeId: path.basename(file, ".json"),
    title: task ? undefined : "trae-agent run",
    project: projectFromPath(project),
    messages,
    source: fileSource(file),
    startedAt: t.start_time,
    endedAt: t.end_time,
    model: str(t.model),
    fallbackTime: fs.statSync(file).mtimeMs,
    extra: { provider: str(t.provider), success: t.success, executionTime: t.execution_time },
  });
}

export const trae: SourceAdapter = {
  id: "trae",
  name: "Trae (IDE / SOLO / trae-agent)",
  vendor: "ByteDance",
  surface: "ide",
  configHints: ["TRAE_TRAJECTORY_DIR", "AGENTBOARD_TRAE_TRAJECTORY_DIRS (path-delimited list of project dirs containing trajectories/)"],
  strategies: [
    { kind: "api", status: "reserved", description: "Trae SOLO cloud tasks sync to solo.trae.ai / solo.trae.cn; no public API yet." },
    { kind: "sqlite", status: "unavailable", description: "Trae IDE ModularData/ai-agent/database.db is SQLCipher-4 encrypted with an in-memory key; use the in-app chat export and `agentboard import markdown`." },
    { kind: "file", status: "implemented", description: "trae-agent CLI trajectories/trajectory_<timestamp>.json (agent_steps, llm_interactions)." },
  ],
  async detect() {
    const d = detection([
      ...trajectoryRoots().map((p) => ({ path: p, note: "trae-agent trajectories" })),
      ...ideDatabases().map((p) => ({ path: p, note: "Trae IDE (encrypted, read not supported)" })),
    ]);
    if (d.locations.some((l) => l.exists && l.note?.includes("encrypted"))) {
      d.notes = ["Trae IDE chat database detected but it is SQLCipher-encrypted; export chats from Trae and import them with `agentboard import`."];
    }
    return d;
  },
  async scan(ctx) {
    return scanFiles(trajectoryFiles(), ctx, async (file) => parseTrajectory(file));
  },
  async load(summary) {
    return parseTrajectory(summary.source.path);
  },
};
