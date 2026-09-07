import fs from "node:fs";
import path from "node:path";
import type { Detection, SessionDetail, SourceAdapter, Strategy, Surface, ToolId } from "../types";
import { readJsonSafe } from "../util/jsonl";
import { agentboardHome } from "../util/paths";
import { scanFiles } from "../adapters/_shared";

/**
 * Normalized sessions written by `agentboard import ...` live under
 * `~/.agentboard/imports/<tool>/<id>.json`. This factory produces an adapter
 * that serves them for a given tool id, so imported web-chat history and
 * exported IDE chats flow through the same index as everything else.
 */
export function importDir(tool: ToolId): string {
  const dir = path.join(agentboardHome(), "imports", tool);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeImported(detail: SessionDetail): string {
  const file = path.join(importDir(detail.tool), `${safeName(detail.nativeId)}.json`);
  fs.writeFileSync(file, JSON.stringify(detail));
  return file;
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
}

export function importedAdapter(opts: {
  id: ToolId;
  name: string;
  vendor: string;
  surface: Surface;
  strategies: Strategy[];
  detect?: () => Promise<Detection>;
}): SourceAdapter {
  const dir = () => importDir(opts.id);
  const files = () => {
    try {
      return fs
        .readdirSync(dir())
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(dir(), f));
    } catch {
      return [];
    }
  };
  return {
    id: opts.id,
    name: opts.name,
    vendor: opts.vendor,
    surface: opts.surface,
    configHints: [`agentboard import ${opts.id} <file>`, `AGENTBOARD_HOME (default ~/.agentboard)`],
    strategies: opts.strategies,
    async detect() {
      const base = opts.detect ? await opts.detect() : { installed: false, locations: [] as Detection["locations"] };
      const n = files().length;
      base.locations.push({ path: dir(), exists: n > 0, note: `${n} imported session(s)` });
      base.installed = base.installed || n > 0;
      return base;
    },
    async scan(ctx) {
      return scanFiles(files(), ctx, async (file) => {
        const d = readJsonSafe<SessionDetail>(file);
        if (!d) return null;
        // keep the import file as the source so `load` can find it again
        d.source = { kind: "import", path: file, locator: d.source?.locator };
        return d;
      });
    },
    async load(summary) {
      const d = readJsonSafe<SessionDetail>(summary.source.path);
      if (d) d.source = summary.source;
      return d;
    },
  };
}

export const chatgpt = importedAdapter({
  id: "chatgpt",
  name: "ChatGPT (web)",
  vendor: "OpenAI",
  surface: "web",
  strategies: [
    { kind: "api", status: "unavailable", description: "No consumer API lists conversations (only the Enterprise Compliance API)." },
    { kind: "import", status: "implemented", description: "Official data export: `agentboard import chatgpt conversations.json`." },
    { kind: "browser", status: "reserved", description: "Browser-session provider interface reserved (see src/engine/webchat/browser.ts)." },
  ],
});

export const claudeWeb = importedAdapter({
  id: "claude-web",
  name: "Claude.ai (web)",
  vendor: "Anthropic",
  surface: "web",
  strategies: [
    { kind: "api", status: "unavailable", description: "claude.ai has no public conversation-history API." },
    { kind: "import", status: "implemented", description: "Official data export: `agentboard import claude-web conversations.json`." },
    { kind: "browser", status: "reserved", description: "Browser-session provider interface reserved (see src/engine/webchat/browser.ts)." },
  ],
});
