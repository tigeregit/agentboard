import type { Message, Part, ProjectRef, SessionDetail, SessionSummary, SourceRef, Surface, ToolId } from "../types";
import { splitInjected } from "../parts/classify";
import { messagesFromParts, partsFromMessages } from "../parts/derive";
import { PROMPT_TEXT_CAP, firstLine } from "./text";
import { maxIso, minIso, toIso } from "./time";

export interface BuildInput {
  tool: ToolId;
  surface: Surface;
  nativeId: string;
  title?: string | null;
  project: ProjectRef;
  /** Legacy flat transcript. Parts are derived from it when `parts` is absent. */
  messages?: Message[];
  /** Rich typed transcript. When present, `messages` is derived from it. */
  parts?: Part[];
  source: SourceRef;
  /** Explicit bounds; message timestamps are used to widen them. */
  startedAt?: unknown;
  endedAt?: unknown;
  /** Fallback when neither explicit bounds nor message timestamps exist. */
  fallbackTime?: unknown;
  model?: string;
  gitBranch?: string;
  parentKey?: string;
  extra?: Record<string, unknown>;
}

/** Assemble a normalized session from parsed parts (or legacy messages) plus metadata. */
export function buildSession(input: BuildInput): SessionDetail {
  let parts: Part[];
  let messages: Message[];
  if (input.parts) {
    parts = input.parts;
    messages = messagesFromParts(parts);
  } else {
    messages = (input.messages ?? []).filter((m) => m.text.trim() || m.toolCalls?.length);
    parts = partsFromMessages(messages);
  }
  normalizeFiles(parts, input.project.path);
  let start = toIso(input.startedAt);
  let end = toIso(input.endedAt);
  for (const p of parts) {
    if (!p.timestamp) continue;
    start = minIso(start, p.timestamp);
    end = maxIso(end, p.timestamp);
  }
  for (const m of messages) {
    if (!m.timestamp) continue;
    start = minIso(start, m.timestamp);
    end = maxIso(end, m.timestamp);
  }
  const fallback = toIso(input.fallbackTime) ?? new Date(0).toISOString();
  start = start ?? end ?? fallback;
  end = end ?? start;

  const model = input.model ?? parts.map((p) => p.model).find(Boolean) ?? messages.map((m) => m.model).find(Boolean);
  const prompts = parts.filter((p) => p.kind === "prompt");
  const firstPrompt = prompts.length ? firstLine(prompts[0].text, 300) : "";

  const summary: SessionSummary = {
    key: `${input.tool}:${input.nativeId}`,
    tool: input.tool,
    surface: input.surface,
    nativeId: input.nativeId,
    title: deriveTitleFromParts(input.title, prompts),
    project: input.project,
    startedAt: start,
    endedAt: end,
    messageCount: messages.length,
    userMessageCount: prompts.length,
    assistantMessageCount: messages.filter((m) => m.role === "assistant").length,
    toolCallCount: parts.filter((p) => p.kind === "tool_call" || p.kind === "plan" || p.kind === "subagent").length,
    model,
    gitBranch: input.gitBranch,
    firstPrompt,
    promptText: joinPrompts(prompts),
    source: input.source,
    parentKey: input.parentKey,
    extra: input.extra,
  };
  return { ...summary, messages, parts, richParts: !!input.parts };
}

/** Resolve relative file references against the project so `draft/X.md` and `/abs/…/draft/X.md` are one file. */
function normalizeFiles(parts: Part[], projectPath: string) {
  const root = projectPath && projectPath.startsWith("/") ? projectPath.replace(/\/+$/, "") : undefined;
  for (const p of parts) {
    if (!p.files?.length) continue;
    const seen = new Set<string>();
    p.files = p.files
      .map((f) => {
        let v = f.trim();
        if (v.startsWith("file://")) v = v.slice(7);
        if (root && !v.startsWith("/") && !v.startsWith("~") && !/^[a-zA-Z]:[\\/]/.test(v)) v = `${root}/${v.replace(/^\.\//, "")}`;
        return v;
      })
      .filter((v) => {
        if (seen.has(v)) return false;
        seen.add(v);
        return true;
      });
  }
}

/** Explicit titles from the tool are cleaned of injected wrappers too; fall back to the first prompt. */
function deriveTitleFromParts(explicit: string | undefined | null, prompts: Part[]): string {
  const t = explicit?.trim();
  if (t) {
    const cleaned = t.includes("<") ? splitInjected(t).prompt : t;
    const line = firstLine(cleaned, 140);
    if (line && !/^<[\w-]+/.test(line)) return line;
  }
  if (prompts.length) return firstLine(prompts[0].text, 120) || "(untitled)";
  return "(untitled)";
}

function joinPrompts(prompts: Part[]): string {
  let out = "";
  for (const p of prompts) {
    const t = p.text.trim();
    if (!t) continue;
    if (out.length + t.length > PROMPT_TEXT_CAP) {
      out += t.slice(0, Math.max(0, PROMPT_TEXT_CAP - out.length));
      break;
    }
    out += (out ? "\n" : "") + t;
  }
  return out;
}

export function stripDetail(detail: SessionDetail): SessionSummary {
  const { messages: _messages, parts: _parts, richParts: _rich, ...summary } = detail;
  void _messages;
  void _parts;
  void _rich;
  return summary;
}
