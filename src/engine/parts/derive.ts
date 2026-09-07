/**
 * Derivations between the legacy flat `Message` list and the part model,
 * plus turn / outline computation shared by the CLI and the API.
 */
import type { Message, Role } from "../types";
import { argsToText, detectExit, extractCommand, extractFiles, renderArgs, splitInjected, toolCategory } from "./classify";
import type { ContextForm, Part, PartKind, SessionOutline, ToolCategory, Turn } from "./types";

/** Builder that assigns seq/turn while adapters push parts in source order. */
export class PartList {
  readonly parts: Part[] = [];
  private turn = 0;

  push(p: Omit<Part, "seq" | "turn"> & { turn?: number }): Part {
    if (p.kind === "prompt") this.turn++;
    const part: Part = { ...p, seq: this.parts.length, turn: p.turn ?? this.turn, bytes: p.bytes ?? p.text.length };
    this.parts.push(part);
    return part;
  }

  /**
   * Push raw user-role text: harness-injected wrappers become `context`
   * parts, the remaining human text becomes a `prompt`. Returns the prompt
   * part when there was one.
   */
  pushUserText(raw: string, meta: { timestamp?: string; model?: string } = {}): Part | undefined {
    const { prompt, context } = splitInjected(raw);
    for (const c of context) if (c.text) this.push({ kind: "context", role: "user", form: c.form, text: c.text, ...meta });
    if (prompt) return this.push({ kind: "prompt", role: "user", text: prompt, ...meta });
    return undefined;
  }

  pushToolCall(name: string, args: unknown, meta: { callId?: string; timestamp?: string; model?: string; child?: string } = {}): Part {
    const category = toolCategory(name, args);
    const command = category === "shell" ? extractCommand(args) : undefined;
    const files = extractFiles(args);
    const kind: PartKind = category === "plan" ? "plan" : category === "subagent" ? "subagent" : "tool_call";
    return this.push({
      kind,
      role: "assistant",
      text: argsToText(args) || (command ?? ""),
      tool: { name, category, callId: meta.callId, args: typeof args === "string" && args.length > 20_000 ? undefined : args, command },
      files: files.length ? files : undefined,
      child: meta.child,
      timestamp: meta.timestamp,
      model: meta.model,
    });
  }

  pushToolResult(text: string, meta: { callId?: string; isError?: boolean; exitCode?: number; truncated?: boolean; timestamp?: string; name?: string; category?: ToolCategory; files?: string[] } = {}): Part {
    const detected = meta.isError === undefined && meta.exitCode === undefined ? detectExit(text) : {};
    return this.push({
      kind: "tool_result",
      role: "tool",
      text,
      result: { callId: meta.callId, isError: meta.isError ?? detected.isError, exitCode: meta.exitCode ?? detected.exitCode, truncated: meta.truncated },
      tool: meta.name ? { name: meta.name, category: meta.category ?? toolCategory(meta.name) } : undefined,
      files: meta.files?.length ? meta.files : undefined,
      timestamp: meta.timestamp,
    });
  }

  /** Link a tool_result to the preceding call with the same callId (fills name/category/files). */
  linkResults() {
    const calls = new Map<string, Part>();
    let lastCall: Part | undefined;
    for (const p of this.parts) {
      if (p.kind === "tool_call" || p.kind === "plan" || p.kind === "subagent") {
        if (p.tool?.callId) calls.set(p.tool.callId, p);
        lastCall = p;
      } else if (p.kind === "tool_result") {
        const call = (p.result?.callId && calls.get(p.result.callId)) || (!p.result?.callId ? lastCall : undefined);
        if (call?.tool) {
          p.tool = p.tool ?? { name: call.tool.name, category: call.tool.category, callId: call.tool.callId };
          if (!p.files && call.files) p.files = call.files;
        }
        lastCall = undefined;
      }
    }
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Push a content-block array in the Anthropic / OpenAI / Vercel-AI-SDK shapes:
 * `{type: text|input_text|output_text}`, `{type: thinking|reasoning}`,
 * `{type: tool_use|tool-call|function_call, id|toolCallId, name|toolName, input|args|arguments}`,
 * `{type: tool_result|tool-result, tool_use_id|toolCallId, content|result|output, is_error|isError}`,
 * `{type: image|image_url}`. Returns the last assistant part pushed (for usage attribution).
 */
export function pushContentBlocks(list: PartList, role: Role, content: unknown, meta: { timestamp?: string; model?: string } = {}, names?: Map<string, string>): Part | undefined {
  let last: Part | undefined;
  if (typeof content === "string") {
    if (!content.trim()) return undefined;
    if (role === "user") return list.pushUserText(content, meta);
    if (role === "assistant") return list.push({ kind: "reply", role, text: content, ...meta });
    if (role === "tool") return list.pushToolResult(content, { timestamp: meta.timestamp });
    return list.push({ kind: "context", role: "system", form: "system", text: content, ...meta });
  }
  if (!Array.isArray(content)) return undefined;
  const userText: string[] = [];
  for (const b of content) {
    if (typeof b === "string") {
      if (role === "user") userText.push(b);
      else if (b.trim()) last = list.push({ kind: role === "assistant" ? "reply" : "context", role, text: b, ...meta });
      continue;
    }
    if (!isRec(b)) continue;
    const t = s(b.type) ?? "";
    if (t === "text" || t === "input_text" || t === "output_text") {
      const text = s(b.text) ?? s(b.value) ?? "";
      if (!text.trim()) continue;
      if (role === "user") userText.push(text);
      else last = list.push({ kind: role === "assistant" ? "reply" : "context", role, text, ...meta });
    } else if (t === "thinking" || t === "reasoning" || t === "redacted_thinking" || t === "think") {
      const text = s(b.thinking) ?? s(b.text) ?? s(b.reasoning) ?? (t === "redacted_thinking" ? "[redacted thinking]" : "");
      if (text.trim()) last = list.push({ kind: "reasoning", role: "assistant", text, ...meta });
    } else if (t === "tool_use" || t === "tool-call" || t === "tool_call" || t === "function_call") {
      const fn = isRec(b.function) ? b.function : undefined;
      const name = s(b.name) ?? s(b.toolName) ?? s(fn?.name) ?? "tool";
      const callId = s(b.id) ?? s(b.toolCallId) ?? s(b.call_id);
      if (callId) names?.set(callId, name);
      last = list.pushToolCall(name, b.input ?? b.args ?? b.arguments ?? fn?.arguments, { callId, ...meta });
    } else if (t === "tool_result" || t === "tool-result" || t === "function_call_output") {
      const callId = s(b.tool_use_id) ?? s(b.toolCallId) ?? s(b.call_id);
      const raw = b.content ?? b.result ?? b.output;
      const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((x) => (isRec(x) ? s(x.text) ?? "" : String(x))).join("\n") : raw === undefined ? "" : JSON.stringify(raw, null, 1);
      list.pushToolResult(text, { callId, isError: b.is_error === true || b.isError === true ? true : undefined, timestamp: meta.timestamp, name: callId ? names?.get(callId) ?? s(b.toolName) : s(b.toolName) });
    } else if (t === "image" || t === "image_url" || t === "file") {
      list.push({ kind: "context", role: "user", form: "attachment", text: `[${t} attachment]`, ...meta });
    }
  }
  if (userText.length) return list.pushUserText(userText.join("\n"), meta) ?? last;
  return last;
}

/** Fallback: derive parts from a legacy message list (basic fidelity). */
export function partsFromMessages(messages: Message[]): Part[] {
  const list = new PartList();
  for (const m of messages) {
    const meta = { timestamp: m.timestamp, model: m.model };
    if (m.role === "user") {
      list.pushUserText(m.text, meta);
      continue;
    }
    if (m.role === "system") {
      if (m.text.trim()) list.push({ kind: "context", role: "system", form: "system", text: m.text, ...meta });
      continue;
    }
    if (m.role === "tool") {
      if (m.text.trim()) list.pushToolResult(m.text, { timestamp: m.timestamp });
      continue;
    }
    // assistant
    if (m.text.trim()) list.push({ kind: "reply", role: "assistant", text: m.text, ...meta });
    for (const t of m.toolCalls ?? []) list.pushToolCall(t.name, summaryToArgs(t.summary), meta);
  }
  list.linkResults();
  return list.parts;
}

/** Legacy adapters summarise arguments as `key: value` (160 chars); turn that back into a one-key object. */
function summaryToArgs(summary: string | undefined): unknown {
  if (!summary) return undefined;
  const m = summary.match(/^([a-zA-Z_][\w.]*): ([\s\S]*)$/);
  return m ? { [m[1]]: m[2] } : summary;
}

/** Legacy view for the dashboard and existing API: collapse parts back into messages. */
export function messagesFromParts(parts: Part[]): Message[] {
  const out: Message[] = [];
  for (const p of parts) {
    switch (p.kind) {
      case "prompt":
        out.push({ role: "user", text: p.text, timestamp: p.timestamp });
        break;
      case "reply":
        out.push({ role: "assistant", text: p.text, timestamp: p.timestamp, model: p.model });
        break;
      case "tool_call":
      case "plan":
      case "subagent": {
        const summary = p.tool ? renderArgs(p.tool.name, p.tool.args ?? p.text, 160) : undefined;
        const last = out[out.length - 1];
        // Merge into the preceding assistant message of the same step (same timestamp), as the flat adapters did.
        if (last && last.role === "assistant" && p.timestamp === last.timestamp) (last.toolCalls ??= []).push({ name: p.tool?.name ?? p.kind, summary });
        else out.push({ role: "assistant", text: "", timestamp: p.timestamp, model: p.model, toolCalls: [{ name: p.tool?.name ?? p.kind, summary }] });
        break;
      }
      case "tool_result":
        out.push({ role: "tool", text: p.text.slice(0, 4000), timestamp: p.timestamp });
        break;
      case "compaction":
        out.push({ role: "system", text: `[compaction] ${p.text}`, timestamp: p.timestamp });
        break;
      default:
        // context / reasoning / event are not part of the legacy transcript view
        break;
    }
  }
  return out;
}

export function roleOf(kind: PartKind): Role {
  switch (kind) {
    case "prompt":
    case "context":
      return "user";
    case "tool_result":
      return "tool";
    case "event":
    case "compaction":
      return "system";
    default:
      return "assistant";
  }
}

/** Group parts into turns. */
export function turnsOf(parts: Part[]): Turn[] {
  const map = new Map<number, Turn>();
  for (const p of parts) {
    let t = map.get(p.turn);
    if (!t) {
      t = { turn: p.turn, startSeq: p.seq, endSeq: p.seq, startedAt: p.timestamp, endedAt: p.timestamp, prompt: "", reply: "", partCount: 0, toolCalls: 0, byCategory: {}, errors: 0, reasoningParts: 0, files: [], commands: [], children: [] };
      map.set(p.turn, t);
    }
    t.endSeq = p.seq;
    t.partCount++;
    if (p.timestamp) {
      if (!t.startedAt || p.timestamp < t.startedAt) t.startedAt = p.timestamp;
      if (!t.endedAt || p.timestamp > t.endedAt) t.endedAt = p.timestamp;
    }
    if (p.kind === "prompt" && !t.prompt) t.prompt = p.text;
    if (p.kind === "reply" && p.text.trim()) t.reply = p.text;
    if (p.kind === "reasoning") t.reasoningParts++;
    if (p.kind === "tool_call" || p.kind === "plan" || p.kind === "subagent") {
      t.toolCalls++;
      const c = p.tool?.category ?? "other";
      t.byCategory[c] = (t.byCategory[c] ?? 0) + 1;
      if (p.tool?.command) t.commands.push(p.tool.command);
      if (p.child) t.children.push(p.child);
    }
    if (p.kind === "tool_result" && p.result?.isError) t.errors++;
    if (p.files && (p.kind === "tool_call" || p.kind === "plan")) for (const f of p.files) if (!t.files.includes(f)) t.files.push(f);
  }
  return Array.from(map.values()).sort((a, b) => a.turn - b.turn);
}

export function outlineOf(key: string, parts: Part[]): SessionOutline {
  const byKind: Partial<Record<PartKind, number>> = {};
  const byCategory: Partial<Record<ToolCategory, number>> = {};
  const toolNames: Record<string, number> = {};
  const files = new Map<string, { path: string; edits: number; reads: number }>();
  let errors = 0;
  let contextParts = 0;
  let compactions = 0;
  for (const p of parts) {
    byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
    if (p.kind === "context") contextParts++;
    if (p.kind === "compaction") compactions++;
    if (p.kind === "tool_result" && p.result?.isError) errors++;
    if (p.tool && p.kind !== "tool_result") {
      byCategory[p.tool.category] = (byCategory[p.tool.category] ?? 0) + 1;
      toolNames[p.tool.name] = (toolNames[p.tool.name] ?? 0) + 1;
      for (const f of p.files ?? []) {
        const e = files.get(f) ?? { path: f, edits: 0, reads: 0 };
        if (p.tool.category === "edit") e.edits++;
        else e.reads++;
        files.set(f, e);
      }
    }
  }
  return {
    key,
    partCount: parts.length,
    turns: turnsOf(parts),
    byKind,
    byCategory,
    toolNames,
    files: Array.from(files.values()).sort((a, b) => b.edits + b.reads - (a.edits + a.reads)),
    errors,
    contextParts,
    compactions,
  };
}

export function contextFormLabel(f: ContextForm | undefined): string {
  return f ?? "unknown";
}
