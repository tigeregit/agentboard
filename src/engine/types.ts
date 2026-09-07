/**
 * Normalized data model shared by every source adapter, the index store,
 * the CLI and the dashboard.
 */

export type ToolId =
  | "claude-code"
  | "codex"
  | "cursor"
  | "opencode"
  | "copilot-cli"
  | "copilot-desktop"
  | "vscode-copilot"
  | "grok-build"
  | "pi"
  | "kimi"
  | "deepseek-harness"
  | "trae"
  | "workbuddy"
  | "minimax"
  | "zcode"
  | "chatgpt"
  | "claude-web"
  | "openwebui";

/** Where the user interacted with the tool. */
export type Surface = "cli" | "ide" | "desktop" | "web";

export type Role = "user" | "assistant" | "system" | "tool";

export interface ToolCall {
  name: string;
  /** Short human-readable rendering of the arguments (path, command, ...). */
  summary?: string;
}

export interface Message {
  role: Role;
  text: string;
  /** ISO-8601 timestamp when known. */
  timestamp?: string;
  model?: string;
  toolCalls?: ToolCall[];
}

/** How a record was obtained. Drives the "future compatibility" story. */
export type SourceKind =
  | "file" // parsed from the tool's private on-disk format
  | "sqlite" // read from the tool's private SQLite database
  | "native-index" // read via an index/query surface the tool itself maintains
  | "api" // fetched from a query API exposed by the tool
  | "import"; // imported from an official user data export

export interface SourceRef {
  kind: SourceKind;
  /** File path / DB path / URL that produced the record. */
  path: string;
  /** Extra locator inside the source (row id, sub-path, ...). */
  locator?: string;
}

export interface ProjectRef {
  /** Absolute working directory when known; otherwise a stable label. */
  path: string;
  /** Short display name (usually the last path segment). */
  name: string;
}

export interface SessionSummary {
  /** Globally unique key: `${tool}:${nativeId}`. */
  key: string;
  tool: ToolId;
  surface: Surface;
  nativeId: string;
  title: string;
  project: ProjectRef;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  model?: string;
  gitBranch?: string;
  /** First user prompt, trimmed. */
  firstPrompt: string;
  /** Concatenated user prompts (capped) for search. */
  promptText: string;
  source: SourceRef;
  /** Parent session key for subagents / forks when the tool records it. */
  parentKey?: string;
  extra?: Record<string, unknown>;
}

export interface SessionDetail extends SessionSummary {
  messages: Message[];
}

/** One way an adapter can obtain data. Listed in order of preference. */
export interface Strategy {
  kind: SourceKind | "browser";
  status: "implemented" | "reserved" | "unavailable";
  description: string;
}

export interface Detection {
  /** True when at least one candidate location exists on this machine. */
  installed: boolean;
  /** Locations that were probed, with whether they exist. */
  locations: { path: string; exists: boolean; note?: string }[];
  /** Human readable notes: encrypted store, unsupported version, ... */
  notes?: string[];
}

export interface ScanContext {
  /**
   * Returns true when the given source file has already been indexed with the
   * same fingerprint. Adapters should skip re-parsing such files.
   */
  isFresh(path: string, mtimeMs: number, size: number): boolean;
  /** Force full re-scan, ignoring freshness. */
  full: boolean;
  /** Optional progress callback. */
  log?(message: string): void;
  /** Per-scan scratch space shared by adapters that read the same store. */
  memo?: Map<string, unknown>;
}

export interface ScanResult {
  /** Sessions parsed in this pass (only from stale/new files). */
  sessions: SessionSummary[];
  /**
   * Every source path the adapter currently sees, with fingerprints, so the
   * indexer can remove sessions whose source disappeared.
   */
  seen: { path: string; mtimeMs: number; size: number }[];
  warnings: string[];
}

export interface SourceAdapter {
  id: ToolId;
  name: string;
  vendor: string;
  surface: Surface;
  /** Ordered strategies; the first `implemented` one is what `scan` does. */
  strategies: Strategy[];
  /** Env vars / paths this adapter honours, for docs and `sources` output. */
  configHints: string[];
  detect(): Promise<Detection>;
  scan(ctx: ScanContext): Promise<ScanResult>;
  /** Re-read a single session with its full transcript. */
  load(summary: SessionSummary): Promise<SessionDetail | null>;
}

export interface SessionQuery {
  tools?: ToolId[];
  /** Substring match on project path or name. */
  project?: string;
  /** ISO date/time lower bound (inclusive) on session activity. */
  since?: string;
  /** ISO date/time upper bound (exclusive) on session activity. */
  until?: string;
  /** Free-text search on title / prompts / project. */
  search?: string;
  surface?: Surface;
  limit?: number;
  offset?: number;
  order?: "desc" | "asc";
}

export interface ProjectStat {
  path: string;
  name: string;
  sessionCount: number;
  messageCount: number;
  tools: ToolId[];
  firstActivity: string;
  lastActivity: string;
}

export interface ToolStat {
  tool: ToolId;
  sessionCount: number;
  messageCount: number;
  lastActivity: string | null;
}

export interface DayBucket {
  /** YYYY-MM-DD in local time. */
  day: string;
  sessionCount: number;
  messageCount: number;
  byTool: Partial<Record<ToolId, number>>;
}
