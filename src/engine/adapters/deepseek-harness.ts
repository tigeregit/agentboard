import fs from "node:fs";
import path from "node:path";
import { decompress } from "fzstd";
import type { Message, SessionDetail, SourceAdapter } from "../types";
import { parseJsonlText } from "../util/jsonl";
import { decodeDashedCwd, expand, listDirs, projectFromPath } from "../util/paths";
import { buildSession } from "../util/session";
import { cleanPrompt, extractText, isRecord, str, summarizeToolInput } from "../util/text";
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

function parseEvents(records: Rec[], file: string): SessionDetail | null {
  const header = records.find((r) => r.type === "session") ?? {};
  const messages: Message[] = [];
  let title: string | undefined;
  let model: string | undefined;
  let pendingChunks: string[] = [];
  let pendingTs: string | undefined;
  let lastCompleteSeq = -1;

  const flushChunks = () => {
    if (pendingChunks.length) {
      const text = pendingChunks.join("");
      if (text.trim()) messages.push({ role: "assistant", text, timestamp: pendingTs });
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
      case "user/message": {
        const source = isRecord(data.source) ? data.source : undefined;
        if (source && source.kind && source.kind !== "user") break; // plugin-injected context
        flushChunks();
        const msg = isRecord(data.message) ? data.message : data;
        const text = cleanPrompt(extractText(msg.content ?? msg.text ?? data.text));
        if (text) messages.push({ role: "user", text, timestamp: ts });
        break;
      }
      case "assistant/message": {
        const msg = isRecord(data.message) ? data.message : data;
        const content = msg.content;
        const text = extractText(content);
        const toolCalls: Message["toolCalls"] = [];
        if (Array.isArray(content)) {
          for (const block of content as Rec[]) {
            if (isRecord(block) && (block.type === "tool-call" || block.type === "tool_use")) {
              const name = str(block.toolName) ?? str(block.name) ?? "tool";
              toolCalls.push({ name, summary: summarizeToolInput(name, block.args ?? block.input) });
            }
          }
        }
        model = model ?? str(msg.model) ?? str(data.model);
        pendingChunks = []; // complete message supersedes streamed deltas
        pendingTs = undefined;
        if (text.trim() || toolCalls.length) messages.push({ role: "assistant", text, timestamp: ts, model: str(msg.model), toolCalls: toolCalls.length ? toolCalls : undefined });
        lastCompleteSeq = typeof ev.seq === "number" ? ev.seq : lastCompleteSeq;
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
        const name = str(data.toolName) ?? str(data.name) ?? "tool";
        messages.push({ role: "assistant", text: "", timestamp: ts, toolCalls: [{ name, summary: summarizeToolInput(name, data.args ?? data.input) }] });
        break;
      }
      case "tool/result": {
        const text = extractText(data.result ?? data.content ?? data.output);
        if (text) messages.push({ role: "tool", text: text.slice(0, 4000), timestamp: ts });
        break;
      }
    }
  }
  flushChunks(); // interrupted run: keep streamed text that never got its complete message
  void lastCompleteSeq;
  if (!messages.length) return null;
  const dir = path.dirname(file);
  const id = str(header.id) ?? path.basename(dir).replace(/^session-/, "");
  const cwd = str(header.cwd) ?? decodeDashedCwd(path.basename(path.dirname(dir)));
  return buildSession({
    tool: "deepseek-harness",
    surface: "cli",
    nativeId: id.replace(/^session-/, ""),
    title,
    project: projectFromPath(cwd),
    messages,
    source: fileSource(file),
    startedAt: header.createdAt ?? header.time,
    model,
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
