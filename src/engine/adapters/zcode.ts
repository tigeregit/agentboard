import path from "node:path";
import type { SessionSummary, SourceAdapter } from "../types";
import { readJsonl } from "../util/jsonl";
import { decodeDashedCwd, expand, listDirs, walk } from "../util/paths";
import { detection, scanFiles } from "./_shared";
import { parseClaudeShapedRecords } from "./claude-code";
import { loadFromDb, scanDbFiles } from "./opencode-family";
import { parseFlatItemRecords } from "./workbuddy";

function zcodeHome(): string {
  return expand(process.env.ZCODE_DATA_DIR || "~/.zcode");
}

function dbPath(): string {
  return path.join(zcodeHome(), "cli", "db", "db.sqlite");
}

function legacyFiles(): string[] {
  const out: string[] = [];
  for (const dir of listDirs(path.join(zcodeHome(), "projects"))) {
    out.push(...walk(dir, (_p, n) => n.endsWith(".jsonl"), { maxDepth: 3 }));
  }
  return out;
}

async function parseLegacy(file: string) {
  const records = await readJsonl<Record<string, unknown>>(file);
  const encoded = path.basename(path.dirname(file));
  const cwd = decodeDashedCwd(encoded);
  // Older ZCode wrote either Claude-shaped or flat OpenAI-item records.
  const flat = records.some((r) => r.type === "message" && r.role !== undefined);
  return flat
    ? parseFlatItemRecords(records, { tool: "zcode", file, fallbackCwd: cwd, surface: "cli" })
    : parseClaudeShapedRecords(records, { tool: "zcode", file, fallbackCwd: cwd });
}

export const zcode: SourceAdapter = {
  id: "zcode",
  name: "ZCode",
  vendor: "Zhipu / Z.ai",
  surface: "cli",
  configHints: ["ZCODE_DATA_DIR (default ~/.zcode)"],
  strategies: [
    { kind: "api", status: "reserved", description: "`zcodex app-server` (OpenCode-derived) speaks ACP session/list; hook reserved." },
    { kind: "sqlite", status: "implemented", description: "~/.zcode/cli/db/db.sqlite (OpenCode schema: session / message / part, model_usage)." },
    { kind: "file", status: "implemented", description: "Legacy ~/.zcode/projects/<encoded-cwd>/*.jsonl transcripts." },
  ],
  async detect() {
    return detection([{ path: dbPath() }, { path: path.join(zcodeHome(), "projects"), note: "legacy transcripts" }]);
  },
  async scan(ctx) {
    const result = scanDbFiles(ctx, [{ tool: "zcode", surface: "cli", dbPath: dbPath() }]);
    const legacy = await scanFiles(legacyFiles(), ctx, parseLegacy);
    result.sessions.push(...legacy.sessions);
    result.seen.push(...legacy.seen);
    result.warnings.push(...legacy.warnings);
    return result;
  },
  async load(summary: SessionSummary) {
    if (summary.source.kind === "sqlite") return loadFromDb(summary, "cli");
    return parseLegacy(summary.source.path);
  },
};
