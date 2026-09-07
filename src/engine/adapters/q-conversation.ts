import crypto from "node:crypto";
import path from "node:path";
import type { Message, ToolCall } from "../types";
import { home, xdgDataHome } from "../util/paths";
import { cleanPrompt, isRecord, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";

type Rec = Record<string, unknown>;

/**
 * Shared `ConversationState` conversion for the Amazon Q CLI lineage.
 *
 * Amazon Q CLI (`amazon-q/data.sqlite3`, table `conversations`) and its
 * rebrand Kiro CLI (`kiro-cli/data.sqlite3`, table `conversations_v2`) store
 * the same serialized `ConversationState` JSON in their `value` column; only
 * the surrounding table layout differs:
 *
 *   { "conversation_id"?, "model"?, "history": [ { "user": {...}, "assistant": {...} }, ... ] }
 *
 * with externally tagged enums:
 *  - `user.content`: `Prompt{prompt}` | `ToolUseResults{tool_use_results[]}` |
 *    `CancelledToolUses{prompt?, tool_use_results[]}`; `user.timestamp` is ISO.
 *  - `assistant`: `Response{message_id?, content}` |
 *    `ToolUse{message_id?, content, tool_uses[]{id,name,args}}`.
 */

/** `dirs::data_local_dir()` candidates: XDG data home, ~/Library/Application Support, %LOCALAPPDATA%. */
export function dataLocalDirs(): string[] {
  const h = home();
  const dirs: string[] = [];
  if (process.platform === "darwin") dirs.push(path.join(h, "Library", "Application Support"));
  else if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) dirs.push(process.env.LOCALAPPDATA);
  } else dirs.push(xdgDataHome());
  // Also probe the non-native locations so synced / remote homes work.
  dirs.push(xdgDataHome(), path.join(h, ".local", "share"), path.join(h, "Library", "Application Support"));
  if (process.env.LOCALAPPDATA) dirs.push(process.env.LOCALAPPDATA);
  return Array.from(new Set(dirs));
}

/** Decode a `value` column (TEXT or BLOB) into the ConversationState object. */
export function parseConversationState(value: unknown): Rec | null {
  let v: unknown = value;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) v = Buffer.from(v as Uint8Array).toString("utf8");
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return isRecord(v) ? v : null;
}

export interface QConversation {
  messages: Message[];
  conversationId?: string;
  model?: string;
}

function toolResultText(tr: Rec): string {
  const parts: string[] = [];
  const content = Array.isArray(tr.content) ? (tr.content as unknown[]) : [];
  for (const c of content) {
    if (!isRecord(c)) continue;
    const text = str(c.Text);
    if (text !== undefined) {
      parts.push(text);
      continue;
    }
    if (c.Json !== undefined) parts.push(typeof c.Json === "string" ? c.Json : JSON.stringify(c.Json));
  }
  return parts.join("\n");
}

function pushToolResults(out: Message[], holder: Rec, timestamp: string | undefined) {
  const results = Array.isArray(holder.tool_use_results) ? (holder.tool_use_results as unknown[]) : [];
  for (const tr of results) {
    if (!isRecord(tr)) continue;
    const text = toolResultText(tr);
    if (text.trim()) out.push({ role: "tool", text: text.slice(0, 4000), timestamp });
  }
}

function userMessages(user: Rec): Message[] {
  const out: Message[] = [];
  const timestamp = toIso(user.timestamp);
  const content = isRecord(user.content) ? user.content : undefined;
  if (!content) return out;
  if (isRecord(content.Prompt)) {
    const text = cleanPrompt(str(content.Prompt.prompt) ?? "");
    if (text) out.push({ role: "user", text, timestamp });
  } else if (isRecord(content.ToolUseResults)) {
    pushToolResults(out, content.ToolUseResults, timestamp);
  } else if (isRecord(content.CancelledToolUses)) {
    const text = cleanPrompt(str(content.CancelledToolUses.prompt) ?? "");
    if (text) out.push({ role: "user", text, timestamp });
    pushToolResults(out, content.CancelledToolUses, timestamp);
  }
  return out;
}

function assistantMessage(assistant: Rec, model: string | undefined): Message | null {
  const response = isRecord(assistant.Response) ? assistant.Response : undefined;
  const toolUse = isRecord(assistant.ToolUse) ? assistant.ToolUse : undefined;
  const payload = response ?? toolUse;
  if (!payload) return null;
  const text = str(payload.content) ?? "";
  const toolCalls: ToolCall[] = [];
  const uses = Array.isArray(toolUse?.tool_uses) ? (toolUse!.tool_uses as unknown[]) : [];
  for (const u of uses) {
    if (!isRecord(u)) continue;
    const name = str(u.name) ?? "unknown";
    toolCalls.push({ name, summary: summarizeToolInput(name, u.args) });
  }
  if (!text.trim() && !toolCalls.length) return null;
  return { role: "assistant", text, model, toolCalls: toolCalls.length ? toolCalls : undefined };
}

/** Walk `history[]` in order, emitting user / tool / assistant messages. */
export function convertConversationState(state: Rec): QConversation {
  const modelInfo = isRecord(state.model_info) ? state.model_info : undefined;
  const model = str(state.model) ?? str(modelInfo?.model_id) ?? str(modelInfo?.model_name);
  const messages: Message[] = [];
  const history = Array.isArray(state.history) ? (state.history as unknown[]) : [];
  for (const entry of history) {
    if (!isRecord(entry)) continue;
    if (isRecord(entry.user)) messages.push(...userMessages(entry.user));
    if (isRecord(entry.assistant)) {
      const m = assistantMessage(entry.assistant, model);
      if (m) messages.push(m);
    }
  }
  return { messages, conversationId: str(state.conversation_id), model };
}

/** Stable short id for stores keyed by cwd rather than by a conversation id. */
export function keyHash(key: string): string {
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}
