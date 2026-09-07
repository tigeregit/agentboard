import path from "node:path";
import type { SessionDetail, SourceAdapter } from "../types";
import { readJsonl } from "../util/jsonl";
import { decodeDashedCwd, expand, walk } from "../util/paths";
import { str } from "../util/text";
import { detection, scanFiles } from "./_shared";
import { parsePiRecords } from "./pi";

type Rec = Record<string, unknown>;

/**
 * oh-my-pi (`omp`) is a fork of pi that keeps the session format byte for
 * byte (`type:"session"` header, `message` / `model_change` tree entries) but
 * relocates the store to `~/.omp/agent/sessions/<escaped-cwd>/<timestamp>_<sessionId>.jsonl`.
 * Parsing is delegated to the pi adapter's `parsePiRecords`.
 */
const SESSIONS_ROOT = "~/.omp/agent/sessions";

function files(): string[] {
  return walk(expand(SESSIONS_ROOT), (_p, n) => n.endsWith(".jsonl"), { maxDepth: 3 });
}

async function parseFile(file: string): Promise<SessionDetail | null> {
  const records = await readJsonl<Rec>(file);
  const detail = parsePiRecords(records, { tool: "ompi", file, fallbackCwd: decodeDashedCwd(path.basename(path.dirname(file))) });
  if (detail && !detail.model) {
    // omp writes `model_change.model` as one "provider/modelId" string where pi splits the two fields
    const change = records.filter((r) => r.type === "model_change" && str(r.model)).pop();
    detail.model = str(change?.model);
  }
  return detail;
}

export const ompi: SourceAdapter = {
  id: "ompi",
  name: "oh-my-pi",
  vendor: "can1357",
  surface: "cli",
  configHints: [`${SESSIONS_ROOT} (no env override)`],
  strategies: [
    { kind: "file", status: "implemented", description: "~/.omp/agent/sessions/<escaped-cwd>/<timestamp>_<sessionId>.jsonl (pi tree format, active branch followed)." },
  ],
  async detect() {
    return detection([{ path: expand(SESSIONS_ROOT) }]);
  },
  async scan(ctx) {
    return scanFiles(files(), ctx, parseFile);
  },
  async load(summary) {
    return parseFile(summary.source.path);
  },
};
