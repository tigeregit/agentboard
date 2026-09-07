import fs from "node:fs";
import path from "node:path";
import type { Message, SessionDetail, SourceAdapter } from "../types";
import { readJsonSafe, readJsonl } from "../util/jsonl";
import { expand, listDirs, projectFromPath } from "../util/paths";
import { buildSession } from "../util/session";
import { cleanPrompt, coalesceAssistant, extractText, isRecord, normalizeRole, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { detection, fileSource, scanFiles } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * "Kimi series" covers two Moonshot CLIs that share a name:
 *  - Kimi Code CLI (`~/.kimi-code`): per-agent `wire.jsonl` event stream,
 *    `state.json` metadata and a top-level `session_index.jsonl` (native index).
 *  - Kimi CLI, legacy (`~/.kimi`): `context.jsonl` transcript + `wire.jsonl` sidecar.
 */
function kimiCodeHome(): string {
  return expand(process.env.KIMI_CODE_HOME || "~/.kimi-code");
}
function kimiCliHome(): string {
  return expand(process.env.KIMI_HOME || "~/.kimi");
}

interface Candidate {
  file: string; // wire.jsonl (kimi-code) or context.jsonl (legacy)
  sessionDir: string;
  legacy: boolean;
  workDir?: string;
}

function candidates(): Candidate[] {
  const out: Candidate[] = [];
  // Native index first: session_index.jsonl lists {sessionId, sessionDir, workDir}
  const indexFile = path.join(kimiCodeHome(), "session_index.jsonl");
  const indexed = new Set<string>();
  if (fs.existsSync(indexFile)) {
    try {
      for (const line of fs.readFileSync(indexFile, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line) as Rec;
        const dir = str(rec.sessionDir);
        if (!dir) continue;
        const abs = path.isAbsolute(dir) ? dir : path.join(kimiCodeHome(), dir);
        const wire = path.join(abs, "agents", "main", "wire.jsonl");
        if (fs.existsSync(wire)) {
          out.push({ file: wire, sessionDir: abs, legacy: false, workDir: str(rec.workDir) });
          indexed.add(abs);
        }
      }
    } catch {
      /* fall back to directory walk */
    }
  }
  for (const wd of listDirs(path.join(kimiCodeHome(), "sessions"))) {
    for (const sess of listDirs(wd)) {
      if (indexed.has(sess)) continue;
      const wire = path.join(sess, "agents", "main", "wire.jsonl");
      if (fs.existsSync(wire)) out.push({ file: wire, sessionDir: sess, legacy: false });
    }
  }
  for (const root of ["sessions", "imported_sessions"]) {
    for (const wd of listDirs(path.join(kimiCliHome(), root))) {
      for (const sess of listDirs(wd)) {
        const ctxFile = path.join(sess, "context.jsonl");
        if (fs.existsSync(ctxFile)) out.push({ file: ctxFile, sessionDir: sess, legacy: true });
      }
      // very old flat form: sessions/<hash>/<uuid>.jsonl
      try {
        for (const f of fs.readdirSync(wd)) if (f.endsWith(".jsonl")) out.push({ file: path.join(wd, f), sessionDir: wd, legacy: true });
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function eventMessage(ev: Rec): Rec | undefined {
  for (const k of ["message", "payload", "data", "value"]) {
    const v = ev[k];
    if (isRecord(v) && (v.role !== undefined || v.content !== undefined)) return v;
    if (isRecord(v) && isRecord(v.message)) return v.message;
  }
  return undefined;
}

function textPart(ev: Rec): string | undefined {
  for (const k of ["part", "content", "data", "payload"]) {
    const v = ev[k];
    if (isRecord(v) && v.type === "text" && typeof v.text === "string") return v.text;
    if (isRecord(v) && isRecord(v.part) && v.part.type === "text" && typeof v.part.text === "string") return v.part.text;
  }
  return undefined;
}

/** Kimi Code wire.jsonl: context.append_message (user) + streamed step.begin/content.part/step.end (assistant). */
function parseWire(records: Rec[]): { messages: Message[]; model?: string; first?: string; last?: string } {
  const raw: Message[] = [];
  let model: string | undefined;
  let first: string | undefined;
  let last: string | undefined;
  let streaming: Message | null = null;
  for (const ev of records) {
    const type = str(ev.type) ?? str(ev.event) ?? "";
    const ts = toIso(ev.timestamp ?? ev.time ?? ev.ts);
    if (ts) {
      first = first ?? ts;
      last = ts;
    }
    if (type === "metadata" || type === "session.metadata") {
      model = model ?? str(ev.model) ?? str((ev.data as Rec | undefined)?.model);
      continue;
    }
    if (type.endsWith("append_message") || type === "message") {
      const m = eventMessage(ev);
      if (!m) continue;
      const role = normalizeRole(m.role);
      if (!role) continue;
      const text = extractText(m.content);
      const toolCalls = Array.isArray(m.tool_calls)
        ? (m.tool_calls as Rec[]).map((tc) => {
            const fn = isRecord(tc.function) ? tc.function : tc;
            const name = str(fn.name) ?? "tool";
            return { name, summary: summarizeToolInput(name, fn.arguments) };
          })
        : [];
      if (role === "user") {
        const cleaned = cleanPrompt(text);
        if (cleaned) raw.push({ role, text: cleaned, timestamp: ts });
      } else if (role === "assistant" && (text.trim() || toolCalls.length)) {
        // an explicit assistant append supersedes any half-streamed message
        streaming = null;
        raw.push({ role, text, timestamp: ts, toolCalls: toolCalls.length ? toolCalls : undefined });
      } else if (role === "tool" && text) {
        raw.push({ role, text: text.slice(0, 4000), timestamp: ts });
      }
      continue;
    }
    if (type === "step.begin" || type === "turn.begin") {
      streaming = { role: "assistant", text: "", timestamp: ts };
      continue;
    }
    if (type === "content.part" || type === "content_part") {
      const text = textPart(ev);
      if (text === undefined) continue;
      if (!streaming) streaming = { role: "assistant", text: "", timestamp: ts };
      streaming.text += text;
      continue;
    }
    if (type === "tool_call" || type === "tool.call") {
      const data = isRecord(ev.data) ? ev.data : ev;
      const fn = isRecord(data.function) ? data.function : data;
      const name = str(fn.name) ?? str(data.tool_name) ?? "tool";
      raw.push({ role: "assistant", text: "", timestamp: ts, toolCalls: [{ name, summary: summarizeToolInput(name, fn.arguments) }] });
      continue;
    }
    if (type === "step.end" || type === "turn.end") {
      if (streaming && streaming.text.trim()) raw.push(streaming);
      streaming = null;
      continue;
    }
    if (type === "status_update" || type === "status.update") {
      const data = isRecord(ev.data) ? ev.data : ev;
      model = model ?? str(data.model);
    }
  }
  if (streaming && streaming.text.trim()) raw.push(streaming);
  return { messages: coalesceAssistant(raw), model, first, last };
}

/** Legacy Kimi CLI context.jsonl: OpenAI-ish role/content records plus internal `_` records. */
function parseContext(records: Rec[]): { messages: Message[]; model?: string } {
  const messages: Message[] = [];
  let model: string | undefined;
  for (const r of records) {
    const role = normalizeRole(r.role);
    if (!role) continue;
    const text = extractText(r.content);
    const toolCalls = Array.isArray(r.tool_calls)
      ? (r.tool_calls as Rec[]).map((tc) => {
          const fn = isRecord(tc.function) ? tc.function : tc;
          const name = str(fn.name) ?? "tool";
          return { name, summary: summarizeToolInput(name, fn.arguments) };
        })
      : [];
    model = model ?? str(r.model);
    if (role === "system") continue;
    if (role === "user") {
      const cleaned = cleanPrompt(text);
      if (cleaned) messages.push({ role, text: cleaned, timestamp: toIso(r.timestamp) });
    } else if (role === "assistant" && (text.trim() || toolCalls.length)) {
      messages.push({ role, text, timestamp: toIso(r.timestamp), toolCalls: toolCalls.length ? toolCalls : undefined });
    } else if (role === "tool" && text) {
      messages.push({ role, text: text.slice(0, 4000), timestamp: toIso(r.timestamp) });
    }
  }
  return { messages, model };
}

async function parseCandidate(c: Candidate): Promise<SessionDetail | null> {
  const state = readJsonSafe<Rec>(path.join(c.sessionDir, "state.json")) ?? {};
  const records = await readJsonl<Rec>(c.file);
  let messages: Message[];
  let model: string | undefined;
  let first: string | undefined;
  let last: string | undefined;
  if (c.legacy) {
    ({ messages, model } = parseContext(records));
    const wireFile = path.join(c.sessionDir, "wire.jsonl");
    if (fs.existsSync(wireFile)) {
      const wire = parseWire(await readJsonl<Rec>(wireFile));
      first = wire.first;
      last = wire.last;
      model = model ?? wire.model;
    }
  } else {
    ({ messages, model, first, last } = parseWire(records));
  }
  if (!messages.length) return null;
  const id = str(state.sessionId) ?? str(state.id) ?? path.basename(c.legacy && c.file.endsWith("context.jsonl") ? c.sessionDir : c.file.endsWith("wire.jsonl") ? c.sessionDir : c.file, ".jsonl");
  const workDir = c.workDir ?? str(state.workDir) ?? str(state.work_dir) ?? str(state.cwd);
  return buildSession({
    tool: "kimi",
    surface: "cli",
    nativeId: id,
    title: str(state.title) ?? str(state.custom_title) ?? str(state.customTitle),
    project: projectFromPath(workDir ?? `kimi-workdir/${path.basename(path.dirname(c.sessionDir))}`),
    messages,
    source: fileSource(c.file),
    startedAt: state.createdAt ?? state.created_at ?? first,
    endedAt: state.updatedAt ?? state.updated_at ?? last,
    model,
    fallbackTime: fs.statSync(c.file).mtimeMs,
    parentKey: str(state.forkedFrom) ? `kimi:${str(state.forkedFrom)}` : undefined,
    extra: { flavor: c.legacy ? "kimi-cli" : "kimi-code" },
  });
}

export const kimi: SourceAdapter = {
  id: "kimi",
  name: "Kimi Code / Kimi CLI",
  vendor: "Moonshot AI",
  surface: "cli",
  configHints: ["KIMI_CODE_HOME (default ~/.kimi-code)", "KIMI_HOME (legacy Kimi CLI, default ~/.kimi)"],
  strategies: [
    { kind: "native-index", status: "implemented", description: "~/.kimi-code/session_index.jsonl ({sessionId, sessionDir, workDir}) used to enumerate sessions." },
    { kind: "file", status: "implemented", description: "~/.kimi-code/sessions/<wd>/<id>/agents/main/wire.jsonl + state.json." },
    { kind: "file", status: "implemented", description: "Legacy ~/.kimi/sessions/<md5(cwd)>/<id>/context.jsonl (+ wire.jsonl sidecar, imported_sessions/)." },
  ],
  async detect() {
    return detection([
      { path: path.join(kimiCodeHome(), "sessions") },
      { path: path.join(kimiCodeHome(), "session_index.jsonl"), note: "native index" },
      { path: path.join(kimiCliHome(), "sessions"), note: "legacy Kimi CLI" },
    ]);
  },
  async scan(ctx) {
    const list = candidates();
    const byFile = new Map(list.map((c) => [c.file, c]));
    return scanFiles(
      list.map((c) => c.file),
      ctx,
      async (file) => parseCandidate(byFile.get(file)!),
    );
  },
  async load(summary) {
    const file = summary.source.path;
    const legacy = file.endsWith("context.jsonl") || !file.endsWith("wire.jsonl");
    const sessionDir = file.endsWith("wire.jsonl") ? path.dirname(path.dirname(path.dirname(file))) : path.dirname(file);
    return parseCandidate({ file, sessionDir, legacy });
  },
};
