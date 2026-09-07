import fs from "node:fs";
import path from "node:path";
import type { Message, SessionDetail, SourceAdapter, ToolId } from "../types";
import { readJsonl } from "../util/jsonl";
import { decodeDashedCwd, expand, projectFromPath, walk } from "../util/paths";
import { buildSession } from "../util/session";
import { cleanPrompt, extractText, extractToolCalls, isRecord, normalizeRole, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { detection, fileSource, scanFiles } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * pi (and its forks: omp, prime-agent, OpenClaw) write tree-structured JSONL:
 * a `session` header, then entries with `id`/`parentId`. We follow the active
 * branch (last entry -> root) so forks/rewinds don't duplicate turns.
 */
export function parsePiRecords(records: Rec[], opts: { tool: ToolId; file: string; fallbackCwd?: string }): SessionDetail | null {
  const header = records.find((r) => r.type === "session") ?? {};
  const titleSlot = records.find((r) => r.type === "title");
  const entries = records.filter((r) => typeof r.id === "string");
  const byId = new Map(entries.map((e) => [e.id as string, e]));

  // active branch: walk from the last entry to the root
  let chain: Rec[] = [];
  const leaf = entries[entries.length - 1];
  if (leaf) {
    const seen = new Set<string>();
    let cur: Rec | undefined = leaf;
    while (cur && !seen.has(cur.id as string)) {
      seen.add(cur.id as string);
      chain.push(cur);
      const pid = str(cur.parentId);
      cur = pid ? byId.get(pid) : undefined;
    }
    chain.reverse();
    // if the chain is suspiciously short (broken parent links) fall back to file order
    if (chain.length < entries.length / 2) chain = entries;
  }

  const messages: Message[] = [];
  let name: string | undefined = str(header.title) ?? str(titleSlot?.title);
  let model: string | undefined;
  for (const e of chain) {
    const type = str(e.type);
    if (type === "session_info") {
      name = str(e.name) ?? name;
      continue;
    }
    if (type === "model_change") {
      model = [str(e.provider), str(e.modelId)].filter(Boolean).join("/") || model;
      continue;
    }
    if (type !== "message") continue;
    const msg = isRecord(e.message) ? e.message : e;
    const rawRole = str(msg.role);
    const ts = toIso(e.timestamp ?? msg.timestamp);
    if (rawRole === "toolResult" || rawRole === "tool") {
      const out = extractText(msg.content ?? msg.output);
      if (out) messages.push({ role: "tool", text: out.slice(0, 4000), timestamp: ts });
      continue;
    }
    const role = normalizeRole(rawRole);
    if (!role) continue;
    const content = msg.content;
    const text = extractText(content);
    const toolCalls = extractToolCalls(content);
    if (Array.isArray(content)) {
      for (const part of content as Rec[]) {
        if (isRecord(part) && part.type === "toolCall") {
          const n = str(part.name) ?? "tool";
          toolCalls.push({ name: n, summary: summarizeToolInput(n, part.arguments) });
        }
      }
    }
    if (role === "user") {
      const cleaned = cleanPrompt(text);
      if (cleaned) messages.push({ role, text: cleaned, timestamp: ts });
    } else if (role === "assistant" && (text.trim() || toolCalls.length)) {
      messages.push({ role, text, timestamp: ts, model: str(msg.model) ?? model, toolCalls: toolCalls.length ? toolCalls : undefined });
    }
  }
  if (!messages.length) return null;
  const parent = str(header.parentSession);
  return buildSession({
    tool: opts.tool,
    surface: "cli",
    nativeId: str(header.id) ?? path.basename(opts.file, ".jsonl"),
    title: name,
    project: projectFromPath(str(header.cwd) ?? opts.fallbackCwd),
    messages,
    source: fileSource(opts.file),
    startedAt: header.timestamp,
    model,
    parentKey: parent ? `${opts.tool}:${path.basename(parent, ".jsonl")}` : undefined,
    fallbackTime: fs.statSync(opts.file).mtimeMs,
  });
}

function sessionRoots(): string[] {
  const roots = [process.env.PI_SESSIONS_DIR, "~/.pi/agent/sessions"].filter((p): p is string => !!p).map(expand);
  return Array.from(new Set(roots));
}

function files(): string[] {
  const out: string[] = [];
  for (const root of sessionRoots()) out.push(...walk(root, (_p, n) => n.endsWith(".jsonl"), { maxDepth: 3 }));
  return out;
}

async function parseFile(file: string): Promise<SessionDetail | null> {
  const records = await readJsonl<Rec>(file);
  return parsePiRecords(records, { tool: "pi", file, fallbackCwd: decodeDashedCwd(path.basename(path.dirname(file))) });
}

export const pi: SourceAdapter = {
  id: "pi",
  name: "pi coding agent",
  vendor: "Mario Zechner (pi-mono)",
  surface: "cli",
  configHints: ["PI_SESSIONS_DIR (default ~/.pi/agent/sessions)"],
  strategies: [
    { kind: "api", status: "reserved", description: "pi's SessionManager is a library API, not a daemon; no remote query surface." },
    { kind: "file", status: "implemented", description: "~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl (tree entries, active branch followed)." },
  ],
  async detect() {
    return detection(sessionRoots().map((p) => ({ path: p })));
  },
  async scan(ctx) {
    return scanFiles(files(), ctx, parseFile);
  },
  async load(summary) {
    return parseFile(summary.source.path);
  },
};
