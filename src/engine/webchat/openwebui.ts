import type { Message, ScanResult, SessionDetail, SourceAdapter } from "../types";
import { buildSession, stripDetail } from "../util/session";
import { cleanPrompt, extractText, isRecord, normalizeRole, str } from "../util/text";

type Rec = Record<string, unknown>;

/**
 * Open WebUI is the one mainstream chat box with a real, documented REST API
 * for history (`/api/v1/chats`). Configure OPENWEBUI_URL + OPENWEBUI_API_KEY.
 */
function config() {
  const url = process.env.OPENWEBUI_URL?.replace(/\/$/, "");
  const key = process.env.OPENWEBUI_API_KEY;
  return url && key ? { url, key } : null;
}

async function api<T>(cfg: { url: string; key: string }, p: string): Promise<T> {
  const res = await fetch(`${cfg.url}${p}`, { headers: { Authorization: `Bearer ${cfg.key}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${p} -> ${res.status}`);
  return (await res.json()) as T;
}

function chatToSession(cfg: { url: string }, chat: Rec): SessionDetail | null {
  const inner = isRecord(chat.chat) ? chat.chat : chat;
  let list: Rec[] = Array.isArray(inner.messages) ? (inner.messages as Rec[]) : [];
  if (!list.length && isRecord(inner.history) && isRecord(inner.history.messages)) list = Object.values(inner.history.messages as Record<string, Rec>);
  const messages: Message[] = [];
  for (const m of list) {
    const role = normalizeRole(m.role);
    if (!role || role === "system") continue;
    const text = extractText(m.content);
    if (!text.trim()) continue;
    messages.push({ role, text: role === "user" ? cleanPrompt(text) : text, timestamp: m.timestamp ? new Date(Number(m.timestamp) * (Number(m.timestamp) < 1e11 ? 1000 : 1)).toISOString() : undefined, model: str(m.model) });
  }
  if (!messages.length) return null;
  const id = str(chat.id) ?? str(inner.id);
  if (!id) return null;
  const models = Array.isArray(inner.models) ? (inner.models as unknown[]).filter((x) => typeof x === "string") : [];
  return buildSession({
    tool: "openwebui",
    surface: "web",
    nativeId: id,
    title: str(chat.title) ?? str(inner.title),
    project: { path: cfg.url, name: new URL(cfg.url).host },
    messages,
    source: { kind: "api", path: cfg.url, locator: id },
    startedAt: chat.created_at,
    endedAt: chat.updated_at,
    model: (models[0] as string | undefined) ?? undefined,
  });
}

export const openwebui: SourceAdapter = {
  id: "openwebui",
  name: "Open WebUI",
  vendor: "open-webui.com (self-hosted)",
  surface: "web",
  configHints: ["OPENWEBUI_URL", "OPENWEBUI_API_KEY"],
  strategies: [{ kind: "api", status: "implemented", description: "REST: GET /api/v1/chats/?page=N then GET /api/v1/chats/{id}." }],
  async detect() {
    const cfg = config();
    return { installed: !!cfg, locations: [{ path: cfg?.url ?? "OPENWEBUI_URL (unset)", exists: !!cfg }] };
  },
  async scan(): Promise<ScanResult> {
    const cfg = config();
    const result: ScanResult = { sessions: [], seen: [], warnings: [] };
    if (!cfg) return result;
    for (let page = 1; page < 200; page++) {
      const list = await api<Rec[]>(cfg, `/api/v1/chats/?page=${page}`);
      if (!Array.isArray(list) || !list.length) break;
      for (const item of list) {
        const id = str(item.id);
        if (!id) continue;
        try {
          const chat = await api<Rec>(cfg, `/api/v1/chats/${encodeURIComponent(id)}`);
          const d = chatToSession(cfg, chat);
          if (d) result.sessions.push(stripDetail(d));
        } catch (err) {
          result.warnings.push(`${id}: ${(err as Error).message}`);
        }
      }
    }
    result.seen.push({ path: cfg.url, mtimeMs: Date.now(), size: result.sessions.length });
    return result;
  },
  async load(summary) {
    const cfg = config();
    if (!cfg) return null;
    const chat = await api<Rec>(cfg, `/api/v1/chats/${encodeURIComponent(summary.nativeId)}`);
    return chatToSession(cfg, chat);
  },
};
