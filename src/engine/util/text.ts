import type { Message, Role, ToolCall } from "../types";

type AnyRecord = Record<string, unknown>;

export function isRecord(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Extract human-readable text from the content shapes used across agents:
 * plain strings, Anthropic `{type:"text",text}` blocks, OpenAI
 * `{type:"input_text"|"output_text",text}` items, `{value}` markdown chunks,
 * nested `parts` arrays, ...
 */
export function extractText(content: unknown, depth = 0): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (depth > 6) return "";
  if (Array.isArray(content)) {
    return content
      .map((c) => extractText(c, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (isRecord(content)) {
    const type = str(content.type);
    if (type === "tool_use" || type === "tool_result" || type === "function_call" || type === "tool_call") return "";
    if (type === "thinking" || type === "reasoning" || type === "think" || type === "redacted_thinking") return "";
    if (type === "image" || type === "image_url" || type === "audio_url" || type === "video_url") return "";
    if (typeof content.text === "string") return content.text;
    if (typeof content.value === "string") return content.value;
    if (typeof content.content === "string") return content.content;
    if (content.parts !== undefined) return extractText(content.parts, depth + 1);
    if (content.content !== undefined) return extractText(content.content, depth + 1);
    if (typeof content.message === "string") return content.message;
  }
  return "";
}

/** Collect tool calls from Anthropic / OpenAI style content blocks. */
export function extractToolCalls(content: unknown): ToolCall[] {
  const out: ToolCall[] = [];
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = str(block.type);
    if (type === "tool_use" || type === "tool_call" || type === "function_call") {
      const name = str(block.name) ?? str((block.function as AnyRecord | undefined)?.name) ?? "tool";
      const input = block.input ?? block.arguments ?? (block.function as AnyRecord | undefined)?.arguments;
      out.push({ name, summary: summarizeToolInput(name, input) });
    }
  }
  return out;
}

export function summarizeToolInput(name: string, input: unknown): string | undefined {
  let obj: unknown = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      return input.slice(0, 160);
    }
  }
  if (!isRecord(obj)) return undefined;
  const keys = ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "url", "description", "prompt"];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return `${k}: ${v.slice(0, 160)}`;
  }
  const first = Object.entries(obj).find(([, v]) => typeof v === "string");
  if (first) return `${first[0]}: ${(first[1] as string).slice(0, 160)}`;
  return undefined;
}

export function normalizeRole(role: unknown): Role | null {
  const r = String(role ?? "").toLowerCase();
  if (r === "user" || r === "human") return "user";
  if (r === "assistant" || r === "model" || r === "ai" || r === "agent") return "assistant";
  if (r === "system" || r === "developer") return "system";
  if (r === "tool" || r === "function") return "tool";
  return null;
}

/** Remove injected XML-ish context tags many harnesses prepend to user prompts. */
export function cleanPrompt(text: string): string {
  return text
    .replace(/<(system-reminder|current_datetime|attached_files|environment_details|task-notification)[\s\S]*?<\/\1>/gi, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, "")
    .replace(/\s+\n/g, "\n")
    .trim();
}

export function firstLine(text: string, max = 120): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** Derive a session title from an explicit title or the first user prompt. */
export function deriveTitle(explicit: string | undefined | null, messages: Message[]): string {
  const t = explicit?.trim();
  if (t) return t.length > 140 ? t.slice(0, 139) + "…" : t;
  const first = messages.find((m) => m.role === "user" && m.text.trim());
  if (first) return firstLine(cleanPrompt(first.text)) || "(untitled)";
  return "(untitled)";
}

export const PROMPT_TEXT_CAP = 24_000;

export function buildPromptText(messages: Message[]): string {
  let out = "";
  for (const m of messages) {
    if (m.role !== "user") continue;
    const t = cleanPrompt(m.text);
    if (!t) continue;
    if (out.length + t.length > PROMPT_TEXT_CAP) {
      out += t.slice(0, Math.max(0, PROMPT_TEXT_CAP - out.length));
      break;
    }
    out += (out ? "\n" : "") + t;
  }
  return out;
}

/** Group streamed assistant fragments into one message per turn. */
export function coalesceAssistant(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === "assistant" && m.role === "assistant" && !m.toolCalls?.length && !last.toolCalls?.length) {
      last.text = (last.text + m.text).trimEnd();
      if (!last.timestamp) last.timestamp = m.timestamp;
      continue;
    }
    out.push({ ...m });
  }
  return out;
}
