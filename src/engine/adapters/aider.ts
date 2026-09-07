import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Message, SessionDetail, SourceAdapter } from "../types";
import { expand, home, listDirs, projectFromPath, statSafe } from "../util/paths";
import { buildSession } from "../util/session";
import { cleanPrompt } from "../util/text";
import { toIso } from "../util/time";
import { detection, fileSource, scanFiles } from "./_shared";

/**
 * Aider keeps one markdown transcript per project: `<project>/.aider.chat.history.md`.
 * The file holds many sessions separated by `# aider chat started at YYYY-MM-DD HH:MM:SS`
 * headers. Inside a session `#### ` lines are the user's prompt (one line per
 * prompt line), `> ` lines are aider's own announcements / tool output
 * (`> Applied edit to …`, `> Tokens: …`) and everything else is the assistant.
 * There is no central store, so projects are discovered with a shallow scan of
 * the usual code roots under $HOME (plus `AGENTBOARD_AIDER_DIRS`).
 */
const HISTORY_FILE = ".aider.chat.history.md";
const INPUT_HISTORY_FILE = ".aider.input.history";
const SESSION_HEADER_PREFIX = "# aider chat started at ";
const CODE_ROOTS = ["client", "projects", "code", "src", "dev", "work", "repos"];
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", ".git"]);

function searchRoots(): string[] {
  const h = home();
  const roots = CODE_ROOTS.map((d) => path.join(h, d)).filter((d) => fs.existsSync(d));
  roots.push(h);
  for (const extra of process.env.AGENTBOARD_AIDER_DIRS?.split(path.delimiter) ?? []) if (extra) roots.push(expand(extra));
  return Array.from(new Set(roots));
}

function isHistoryFile(p: string): boolean {
  const st = statSafe(p);
  if (!st?.isFile()) return false;
  try {
    return !fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** History files in each root and its immediate children (depth 1). */
function historyFiles(): string[] {
  const out = new Set<string>();
  const add = (dir: string) => {
    const f = path.join(dir, HISTORY_FILE);
    if (isHistoryFile(f)) out.add(realpath(f));
  };
  for (const root of searchRoots()) {
    add(root);
    for (const child of listDirs(root)) {
      const name = path.basename(child);
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      add(child);
    }
  }
  return Array.from(out);
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

interface AiderSession {
  index: number;
  /** Raw header timestamp (`2025-03-26 14:32:01`), if the header carried one. */
  header?: string;
  startedAt?: string;
  lines: string[];
}

/** "2025-03-26 14:32:01" -> "2025-03-26T14:32:01Z" (CCHV treats the header as UTC). */
function headerToIso(ts: string): string | undefined {
  const t = ts.trim();
  if (t.length >= 19) return toIso(`${t.slice(0, 10)}T${t.slice(11, 19)}Z`);
  return toIso(t);
}

export function splitAiderSessions(content: string): AiderSession[] {
  const sessions: AiderSession[] = [];
  let current: AiderSession = { index: 0, lines: [] };
  const flush = () => {
    if (current.lines.length) sessions.push({ ...current, index: sessions.length });
  };
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith(SESSION_HEADER_PREFIX)) {
      flush();
      const header = line.slice(SESSION_HEADER_PREFIX.length).trim();
      current = { index: sessions.length, header, startedAt: headerToIso(header), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return sessions;
}

const MODEL_LINE = /^(?:Main model|Model):\s*(.+?)(?:\s+with\s+.+\s+edit format)?\s*$/i;

/** Turn a session's lines into messages; consecutive `#### ` / `> ` lines are grouped. */
export function parseAiderMessages(lines: string[], timestamp?: string): { messages: Message[]; model?: string } {
  const messages: Message[] = [];
  let role: Message["role"] | null = null;
  let buf: string[] = [];
  let model: string | undefined;
  let inFence = false;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (role && text) {
      if (role === "user") {
        const cleaned = cleanPrompt(text);
        if (cleaned) messages.push({ role, text: cleaned, timestamp });
      } else if (role === "tool") {
        messages.push({ role, text: text.slice(0, 4000), timestamp });
      } else {
        messages.push({ role, text, timestamp });
      }
    }
    buf = [];
  };
  const start = (r: Message["role"], first: string) => {
    if (role !== r) {
      flush();
      role = r;
    }
    buf.push(first);
  };
  for (const line of lines) {
    if (!inFence && line.startsWith("#### ")) {
      start("user", line.slice(5));
      continue;
    }
    if (!inFence && line.startsWith("> ")) {
      const t = line.slice(2);
      const m = t.match(MODEL_LINE);
      if (m && !model) model = m[1].trim();
      start("tool", t);
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (role === "assistant") buf.push(line);
    else if (line.trim()) start("assistant", line);
  }
  flush();
  return { messages, model };
}

function projectHash(dir: string): string {
  return crypto.createHash("sha1").update(dir).digest("hex").slice(0, 12);
}

export function parseAiderFile(file: string): SessionDetail[] {
  const content = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  const hash = projectHash(dir);
  const project = projectFromPath(dir);
  const mtime = fs.statSync(file).mtimeMs;
  const out: SessionDetail[] = [];
  const used = new Map<string, number>();
  for (const s of splitAiderSessions(content)) {
    const { messages, model } = parseAiderMessages(s.lines, s.startedAt);
    if (!messages.length) continue;
    const stamp = s.startedAt ? s.startedAt.replace(/\D/g, "").slice(0, 14) : `nots${s.index}`;
    const n = used.get(stamp) ?? 0;
    used.set(stamp, n + 1);
    const nativeId = `${hash}-${stamp}${n ? `-${n}` : ""}`;
    out.push(
      buildSession({
        tool: "aider",
        surface: "cli",
        nativeId,
        project,
        messages,
        source: fileSource(file, s.header ?? `#${s.index}`),
        startedAt: s.startedAt,
        model,
        fallbackTime: mtime,
        extra: { sessionIndex: s.index },
      }),
    );
  }
  return out;
}

export const aider: SourceAdapter = {
  id: "aider",
  name: "Aider",
  vendor: "Aider AI",
  surface: "cli",
  configHints: [`AGENTBOARD_AIDER_DIRS (path-delimited list of extra project dirs, scanned like the default roots)`, `default roots: ~/{${CODE_ROOTS.join(",")}} and ~ itself, each plus its immediate subdirectories`],
  strategies: [
    { kind: "file", status: "implemented", description: `<project>/${HISTORY_FILE}: sessions split on "${SESSION_HEADER_PREFIX}<YYYY-MM-DD HH:MM:SS>"; "#### " lines = user prompt, "> " lines = aider/tool output, rest = assistant.` },
    { kind: "file", status: "reserved", description: `<project>/${INPUT_HISTORY_FILE} (prompt-only readline history, "# <timestamp>" + "+<line>" records); redundant with the chat history so not indexed.` },
  ],
  async detect() {
    const files = historyFiles();
    if (files.length) return detection(files.map((p) => ({ path: p })));
    return detection(
      searchRoots().map((p) => ({ path: path.join(p, HISTORY_FILE), note: `also probed <dir>/*/${HISTORY_FILE}` })),
      [`no ${HISTORY_FILE} found in the default code roots; set AGENTBOARD_AIDER_DIRS for projects elsewhere`],
    );
  },
  async scan(ctx) {
    return scanFiles(historyFiles(), ctx, async (file) => parseAiderFile(file));
  },
  async load(summary) {
    return parseAiderFile(summary.source.path).find((s) => s.nativeId === summary.nativeId) ?? null;
  },
};
