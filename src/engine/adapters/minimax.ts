import path from "node:path";
import type { SourceAdapter } from "../types";
import { expand, walk, xdgDataHome } from "../util/paths";
import { openSqliteReadOnly } from "../util/sqlite";
import { detection } from "./_shared";
import { hasOpencodeSchema, loadFromDb, scanDbFiles, type FamilyOptions } from "./opencode-family";

/**
 * MiniMax Code (`mcode`, and the MiniMax Code desktop app) runs an
 * OpenCode-derived backend and stores sessions in an OpenCode-schema SQLite
 * database. The exact location is still moving (storage isolation is being
 * refactored upstream), so we probe every plausible root for a database with
 * the expected tables.
 */
function roots(): string[] {
  const list = [
    process.env.MINIMAX_DATA_DIR,
    process.env.MAVIS_DATA_DIR,
    "~/.minimax",
    path.join(xdgDataHome(), "minimax-code"),
    path.join(xdgDataHome(), "minimax"),
    path.join(xdgDataHome(), "mcode"),
  ].filter((p): p is string => !!p);
  return Array.from(new Set(list.map(expand)));
}

function dbCandidates(): FamilyOptions[] {
  const out: FamilyOptions[] = [];
  for (const root of roots()) {
    for (const f of walk(root, (_p, n) => /\.(db|sqlite|sqlite3)$/.test(n), { maxDepth: 3, skipDirs: (n) => n === "node_modules" || n === "cli-auth" })) {
      const db = openSqliteReadOnly(f);
      if (!db) continue;
      const ok = hasOpencodeSchema(db);
      db.close();
      if (ok) out.push({ tool: "minimax", surface: "cli", dbPath: f });
    }
  }
  return out;
}

export const minimax: SourceAdapter = {
  id: "minimax",
  name: "MiniMax Code",
  vendor: "MiniMax",
  surface: "cli",
  configHints: ["MINIMAX_DATA_DIR (default ~/.minimax)", "MAVIS_DATA_DIR (legacy)"],
  strategies: [
    { kind: "api", status: "reserved", description: "mcode speaks ACP (Agent Client Protocol); session listing over ACP reserved." },
    { kind: "sqlite", status: "implemented", description: "OpenCode-schema SQLite database under MINIMAX_DATA_DIR / ~/.minimax / ~/.local/share/minimax-code." },
  ],
  async detect() {
    const dbs = dbCandidates();
    const d = detection([...roots().map((p) => ({ path: p })), ...dbs.map((c) => ({ path: c.dbPath, note: "OpenCode-schema db" }))]);
    d.installed = dbs.length > 0;
    d.notes = ["MiniMax Code desktop builds before the storage-isolation fix write into ~/.local/share/opencode/opencode.db; those sessions show up under OpenCode."];
    return d;
  },
  async scan(ctx) {
    return scanDbFiles(ctx, dbCandidates());
  },
  async load(summary) {
    return loadFromDb(summary, "cli");
  },
};
