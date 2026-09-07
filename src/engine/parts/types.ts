/**
 * Part model: the retrieval unit shared by every agent.
 *
 * A session is an ordered list of typed parts. The vocabulary follows the
 * DeepSeek Harness session log (event → message.source → content block):
 * who produced the text (`role`), what kind of thing it is (`kind`), and for
 * tool traffic a cross-agent `category` so "every shell command I ran" means
 * the same thing for Claude Code, Codex, Cursor and dsh.
 *
 * Adapters may emit parts directly (rich path: reasoning, full tool
 * arguments, tool results with error flags, injected context classified by
 * form). Adapters that only produce legacy `Message`s get parts derived from
 * them (`partsFromMessages`), so every tool participates at basic fidelity.
 */
import type { Role } from "../types";

export type PartKind =
  /** Human utterance. Each prompt opens a new turn. */
  | "prompt"
  /** Text injected by the harness/IDE into the model context: instructions (AGENTS.md), environment snapshots, notices, attachments, recalled history, system prompts. */
  | "context"
  /** Assistant reasoning / thinking, when the source keeps it. */
  | "reasoning"
  /** Assistant visible text. */
  | "reply"
  /** Assistant tool invocation with full arguments. */
  | "tool_call"
  /** Tool output paired with a call. */
  | "tool_result"
  /** Plan / todo list updates (todo_write, update_plan, plan mode). */
  | "plan"
  /** Subagent spawn / wait / handoff; `child` links to the child session when known. */
  | "subagent"
  /** Compaction summary that replaced earlier history. */
  | "compaction"
  /** Log-only records worth keeping: turn end reasons, errors, approvals, mode switches. */
  | "event";

export const PART_KINDS: PartKind[] = ["prompt", "context", "reasoning", "reply", "tool_call", "tool_result", "plan", "subagent", "compaction", "event"];

/** Cross-agent normalisation of tool names. */
export type ToolCategory =
  | "shell" // run a command
  | "read" // read a file / list a directory
  | "edit" // create / edit / delete / patch a file
  | "search" // grep / glob / semantic code search
  | "web" // web search / fetch
  | "subagent" // spawn / wait / message a subagent
  | "plan" // todo / plan updates
  | "ask" // ask the user a question
  | "browser" // browser automation
  | "mcp" // MCP or other external tool
  | "other";

export const TOOL_CATEGORIES: ToolCategory[] = ["shell", "read", "edit", "search", "web", "subagent", "plan", "ask", "browser", "mcp", "other"];

/** What an injected `context` part is, mirroring dsh's `ContextForm`. */
export type ContextForm =
  | "instructions" // AGENTS.md / CLAUDE.md / rules
  | "snapshot" // environment, cwd, git status, open files, timestamp
  | "notice" // task finished, background job completed, system notification
  | "attachment" // files / images the user attached
  | "recall" // cross-session references, memories
  | "system" // system prompt text
  | "unknown";

export interface PartTool {
  /** Tool name as the agent calls it (`Bash`, `exec_command`, `run_terminal_command_v2`, ...). */
  name: string;
  category: ToolCategory;
  callId?: string;
  /** Parsed arguments when available (object), otherwise the raw string. */
  args?: unknown;
  /** Extracted shell command line for `shell` calls. */
  command?: string;
}

export interface PartResult {
  callId?: string;
  isError?: boolean;
  exitCode?: number;
  /** The source itself truncated the output (not our index cap). */
  truncated?: boolean;
}

export interface Part {
  /** 0-based position inside the session. Stable for a given source file content. */
  seq: number;
  /** 1-based human turn; 0 for parts before the first prompt. */
  turn: number;
  kind: PartKind;
  role: Role;
  timestamp?: string;
  model?: string;
  /** Canonical searchable text. tool_call: rendered arguments; tool_result: output. */
  text: string;
  /** For `context` parts. */
  form?: ContextForm;
  tool?: PartTool;
  result?: PartResult;
  /** Files referenced by this part (edit/read targets, attachments, patch headers). Absolute or repo-relative as the source had them. */
  files?: string[];
  /** Subagent parts: child session key when the source links it. */
  child?: string;
  usage?: { input?: number; output?: number };
  /** Original text length before any cap applied by the adapter. */
  bytes?: number;
}

/** One human turn: the prompt and everything the agent did until the next prompt. */
export interface Turn {
  turn: number;
  startSeq: number;
  endSeq: number;
  startedAt?: string;
  endedAt?: string;
  /** First prompt text of the turn (full). */
  prompt: string;
  /** Last assistant reply of the turn (full). */
  reply: string;
  partCount: number;
  toolCalls: number;
  byCategory: Partial<Record<ToolCategory, number>>;
  errors: number;
  reasoningParts: number;
  files: string[];
  commands: string[];
  /** Child session keys spawned in this turn. */
  children: string[];
}

export interface SessionOutline {
  key: string;
  partCount: number;
  turns: Turn[];
  byKind: Partial<Record<PartKind, number>>;
  byCategory: Partial<Record<ToolCategory, number>>;
  toolNames: Record<string, number>;
  files: { path: string; edits: number; reads: number }[];
  errors: number;
  contextParts: number;
  compactions: number;
}

export interface PartQuery {
  /** Free text; FTS5 trigram when >= 3 chars, substring otherwise. */
  text?: string;
  kinds?: PartKind[];
  categories?: ToolCategory[];
  /** Exact tool name (case-insensitive). */
  toolName?: string;
  /** Substring on referenced files. */
  file?: string;
  /** Restrict to one session (exact key). */
  sessionKey?: string;
  /** Session-level filters (joined on the sessions table). */
  tools?: string[];
  project?: string;
  since?: string;
  until?: string;
  onlyErrors?: boolean;
  role?: Role;
  limit?: number;
  offset?: number;
  order?: "desc" | "asc";
}

export interface PartHit {
  sessionKey: string;
  /** Session metadata for display. */
  tool: string;
  title: string;
  project: string;
  seq: number;
  turn: number;
  kind: PartKind;
  role: Role;
  category?: ToolCategory;
  toolName?: string;
  form?: ContextForm;
  isError?: boolean;
  timestamp?: string;
  files?: string[];
  /** Text around the match (FTS snippet) or the head of the part. */
  snippet: string;
  bytes: number;
}

export interface FileStat {
  path: string;
  edits: number;
  reads: number;
  sessions: number;
  lastActivity?: string;
  sessionKeys: string[];
}
