import fs from "node:fs";
import path from "node:path";
import { decompress } from "fzstd";
import type { SessionDetail, SourceAdapter } from "../types";
import { parseArgs } from "../parts/classify";
import { PartList, pushContentBlocks } from "../parts/derive";
import type { ContextForm } from "../parts/types";
import { parseJsonlText } from "../util/jsonl";
import { decodeDashedCwd, expand, listDirs, projectFromPath } from "../util/paths";
import { buildSession } from "../util/session";
import { extractText, isRecord, str } from "../util/text";
import { toIso } from "../util/time";
import { detection, fileSource, scanFiles } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * DeepSeek Harness (`dsh`) persists one append-only event log per session at
 * `~/.dsh/sessions/<encoded-cwd>/session-<id>/session.jsonl[.zstd]`. Events are
 * `{type, seq, time, data}`; zstd logs are a sequence of frames, decoded with
 * the pure-JS `fzstd` so no external binary is needed.
 */
function dshHome(): string {
  return expand(process.env.DSH_HOME || "~/.dsh");
}

function sessionFiles(): string[] {
  const out: string[] = [];
  for (const proj of listDirs(path.join(dshHome(), "sessions"))) {
    for (const sess of listDirs(proj)) {
      for (const name of ["session.jsonl.zstd", "session.jsonl"]) {
        const f = path.join(sess, name);
        if (fs.existsSync(f)) {
          out.push(f);
          break;
        }
      }
    }
  }
  return out;
}

function readLog(file: string): Rec[] {
  const buf = fs.readFileSync(file);
  let text: string;
  if (file.endsWith(".zstd") || file.endsWith(".zst")) {
    try {
      text = Buffer.from(decompress(new Uint8Array(buf))).toString("utf8");
    } catch {
      // torn final frame: decode what we can by trimming to the last complete frame boundary
      text = decodeFramesLeniently(buf);
    }
  } else {
    text = buf.toString("utf8");
  }
  return parseJsonlText<Rec>(text);
}

function decodeFramesLeniently(buf: Buffer): string {
  const MAGIC = 0xfd2fb528;
  const starts: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === MAGIC) starts.push(i);
  let out = "";
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try {
      out += Buffer.from(decompress(new Uint8Array(buf.subarray(starts[i], end)))).toString("utf8");
    } catch {
      /* skip corrupt frame */
    }
  }
  return out;
}

/** dsh `Message.source` → part classification (see packages/llm/llm/src/message.ts, ContextForm). */
function classifySource(source: Rec | undefined): { kind: "prompt" | "context" | "compaction"; form?: ContextForm } {
  const kind = str(source?.kind);
  if (!kind || kind === "user") return { kind: "prompt" };
  if (kind === "plugin" && str(source!.plugin) === "compact") return { kind: "compaction" };
  const form = str(source?.form);
  if (kind === "agent-instructions" || form === "instructions" || form === "catalog") return { kind: "context", form: "instructions" };
  if (kind === "session-reference" || form === "recall") return { kind: "context", form: "recall" };
  if (kind === "goal") return { kind: "context", form: "instructions" };
  if (form === "snapshot") return { kind: "context", form: "snapshot" };
  if (form === "notice" || form === "relay") return { kind: "context", form: "notice" };
  return { kind: "context", form: "unknown" };
}

/**
 * Map the dsh event log onto parts. This is the reference mapping: dsh already
 * types everything we want (turn/step, message.source, content blocks,
 * compaction, goal, todo, subagent, approvals), so it is mostly 1:1.
 */
function parseEvents(records: Rec[], file: string): SessionDetail | null {
  const header = records.find((r) => r.type === "session") ?? {};
  const list = new PartList();
  const names = new Map<string, string>();
  const seenCalls = new Set<string>();
  let title: string | undefined;
  let model: string | undefined;
  let pendingChunks: string[] = [];
  let pendingTs: string | undefined;
  let sawSystemPrompt = false;

  const flushChunks = () => {
    if (pendingChunks.length) {
      const text = pendingChunks.join("");
      if (text.trim()) list.push({ kind: "reply", role: "assistant", text, timestamp: pendingTs });
    }
    pendingChunks = [];
    pendingTs = undefined;
  };

  for (const ev of records) {
    const type = str(ev.type);
    const data = isRecord(ev.data) ? ev.data : {};
    const ts = toIso(ev.time ?? ev.timestamp);
    switch (type) {
      case "session/title":
        title = str(data.title) ?? title;
        break;
      case "request/header": {
        const h = isRecord(data.header) ? data.header : data;
        const system = str(h.system);
        if (system && !sawSystemPrompt) {
          sawSystemPrompt = true;
          list.push({ kind: "context", role: "system", form: "system", text: system, timestamp: ts });
        }
        break;
      }
      case "user/message": {
        flushChunks();
        const msg = isRecord(data.message) ? data.message : data;
        const source = isRecord(msg.source) ? msg.source : isRecord(data.source) ? data.source : undefined;
        const text = extractText(msg.content ?? msg.text ?? data.text);
        if (!text.trim()) break;
        const c = classifySource(source);
        if (c.kind === "prompt") list.pushUserText(text, { timestamp: ts });
        else if (c.kind === "compaction") list.push({ kind: "compaction", role: "system", text, timestamp: ts });
        else list.push({ kind: "context", role: "user", form: c.form, text, timestamp: ts });
        break;
      }
      case "assistant/message": {
        const msg = isRecord(data.message) ? data.message : data;
        const src = isRecord(msg.source) ? msg.source : undefined;
        const m = str(msg.model) ?? str(src?.model) ?? str(data.model);
        model = model ?? m;
        pendingChunks = []; // complete message supersedes streamed deltas
        pendingTs = undefined;
        const before = list.parts.length;
        const last = pushContentBlocks(list, "assistant", msg.content, { timestamp: ts, model: m }, names);
        for (const p of list.parts.slice(before)) if (p.tool?.callId) seenCalls.add(p.tool.callId);
        const usage = isRecord(data.usage) ? data.usage : undefined;
        if (usage && last) last.usage = { input: Number(usage.inputTokens ?? usage.input_tokens) || undefined, output: Number(usage.outputTokens ?? usage.output_tokens) || undefined };
        break;
      }
      case "assistant/chunk": {
        const chunk = isRecord(data.chunk) ? data.chunk : data;
        if (chunk.type === "text-delta") {
          const delta = str(chunk.textDelta) ?? str(chunk.delta) ?? str(chunk.text);
          if (delta) {
            pendingChunks.push(delta);
            pendingTs = pendingTs ?? ts;
          }
        }
        break;
      }
      case "text-chunks": {
        const texts = Array.isArray(data.texts) ? (data.texts as unknown[]).filter((t) => typeof t === "string") : [];
        if (texts.length) {
          pendingChunks.push(...(texts as string[]));
          pendingTs = pendingTs ?? ts;
        }
        break;
      }
      case "tool/call": {
        const callId = str(data.callId) ?? str(data.call_id);
        if (callId && seenCalls.has(callId)) break; // already in the assistant/message content blocks
        const name = str(data.name) ?? str(data.toolName) ?? "tool";
        if (callId) {
          names.set(callId, name);
          seenCalls.add(callId);
        }
        list.pushToolCall(name, parseArgs(data.arguments ?? data.args ?? data.input), { callId, timestamp: ts });
        break;
      }
      case "tool/result": {
        const msg = isRecord(data.message) ? data.message : undefined;
        const blocks = Array.isArray(msg?.content) ? (msg!.content as Rec[]) : Array.isArray(data.result) ? (data.result as Rec[]) : [];
        const block = blocks.find((b) => isRecord(b) && (b.type === "tool-result" || b.type === "tool_result"));
        const callId = str(block?.toolCallId) ?? str(data.callId);
        const text = block ? extractText(block.content) : extractText(data.result ?? data.content ?? data.output);
        const err = isRecord(data.error) ? data.error : undefined;
        const isError = block?.isError === true || !!err ? true : undefined;
        const body = [text, err ? `[error ${str(err.code) ?? ""}] ${str(err.name) ?? ""}`.trim() : ""].filter(Boolean).join("\n");
        if (body) list.pushToolResult(body, { callId, isError, timestamp: ts, name: callId ? names.get(callId) : undefined });
        break;
      }
      case "turn/end": {
        const reason = isRecord(data.reason) ? data.reason : undefined;
        const kind = str(reason?.kind);
        if (kind && kind !== "completed") list.push({ kind: "event", role: "system", text: `turn ${data.turn ?? ""} ended: ${kind}${isRecord(reason?.error) ? ` ${JSON.stringify(reason!.error).slice(0, 300)}` : ""}`.trim(), timestamp: ts });
        break;
      }
      case "todo/write": {
        const todos = Array.isArray(data.todos) ? (data.todos as Rec[]) : [];
        const text = todos.map((t) => `- [${str(t.status) ?? " "}] ${str(t.content) ?? str(t.title) ?? JSON.stringify(t)}`).join("\n");
        if (text) list.push({ kind: "plan", role: "assistant", text, tool: { name: "todo/write", category: "plan" }, timestamp: ts });
        break;
      }
      case "compaction/summary": {
        const text = str(data.summary);
        if (text) list.push({ kind: "compaction", role: "system", text, timestamp: ts });
        break;
      }
      case "goal/change": {
        const goal = isRecord(data.goal) ? data.goal : undefined;
        list.push({ kind: "event", role: "system", text: `goal ${str(data.operation) ?? "change"}${goal ? `: ${str(goal.objective) ?? ""} [${str(goal.phase) ?? ""}]` : ""}`, timestamp: ts });
        break;
      }
      case "subagent/descriptor": {
        const label = str(data.label) ?? str(data.mode) ?? "subagent";
        const child = str(data.sessionId) ?? str(data.childSession);
        list.push({ kind: "subagent", role: "assistant", text: `${label}${str(data.provider) ? ` (${str(data.provider)})` : ""}`, tool: { name: "subagent", category: "subagent" }, child: child ? `deepseek-harness:${child}` : undefined, timestamp: ts });
        break;
      }
      case "approval/asked":
      case "approval/decided":
      case "command/run":
      case "plan/mode":
      case "sandbox/mode":
      case "permission/preset": {
        const summary = str(data.command) ?? str(data.decision) ?? str(data.mode) ?? str(data.preset) ?? str(data.title) ?? JSON.stringify(data).slice(0, 300);
        list.push({ kind: "event", role: "system", text: `${type}: ${summary}`, timestamp: ts });
        break;
      }
    }
  }
  flushChunks(); // interrupted run: keep streamed text that never got its complete message
  list.linkResults();
  if (!list.parts.length) return null;
  const dir = path.dirname(file);
  const id = str(header.id) ?? path.basename(dir).replace(/^session-/, "");
  const cwd = str(header.cwd) ?? decodeDashedCwd(path.basename(path.dirname(dir)));
  return buildSession({
    tool: "deepseek-harness",
    surface: "cli",
    nativeId: id.replace(/^session-/, ""),
    title,
    project: projectFromPath(cwd),
    parts: list.parts,
    source: fileSource(file),
    startedAt: header.createdAt ?? header.time,
    model,
    parentKey: str(header.parentSession) ? `deepseek-harness:${str(header.parentSession)}` : undefined,
    extra: header.origin ? { origin: header.origin, delegationDepth: header.delegationDepth } : undefined,
    fallbackTime: fs.statSync(file).mtimeMs,
  });
}

export const deepseekHarness: SourceAdapter = {
  id: "deepseek-harness",
  name: "DeepSeek Harness (dsh)",
  vendor: "DeepSeek",
  surface: "cli",
  configHints: ["DSH_HOME (default ~/.dsh)"],
  strategies: [
    { kind: "api", status: "reserved", description: "`dsh web` serves the UI over HTTP; a session REST/plugin surface is reserved once stabilized (developer preview)." },
    { kind: "file", status: "implemented", description: "~/.dsh/sessions/<encoded-cwd>/session-<id>/session.jsonl(.zstd) event log; zstd decoded in-process." },
  ],
  async detect() {
    return detection([{ path: path.join(dshHome(), "sessions") }]);
  },
  async scan(ctx) {
    return scanFiles(sessionFiles(), ctx, async (file) => parseEvents(readLog(file), file));
  },
  async load(summary) {
    return parseEvents(readLog(summary.source.path), summary.source.path);
  },
};
