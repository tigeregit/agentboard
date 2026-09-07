import fs from "node:fs";
import path from "node:path";
import type { Message, ScanContext, ScanResult, SessionDetail, SourceAdapter, ToolCall } from "../types";
import { readJsonl, readJsonSafe } from "../util/jsonl";
import { expand, listDirs, projectFromPath, statSafe } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { cleanPrompt, extractText, isRecord, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { detection, fileSource } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * Mistral Vibe CLI writes one directory per session under
 * `<$VIBE_HOME|~/.vibe>/logs/session/session_<YYYYMMDD>_<HHMMSS>_<id>/`:
 *  - `meta.json`: session_id, start_time, end_time, title, title_source
 *    ("manual" = renamed by the user), environment.working_directory, stats
 *    (session_prompt_tokens, session_completion_tokens), optional model.
 *  - `messages.jsonl`: OpenAI-style records `{role, content, message_id,
 *    reasoning_content?, tool_calls?: [{id, type:"function", function:{name,
 *    arguments}}], tool_call_id?, images?: [{source:{kind:"inline"|"file", …},
 *    mime_type}]}`; `content` is a string or blocks (`text` / `think`).
 */
const SESSIONS_DIR = path.join("logs", "session");
const META_FILE = "meta.json";
const MESSAGES_FILE = "messages.jsonl";

function vibeHome(): string {
  const env = process.env.VIBE_HOME;
  if (env) return path.resolve(expand(env));
  return expand("~/.vibe");
}

function sessionsRoot(): string {
  return path.join(vibeHome(), SESSIONS_DIR);
}

interface VibeSession {
  dir: string;
  metaPath: string;
  messagesPath: string;
}

function sessionDirs(): VibeSession[] {
  const out: VibeSession[] = [];
  for (const dir of listDirs(sessionsRoot())) {
    const metaPath = path.join(dir, META_FILE);
    const messagesPath = path.join(dir, MESSAGES_FILE);
    if (statSafe(metaPath)?.isFile() && statSafe(messagesPath)?.isFile()) out.push({ dir, metaPath, messagesPath });
  }
  return out;
}

function fingerprint(s: VibeSession): { mtimeMs: number; size: number } {
  const a = statSafe(s.messagesPath);
  const b = statSafe(s.metaPath);
  return { mtimeMs: Math.max(a?.mtimeMs ?? 0, b?.mtimeMs ?? 0), size: (a?.size ?? 0) + (b?.size ?? 0) };
}

function imageNotes(rec: Rec): string {
  const images = Array.isArray(rec.images) ? rec.images : [];
  return images
    .map((img) => {
      const mime = isRecord(img) ? str(img.mime_type) : undefined;
      return mime ? `[image ${mime}]` : "[image]";
    })
    .join(" ");
}

function toolCallsOf(rec: Rec): ToolCall[] {
  const calls = Array.isArray(rec.tool_calls) ? rec.tool_calls : [];
  const out: ToolCall[] = [];
  for (const c of calls) {
    if (!isRecord(c)) continue;
    const fn = isRecord(c.function) ? c.function : undefined;
    const name = str(fn?.name) ?? str(c.name) ?? "tool";
    const args = fn?.arguments ?? c.arguments;
    out.push({ name, summary: summarizeToolInput(name, args) });
  }
  return out;
}

export function convertVibeMessage(rec: Rec, fallbackTs?: string): Message | null {
  const role = str(rec.role);
  const timestamp = toIso(rec.timestamp ?? rec.created_at) ?? fallbackTs;
  if (role === "user") {
    const text = [cleanPrompt(extractText(rec.content)), imageNotes(rec)].filter(Boolean).join("\n");
    return text ? { role: "user", text, timestamp } : null;
  }
  if (role === "assistant") {
    const text = [extractText(rec.content), imageNotes(rec)].filter(Boolean).join("\n");
    const toolCalls = toolCallsOf(rec);
    if (!text.trim() && !toolCalls.length) return null;
    return { role: "assistant", text, timestamp, model: str(rec.model), toolCalls: toolCalls.length ? toolCalls : undefined };
  }
  if (role === "tool") {
    const out = extractText(rec.content);
    return out ? { role: "tool", text: out.slice(0, 4000), timestamp } : null;
  }
  return null;
}

async function parseSession(s: VibeSession): Promise<SessionDetail | null> {
  const meta = readJsonSafe<Rec>(s.metaPath);
  if (!isRecord(meta)) return null;
  const env = isRecord(meta.environment) ? meta.environment : undefined;
  const startedAt = toIso(meta.start_time);
  const records = await readJsonl<Rec>(s.messagesPath);
  const messages: Message[] = [];
  for (const r of records) {
    if (!isRecord(r)) continue;
    const m = convertVibeMessage(r, startedAt);
    if (m) messages.push(m);
  }
  if (!messages.length) return null;
  const title = str(meta.title)?.trim();
  const stats = isRecord(meta.stats) ? meta.stats : undefined;
  return buildSession({
    tool: "vibe",
    surface: "cli",
    nativeId: str(meta.session_id) ?? path.basename(s.dir),
    title: title || undefined,
    project: projectFromPath(str(env?.working_directory) ?? str(meta.working_directory) ?? str(meta.cwd)),
    messages,
    source: fileSource(s.messagesPath),
    startedAt,
    endedAt: meta.end_time,
    model: str(meta.model) ?? str(env?.model) ?? str(meta.active_model),
    fallbackTime: fs.statSync(s.messagesPath).mtimeMs,
    extra: {
      sessionDir: path.basename(s.dir),
      renamed: meta.title_source === "manual",
      promptTokens: stats?.session_prompt_tokens,
      completionTokens: stats?.session_completion_tokens,
    },
  });
}

async function scanSessions(ctx: ScanContext): Promise<ScanResult> {
  const result: ScanResult = { sessions: [], seen: [], warnings: [] };
  for (const s of sessionDirs()) {
    const fp = fingerprint(s);
    result.seen.push({ path: s.messagesPath, ...fp });
    if (!ctx.full && ctx.isFresh(s.messagesPath, fp.mtimeMs, fp.size)) continue;
    try {
      const d = await parseSession(s);
      if (d && d.messageCount > 0) result.sessions.push(stripDetail(d));
    } catch (err) {
      result.warnings.push(`${s.messagesPath}: ${(err as Error).message}`);
    }
  }
  return result;
}

export const vibe: SourceAdapter = {
  id: "vibe",
  name: "Mistral Vibe",
  vendor: "Mistral",
  surface: "cli",
  configHints: ["VIBE_HOME (default ~/.vibe)"],
  strategies: [
    { kind: "file", status: "implemented", description: `<VIBE_HOME>/${SESSIONS_DIR}/<session_dir>/${META_FILE} (session_id, start_time, end_time, title, title_source, environment.working_directory) + ${MESSAGES_FILE} (OpenAI-style role/content/tool_calls/tool_call_id records; image attachments noted, bytes skipped).` },
  ],
  async detect() {
    return detection([{ path: sessionsRoot(), note: "<session_dir>/meta.json + messages.jsonl" }]);
  },
  async scan(ctx) {
    return scanSessions(ctx);
  },
  async load(summary) {
    const dir = path.dirname(summary.source.path);
    return parseSession({ dir, metaPath: path.join(dir, META_FILE), messagesPath: path.join(dir, MESSAGES_FILE) });
  },
};
