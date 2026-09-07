import type { Message, ProjectRef, SessionDetail, SessionSummary, SourceRef, Surface, ToolId } from "../types";
import { buildPromptText, cleanPrompt, deriveTitle, firstLine } from "./text";
import { maxIso, minIso, toIso } from "./time";

export interface BuildInput {
  tool: ToolId;
  surface: Surface;
  nativeId: string;
  title?: string | null;
  project: ProjectRef;
  messages: Message[];
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

/** Assemble a normalized session from parsed messages plus metadata. */
export function buildSession(input: BuildInput): SessionDetail {
  const messages = input.messages.filter((m) => m.text.trim() || m.toolCalls?.length);
  let start = toIso(input.startedAt);
  let end = toIso(input.endedAt);
  for (const m of messages) {
    if (!m.timestamp) continue;
    start = minIso(start, m.timestamp);
    end = maxIso(end, m.timestamp);
  }
  const fallback = toIso(input.fallbackTime) ?? new Date(0).toISOString();
  start = start ?? end ?? fallback;
  end = end ?? start;

  const model = input.model ?? messages.map((m) => m.model).find(Boolean);
  const firstUser = messages.find((m) => m.role === "user" && cleanPrompt(m.text));
  const firstPrompt = firstUser ? firstLine(cleanPrompt(firstUser.text), 300) : "";

  const summary: SessionSummary = {
    key: `${input.tool}:${input.nativeId}`,
    tool: input.tool,
    surface: input.surface,
    nativeId: input.nativeId,
    title: deriveTitle(input.title, messages),
    project: input.project,
    startedAt: start,
    endedAt: end,
    messageCount: messages.length,
    userMessageCount: messages.filter((m) => m.role === "user").length,
    assistantMessageCount: messages.filter((m) => m.role === "assistant").length,
    toolCallCount: messages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0),
    model,
    gitBranch: input.gitBranch,
    firstPrompt,
    promptText: buildPromptText(messages),
    source: input.source,
    parentKey: input.parentKey,
    extra: input.extra,
  };
  return { ...summary, messages };
}

export function stripDetail(detail: SessionDetail): SessionSummary {
  const { messages: _messages, ...summary } = detail;
  void _messages;
  return summary;
}
