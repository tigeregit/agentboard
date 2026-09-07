import path from "node:path";
import type { SourceAdapter } from "../types";
import { expand, walk } from "../util/paths";
import { detection, scanFiles } from "./_shared";
import { parseCodexRollout } from "./codex";

/**
 * Open Interpreter v1 is a re-rooted fork of OpenAI Codex and writes the
 * identical rollout JSONL (`session_meta`, `response_item`, `event_msg`, …)
 * under `~/.openinterpreter/sessions/**` and `archived_sessions/**` as
 * `rollout-*.jsonl`. The home is overridable via `INTERPRETER_HOME` only
 * (`CODEX_HOME` is deliberately ignored). Sessions group by the `cwd` carried
 * in `session_meta`, exactly like Codex, so the Codex parser is reused.
 */
function interpreterHome(): string {
  return expand(process.env.INTERPRETER_HOME?.trim() || "~/.openinterpreter");
}

function sessionRoots(): string[] {
  return ["sessions", "archived_sessions"].map((sub) => path.join(interpreterHome(), sub));
}

function rolloutFiles(): string[] {
  const out: string[] = [];
  for (const root of sessionRoots()) out.push(...walk(root, (_p, n) => n.startsWith("rollout-") && n.endsWith(".jsonl"), { maxDepth: 5 }));
  return out;
}

export const openinterpreter: SourceAdapter = {
  id: "openinterpreter",
  name: "Open Interpreter",
  vendor: "Open Interpreter",
  surface: "cli",
  configHints: ["INTERPRETER_HOME (default ~/.openinterpreter; CODEX_HOME is not honoured)"],
  strategies: [
    { kind: "file", status: "implemented", description: "~/.openinterpreter/sessions/**/rollout-*.jsonl (+ archived_sessions/), Codex rollout format parsed by the Codex adapter." },
  ],
  async detect() {
    return detection(sessionRoots().map((p) => ({ path: p })));
  },
  async scan(ctx) {
    return scanFiles(rolloutFiles(), ctx, (file) => parseCodexRollout(file, "openinterpreter"));
  },
  async load(summary) {
    return parseCodexRollout(summary.source.path, "openinterpreter");
  },
};
