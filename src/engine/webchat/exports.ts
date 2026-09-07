import fs from "node:fs";
import path from "node:path";
import type { Message, SessionDetail, ToolId } from "../types";
import { buildSession } from "../util/session";
import { cleanPrompt, extractText, isRecord, normalizeRole, str } from "../util/text";
import { toIso } from "../util/time";

type Rec = Record<string, unknown>;

/**
 * Official data exports are the only sanctioned "query interface" the big web
 * chat products offer today. We parse them into normalized sessions.
 */

/** ChatGPT: Settings -> Data controls -> Export -> conversations.json (DAG in `mapping`). */
export function parseChatGptExport(json: unknown, sourcePath: string): SessionDetail[] {
  const list = Array.isArray(json) ? (json as Rec[]) : isRecord(json) && Array.isArray(json.conversations) ? (json.conversations as Rec[]) : [];
  const out: SessionDetail[] = [];
  for (const conv of list) {
    const mapping = isRecord(conv.mapping) ? (conv.mapping as Record<string, Rec>) : {};
    const nodes = linearizeMapping(mapping, str(conv.current_node));
    const messages: Message[] = [];
    let model: string | undefined;
    for (const node of nodes) {
      const msg = isRecord(node.message) ? node.message : null;
      if (!msg) continue;
      const author = isRecord(msg.author) ? msg.author : {};
      const role = normalizeRole(author.role);
      if (!role || role === "system") continue;
      const content = isRecord(msg.content) ? msg.content : {};
      const ctype = str(content.content_type);
      if (ctype && !["text", "multimodal_text", "code", "execution_output"].includes(ctype)) continue;
      const text = extractText(content.parts ?? content.text);
      const meta = isRecord(msg.metadata) ? msg.metadata : {};
      model = model ?? str(meta.model_slug);
      if (role === "tool") continue;
      if (!text.trim()) continue;
      messages.push({ role, text: role === "user" ? cleanPrompt(text) : text, timestamp: toIso(msg.create_time), model: str(meta.model_slug) });
    }
    if (!messages.length) continue;
    const id = str(conv.conversation_id) ?? str(conv.id) ?? `chatgpt-${out.length}`;
    out.push(
      buildSession({
        tool: "chatgpt",
        surface: "web",
        nativeId: id,
        title: str(conv.title),
        project: { path: str(conv.gizmo_id) ? `gpt/${conv.gizmo_id}` : "chatgpt.com", name: str(conv.gizmo_id) ? `GPT ${conv.gizmo_id}` : "ChatGPT" },
        messages,
        source: { kind: "import", path: sourcePath, locator: id },
        startedAt: conv.create_time,
        endedAt: conv.update_time,
        model: model ?? str(conv.default_model_slug),
      }),
    );
  }
  return out;
}

function linearizeMapping(mapping: Record<string, Rec>, currentNode: string | undefined): Rec[] {
  const ids = Object.keys(mapping);
  if (!ids.length) return [];
  let leaf = currentNode && mapping[currentNode] ? currentNode : undefined;
  if (!leaf) {
    // pick the leaf with the latest create_time
    let best: { id: string; t: number } | undefined;
    for (const id of ids) {
      const n = mapping[id];
      const children = Array.isArray(n.children) ? n.children : [];
      if (children.length) continue;
      const t = Number((isRecord(n.message) ? n.message.create_time : 0) ?? 0);
      if (!best || t > best.t) best = { id, t };
    }
    leaf = best?.id ?? ids[ids.length - 1];
  }
  const chain: Rec[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = leaf;
  while (cur && mapping[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.push(mapping[cur]);
    cur = str(mapping[cur].parent);
  }
  return chain.reverse();
}

/** Claude.ai: Settings -> Privacy -> Export data -> conversations.json (flat `chat_messages`). */
export function parseClaudeExport(json: unknown, sourcePath: string): SessionDetail[] {
  const list = Array.isArray(json) ? (json as Rec[]) : [];
  const out: SessionDetail[] = [];
  for (const conv of list) {
    const msgs = Array.isArray(conv.chat_messages) ? (conv.chat_messages as Rec[]) : [];
    const messages: Message[] = [];
    for (const m of msgs) {
      const role = normalizeRole(m.sender ?? m.role);
      if (!role) continue;
      let text = str(m.text) ?? "";
      if (!text.trim() && Array.isArray(m.content)) text = extractText(m.content);
      if (!text.trim()) continue;
      messages.push({ role, text: role === "user" ? cleanPrompt(text) : text, timestamp: toIso(m.created_at) });
    }
    if (!messages.length) continue;
    const id = str(conv.uuid) ?? `claude-${out.length}`;
    const project = str(conv.project_uuid);
    out.push(
      buildSession({
        tool: "claude-web",
        surface: "web",
        nativeId: id,
        title: str(conv.name),
        project: project ? { path: `claude-project/${project}`, name: str(conv.project_name) ?? `Project ${project.slice(0, 8)}` } : { path: "claude.ai", name: "Claude.ai" },
        messages,
        source: { kind: "import", path: sourcePath, locator: id },
        startedAt: conv.created_at,
        endedAt: conv.updated_at,
        model: str(conv.model),
      }),
    );
  }
  return out;
}

/**
 * Generic Markdown transcript import (e.g. Trae's chat export, VS Code
 * "Chat: Export Session", hand-written notes). Turns are recognised from
 * `**User**` / `**Assistant**` / `## User` / `> User:` style headings.
 */
export function parseMarkdownTranscript(text: string, opts: { tool: ToolId; sourcePath: string; title?: string; project?: string; timestamp?: string }): SessionDetail | null {
  const lines = text.split(/\r?\n/);
  const messages: Message[] = [];
  let role: Message["role"] | null = null;
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join("\n").trim();
    if (role && t) messages.push({ role, text: role === "user" ? cleanPrompt(t) : t });
    buf = [];
  };
  const headingRe = /^\s*(?:#{1,4}\s*|\*\*|>\s*|\[|-\s*)?(user|human|you|用户|assistant|ai|agent|trae|copilot|model|助手)\s*(?:\*\*|\]|[:：])?\s*(?:[:：].*)?$/i;
  for (const line of lines) {
    const m = line.match(headingRe);
    if (m) {
      flush();
      const r = m[1].toLowerCase();
      role = ["user", "human", "you", "用户"].includes(r) ? "user" : "assistant";
      continue;
    }
    buf.push(line);
  }
  flush();
  if (!messages.length) return null;
  const base = path.basename(opts.sourcePath).replace(/\.[^.]+$/, "");
  return buildSession({
    tool: opts.tool,
    surface: "ide",
    nativeId: `import-${base}`,
    title: opts.title ?? lines.find((l) => l.startsWith("# "))?.replace(/^#\s*/, ""),
    project: opts.project ? { path: opts.project, name: path.basename(opts.project) } : { path: "(imported)", name: "(imported)" },
    messages,
    source: { kind: "import", path: opts.sourcePath },
    fallbackTime: opts.timestamp ?? fs.statSync(opts.sourcePath).mtimeMs,
  });
}
