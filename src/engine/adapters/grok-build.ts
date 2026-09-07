import fs from "node:fs";
import path from "node:path";
import type { Message, SessionDetail, SourceAdapter } from "../types";
import { readJsonSafe, readJsonl } from "../util/jsonl";
import { expand, listDirs, projectFromPath } from "../util/paths";
import { buildSession } from "../util/session";
import { cleanPrompt, coalesceAssistant, extractText, isRecord, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { detection, fileSource, scanFiles } from "./_shared";

type Rec = Record<string, unknown>;

function grokHome(): string {
  return expand(process.env.GROK_HOME || "~/.grok");
}

function sessionsRoot(): string {
  return path.join(grokHome(), "sessions");
}

function updateFiles(): string[] {
  const out: string[] = [];
  for (const group of listDirs(sessionsRoot())) {
    for (const sess of listDirs(group)) {
      const f = path.join(sess, "updates.jsonl");
      if (fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

function decodeGroup(groupDir: string): string | undefined {
  const cwdFile = path.join(groupDir, ".cwd");
  try {
    return fs.readFileSync(cwdFile, "utf8").trim() || undefined;
  } catch {
    /* fall through */
  }
  try {
    return decodeURIComponent(path.basename(groupDir));
  } catch {
    return path.basename(groupDir);
  }
}

async function parseFile(file: string): Promise<SessionDetail | null> {
  const dir = path.dirname(file);
  const summary = readJsonSafe<Rec>(path.join(dir, "summary.json")) ?? {};
  const info = isRecord(summary.info) ? summary.info : summary;
  const records = await readJsonl<Rec>(file, { maxLineBytes: 2_000_000 });
  const raw: Message[] = [];
  let lastKey: string | undefined;
  for (const r of records) {
    const params = isRecord(r.params) ? r.params : r;
    const update = isRecord(params.update) ? params.update : undefined;
    if (!update) continue;
    const kind = str(update.sessionUpdate);
    const meta = isRecord(params._meta) ? params._meta : {};
    const ts = toIso(r.timestamp) ?? toIso(meta.agentTimestampMs);
    if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
      const role = kind === "user_message_chunk" ? "user" : "assistant";
      const text = extractText(update.content);
      if (!text) continue;
      const groupKey = `${role}:${role === "user" ? String(meta.promptIndex ?? meta.promptId ?? "") : String(meta.promptId ?? "")}`;
      const last = raw[raw.length - 1];
      if (last && last.role === role && groupKey === lastKey && !last.toolCalls) {
        last.text += text;
      } else {
        raw.push({ role, text, timestamp: ts });
        lastKey = groupKey;
      }
    } else if (kind === "tool_call") {
      const name = str(update.title) ?? str(update.kind) ?? "tool";
      raw.push({ role: "assistant", text: "", timestamp: ts, toolCalls: [{ name: str(update.kind) ?? name, summary: str(update.title) ?? summarizeToolInput(name, update.rawInput) }] });
      lastKey = undefined;
    }
  }
  const messages = coalesceAssistant(raw).map((m) => (m.role === "user" ? { ...m, text: cleanPrompt(m.text) } : m)).filter((m) => m.text.trim() || m.toolCalls?.length);
  if (!messages.length) return null;
  const id = str(info.id) ?? str(summary.id) ?? path.basename(dir);
  const cwd = str(info.cwd) ?? str(summary.cwd) ?? decodeGroup(path.dirname(dir));
  const parent = str(summary.parent_session_id) ?? str(info.parent_session_id);
  return buildSession({
    tool: "grok-build",
    surface: "cli",
    nativeId: id,
    title: str(summary.generated_title) ?? str(summary.session_summary) ?? str(info.title) ?? str(summary.title),
    project: projectFromPath(cwd),
    messages,
    source: fileSource(file),
    startedAt: summary.created_at ?? info.created_at,
    endedAt: summary.updated_at ?? info.updated_at,
    model: str(summary.model_id) ?? str(info.model_id),
    parentKey: parent ? `grok-build:${parent}` : undefined,
    fallbackTime: fs.statSync(file).mtimeMs,
    extra: { kind: str(summary.session_kind), agent: str(summary.agent_name) },
  });
}

export const grokBuild: SourceAdapter = {
  id: "grok-build",
  name: "Grok Build",
  vendor: "xAI",
  surface: "cli",
  configHints: ["GROK_HOME (default ~/.grok)"],
  strategies: [
    { kind: "native-index", status: "reserved", description: "`grok sessions list|search` (SQLite FTS5 index over titles/prompts) - no machine-readable output flag documented yet." },
    { kind: "file", status: "implemented", description: "~/.grok/sessions/<url-encoded-cwd>/<id>/updates.jsonl (ACP session updates) + summary.json." },
  ],
  async detect() {
    return detection([{ path: sessionsRoot() }]);
  },
  async scan(ctx) {
    return scanFiles(updateFiles(), ctx, parseFile);
  },
  async load(summary) {
    return parseFile(summary.source.path);
  },
};
