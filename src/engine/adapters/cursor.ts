import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, ScanContext, ScanResult, SessionDetail, SessionSummary, SourceAdapter } from "../types";
import { readJsonSafe, readJsonl } from "../util/jsonl";
import { appDataRoots, decodeDashedCwd, expand, listDirs, projectFromPath, statSafe, walk } from "../util/paths";
import { buildSession, stripDetail } from "../util/session";
import { cleanPrompt, extractText, extractToolCalls, isRecord, normalizeRole, str, summarizeToolInput } from "../util/text";
import { toIso } from "../util/time";
import { openSqliteReadOnly, type SqliteDb } from "../util/sqlite";
import { detection, fileSource, scanFiles, sqliteSource } from "./_shared";

type Rec = Record<string, unknown>;

/**
 * Cursor keeps three independent stores:
 *  1. IDE chats: `state.vscdb` (SQLite) - `cursorDiskKV` rows `composerData:<id>`
 *     and `bubbleId:<composer>:<bubble>` in globalStorage, older chats in
 *     workspaceStorage `ItemTable` (`composer.composerData`, aichat tabs).
 *  2. CLI (`cursor-agent` / `agent`): `~/.cursor/chats/<md5(cwd)>/<id>/store.db`
 *     (blobs + meta) with a sibling meta.json.
 *  3. Lossy JSONL transcripts: `~/.cursor/projects/<enc>/agent-transcripts/**.jsonl`.
 */

function cursorConfigDir(): string {
  return expand(process.env.CURSOR_CONFIG_DIR || "~/.cursor");
}

function cliChatsRoots(): string[] {
  const roots = [path.join(cursorConfigDir(), "chats")];
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) roots.push(path.join(xdg, "Cursor", "chats"));
  roots.push(expand("~/.config/Cursor/chats"));
  return Array.from(new Set(roots));
}

function ideUserRoots(): string[] {
  return appDataRoots("Cursor")
    .map((r) => path.join(r, "User"))
    .filter((r) => fs.existsSync(r));
}

// ---------- CLI store.db ----------

function cliStoreDbs(): string[] {
  const out: string[] = [];
  for (const root of cliChatsRoots()) {
    for (const ws of listDirs(root)) for (const sess of listDirs(ws)) {
      const db = path.join(sess, "store.db");
      if (fs.existsSync(db)) out.push(db);
    }
  }
  return out;
}

function blobToJson(data: unknown): Rec | null {
  let buf: Buffer | null = null;
  if (Buffer.isBuffer(data)) buf = data;
  else if (data instanceof Uint8Array) buf = Buffer.from(data);
  else if (typeof data === "string") buf = Buffer.from(data, "utf8");
  if (!buf || buf.length === 0 || (buf[0] !== 0x7b && buf[0] !== 0x5b)) return null;
  try {
    const v = JSON.parse(buf.toString("utf8"));
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function decodeMetaRecord(db: SqliteDb): Rec {
  try {
    const rows = db.all<{ key: string; value: unknown }>("select key, value from meta");
    for (const r of rows) {
      let v = r.value;
      if (Buffer.isBuffer(v) || v instanceof Uint8Array) v = Buffer.from(v as Uint8Array).toString("utf8");
      if (typeof v !== "string") continue;
      let text = v;
      if (/^[0-9a-f]+$/i.test(v) && v.length % 2 === 0) text = Buffer.from(v, "hex").toString("utf8");
      try {
        const parsed = JSON.parse(text);
        if (isRecord(parsed)) return parsed;
      } catch {
        /* not json */
      }
    }
  } catch {
    /* no meta table */
  }
  return {};
}

function parseCliStore(dbPath: string): SessionDetail | null {
  const dir = path.dirname(dbPath);
  const meta = readJsonSafe<Rec>(path.join(dir, "meta.json")) ?? {};
  const db = openSqliteReadOnly(dbPath);
  if (!db) return null;
  const messages: Message[] = [];
  let agentMeta: Rec = {};
  try {
    if (!db.tables().includes("blobs")) return null;
    agentMeta = decodeMetaRecord(db);
    for (const row of db.all<{ data: unknown }>("select data from blobs order by rowid")) {
      const obj = blobToJson(row.data);
      if (!obj) continue;
      const role = normalizeRole(obj.role);
      if (!role) continue;
      const content = obj.content;
      const text = extractText(content);
      const toolCalls = extractToolCalls(content);
      if (Array.isArray(content)) {
        for (const part of content as Rec[]) {
          if (isRecord(part) && (part.type === "tool-call" || part.type === "tool_call")) {
            const name = str(part.toolName) ?? str(part.name) ?? "tool";
            toolCalls.push({ name, summary: summarizeToolInput(name, part.args ?? part.input) });
          }
        }
      }
      if (role === "user") {
        const cleaned = cleanPrompt(text);
        if (cleaned) messages.push({ role, text: cleaned });
      } else if (role === "assistant") {
        if (text.trim() || toolCalls.length) messages.push({ role, text, toolCalls: toolCalls.length ? toolCalls : undefined, model: str(obj.model) });
      } else if (role === "tool" && text) {
        messages.push({ role, text: text.slice(0, 4000) });
      }
    }
  } finally {
    db.close();
  }
  if (!messages.length) return null;
  const id = path.basename(dir);
  const cwd = str(meta.cwd) ?? str(meta.workspaceDir) ?? str(meta.workspacePath) ?? str(agentMeta.cwd) ?? str(agentMeta.workspaceDir) ?? str(agentMeta.workspacePath);
  return buildSession({
    tool: "cursor",
    surface: "cli",
    nativeId: id,
    title: str(meta.title) ?? str(meta.name) ?? str(agentMeta.name) ?? str(agentMeta.title),
    project: projectFromPath(cwd ?? `cursor-workspace/${path.basename(path.dirname(dir))}`),
    messages,
    source: sqliteSource(dbPath),
    startedAt: meta.createdAtMs ?? meta.createdAt ?? agentMeta.createdAt,
    endedAt: meta.updatedAtMs ?? meta.updatedAt ?? agentMeta.updatedAt,
    model: str(agentMeta.model) ?? str(meta.model),
    fallbackTime: fs.statSync(dbPath).mtimeMs,
  });
}

// ---------- CLI / IDE JSONL transcripts ----------

function transcriptFiles(): string[] {
  const out: string[] = [];
  for (const proj of listDirs(path.join(cursorConfigDir(), "projects"))) {
    const dir = path.join(proj, "agent-transcripts");
    out.push(...walk(dir, (_p, n) => n.endsWith(".jsonl"), { maxDepth: 3 }));
  }
  return out;
}

async function parseTranscript(file: string): Promise<SessionDetail | null> {
  const records = await readJsonl<Rec>(file);
  const messages: Message[] = [];
  for (const r of records) {
    const role = normalizeRole(r.role ?? (isRecord(r.message) ? r.message.role : undefined));
    if (!role) continue;
    const content = isRecord(r.message) ? r.message.content : r.content;
    const text = extractText(content);
    const toolCalls = extractToolCalls(content);
    if (role === "user") {
      const cleaned = cleanPrompt(text);
      if (cleaned) messages.push({ role, text: cleaned, timestamp: toIso(r.timestamp) });
    } else if (role === "assistant" && (text.trim() || toolCalls.length)) {
      messages.push({ role, text, timestamp: toIso(r.timestamp), toolCalls: toolCalls.length ? toolCalls : undefined });
    }
  }
  if (!messages.length) return null;
  const parts = file.split(path.sep);
  const projIdx = parts.lastIndexOf("projects");
  const encoded = projIdx >= 0 ? parts[projIdx + 1] : "";
  const repo = readJsonSafe<Rec>(path.join(cursorConfigDir(), "projects", encoded, "repo.json"));
  const cwd = str(repo?.path) ?? str(repo?.workspacePath) ?? (encoded ? decodeDashedCwd(encoded) : undefined);
  const id = path.basename(file, ".jsonl");
  const surface = parts.includes("agent-transcripts") && !cliStoreDbs().some((d) => d.includes(id)) ? "ide" : "cli";
  return buildSession({
    tool: "cursor",
    surface,
    nativeId: id,
    project: projectFromPath(cwd),
    messages,
    source: fileSource(file),
    fallbackTime: fs.statSync(file).mtimeMs,
  });
}

// ---------- IDE state.vscdb ----------

interface WorkspaceInfo {
  folder?: string;
  composerIds: Set<string>;
}

function workspaceIndex(user: string): Map<string, WorkspaceInfo> {
  const out = new Map<string, WorkspaceInfo>();
  for (const wsDir of listDirs(path.join(user, "workspaceStorage"))) {
    const wsJson = readJsonSafe<Rec>(path.join(wsDir, "workspace.json"));
    const uri = str(wsJson?.folder) ?? str(wsJson?.workspace);
    let folder: string | undefined;
    try {
      folder = uri?.startsWith("file:") ? fileURLToPath(uri) : uri;
    } catch {
      folder = uri;
    }
    const info: WorkspaceInfo = { folder, composerIds: new Set() };
    const db = openSqliteReadOnly(path.join(wsDir, "state.vscdb"));
    if (db) {
      try {
        const row = db.get<{ value: unknown }>("select value from ItemTable where key = 'composer.composerData'");
        const data = row ? blobToJson(row.value) : null;
        const all = Array.isArray(data?.allComposers) ? (data!.allComposers as Rec[]) : [];
        for (const c of all) {
          const id = str(c.composerId);
          if (id) info.composerIds.add(id);
        }
      } catch {
        /* older schema */
      } finally {
        db.close();
      }
    }
    out.set(wsDir, info);
  }
  return out;
}

function bubbleToMessage(b: Rec): Message | null {
  const type = b.type;
  const role = type === 1 || type === "user" ? "user" : "assistant";
  const text = str(b.text) ?? str(b.rawText) ?? extractText(b.richText) ?? "";
  const toolCalls: Message["toolCalls"] = [];
  const tool = isRecord(b.toolFormerData) ? b.toolFormerData : undefined;
  if (tool) {
    const name = str(tool.name) ?? str(tool.tool) ?? "tool";
    toolCalls.push({ name, summary: summarizeToolInput(name, tool.rawArgs ?? tool.params ?? tool.args) });
  }
  const modelInfo = isRecord(b.modelInfo) ? b.modelInfo : undefined;
  if (role === "user") {
    const cleaned = cleanPrompt(text);
    return cleaned ? { role, text: cleaned, timestamp: toIso(b.timestamp ?? b.createdAt) } : null;
  }
  if (!text.trim() && !toolCalls.length) return null;
  return { role, text, timestamp: toIso(b.timestamp ?? b.createdAt), model: str(modelInfo?.modelName), toolCalls: toolCalls.length ? toolCalls : undefined };
}

function readGlobalComposers(user: string, dbPath: string, onlyId?: string): SessionDetail[] {
  const db = openSqliteReadOnly(dbPath);
  if (!db) return [];
  const out: SessionDetail[] = [];
  try {
    if (!db.tables().includes("cursorDiskKV")) return [];
    const wsIndex = workspaceIndex(user);
    const folderForComposer = (id: string) => {
      for (const info of wsIndex.values()) if (info.composerIds.has(id)) return info.folder;
      return undefined;
    };
    const composerRows = onlyId
      ? db.all<{ key: string; value: unknown }>("select key, value from cursorDiskKV where key = ?", `composerData:${onlyId}`)
      : db.all<{ key: string; value: unknown }>("select key, value from cursorDiskKV where key like 'composerData:%'");
    for (const row of composerRows) {
      const composer = blobToJson(row.value);
      if (!composer) continue;
      const composerId = str(composer.composerId) ?? row.key.slice("composerData:".length);
      const headers = Array.isArray(composer.fullConversationHeadersOnly) ? (composer.fullConversationHeadersOnly as Rec[]) : [];
      const inline = Array.isArray(composer.conversation) ? (composer.conversation as Rec[]) : [];
      const bubbles: Rec[] = [];
      if (headers.length) {
        for (const h of headers) {
          const bubbleId = str(h.bubbleId);
          if (!bubbleId) continue;
          const b = db.get<{ value: unknown }>("select value from cursorDiskKV where key = ?", `bubbleId:${composerId}:${bubbleId}`);
          const parsed = b ? blobToJson(b.value) : null;
          if (parsed) bubbles.push(parsed);
        }
      } else if (inline.length) {
        bubbles.push(...inline);
      } else {
        for (const b of db.all<{ value: unknown }>("select value from cursorDiskKV where key like ? order by rowid", `bubbleId:${composerId}:%`)) {
          const parsed = blobToJson(b.value);
          if (parsed) bubbles.push(parsed);
        }
      }
      const messages = bubbles.map(bubbleToMessage).filter((m): m is Message => !!m);
      if (!messages.length) continue;
      const projectDir = bubbles.map((b) => str(b.workspaceProjectDir)).find(Boolean) ?? folderForComposer(composerId);
      out.push(
        buildSession({
          tool: "cursor",
          surface: "ide",
          nativeId: composerId,
          title: str(composer.name),
          project: projectFromPath(projectDir),
          messages,
          source: sqliteSource(dbPath, composerId),
          startedAt: composer.createdAt,
          endedAt: composer.lastUpdatedAt,
          extra: { mode: str(composer.unifiedMode) ?? str(composer.composerMode) },
        }),
      );
    }
  } finally {
    db.close();
  }
  return out;
}

/** Legacy per-workspace "aichat" tabs stored in workspaceStorage ItemTable. */
function readLegacyWorkspaceChats(wsDir: string, folder: string | undefined, dbPath: string): SessionDetail[] {
  const db = openSqliteReadOnly(dbPath);
  if (!db) return [];
  const out: SessionDetail[] = [];
  try {
    if (!db.tables().includes("ItemTable")) return [];
    const row = db.get<{ value: unknown }>("select value from ItemTable where key = 'workbench.panel.aichat.view.aichat.chatdata'");
    const data = row ? blobToJson(row.value) : null;
    const tabs = Array.isArray(data?.tabs) ? (data!.tabs as Rec[]) : [];
    for (const tab of tabs) {
      const bubbles = Array.isArray(tab.bubbles) ? (tab.bubbles as Rec[]) : [];
      const messages = bubbles.map(bubbleToMessage).filter((m): m is Message => !!m);
      if (!messages.length) continue;
      const id = str(tab.tabId) ?? `${path.basename(wsDir)}-${out.length}`;
      out.push(
        buildSession({
          tool: "cursor",
          surface: "ide",
          nativeId: id,
          title: str(tab.chatTitle),
          project: projectFromPath(folder),
          messages,
          source: sqliteSource(dbPath, id),
          endedAt: tab.lastSendTime,
          fallbackTime: fs.statSync(dbPath).mtimeMs,
        }),
      );
    }
  } finally {
    db.close();
  }
  return out;
}

function scanIde(ctx: ScanContext): ScanResult {
  const result: ScanResult = { sessions: [], seen: [], warnings: [] };
  for (const user of ideUserRoots()) {
    const globalDb = path.join(user, "globalStorage", "state.vscdb");
    const gstat = statSafe(globalDb);
    if (gstat) {
      const wal = statSafe(globalDb + "-wal");
      const mtime = Math.max(gstat.mtimeMs, wal?.mtimeMs ?? 0);
      const size = gstat.size + (wal?.size ?? 0);
      result.seen.push({ path: globalDb, mtimeMs: mtime, size });
      if (ctx.full || !ctx.isFresh(globalDb, mtime, size)) {
        try {
          for (const d of readGlobalComposers(user, globalDb)) result.sessions.push(stripDetail(d));
        } catch (err) {
          result.warnings.push(`${globalDb}: ${(err as Error).message}`);
        }
      }
    }
    const wsIndex = workspaceIndex(user);
    for (const [wsDir, info] of wsIndex) {
      const dbPath = path.join(wsDir, "state.vscdb");
      const stat = statSafe(dbPath);
      if (!stat) continue;
      result.seen.push({ path: dbPath, mtimeMs: stat.mtimeMs, size: stat.size });
      if (!ctx.full && ctx.isFresh(dbPath, stat.mtimeMs, stat.size)) continue;
      try {
        for (const d of readLegacyWorkspaceChats(wsDir, info.folder, dbPath)) result.sessions.push(stripDetail(d));
      } catch (err) {
        result.warnings.push(`${dbPath}: ${(err as Error).message}`);
      }
    }
  }
  return result;
}

export const cursor: SourceAdapter = {
  id: "cursor",
  name: "Cursor",
  vendor: "Anysphere",
  surface: "ide",
  configHints: ["CURSOR_CONFIG_DIR (default ~/.cursor)", "XDG_CONFIG_HOME (CLI chats on Linux)"],
  strategies: [
    { kind: "api", status: "reserved", description: "No public session query API (IDE or CLI)." },
    { kind: "sqlite", status: "implemented", description: "IDE: User/globalStorage/state.vscdb cursorDiskKV composerData:* + bubbleId:*; legacy workspaceStorage aichat tabs." },
    { kind: "sqlite", status: "implemented", description: "CLI: ~/.cursor/chats/<md5(cwd)>/<id>/store.db (JSON message blobs) + meta.json." },
    { kind: "file", status: "implemented", description: "Fallback: ~/.cursor/projects/<enc>/agent-transcripts/**/*.jsonl when no store.db exists for the id." },
  ],
  async detect() {
    return detection([
      ...ideUserRoots().map((u) => ({ path: path.join(u, "globalStorage", "state.vscdb"), note: "IDE chats" })),
      ...cliChatsRoots().map((r) => ({ path: r, note: "CLI chats" })),
      { path: path.join(cursorConfigDir(), "projects"), note: "agent transcripts" },
    ]);
  },
  async scan(ctx) {
    const result = scanIde(ctx);
    const stores = cliStoreDbs();
    const storeScan = await scanFiles(stores, ctx, async (file) => parseCliStore(file));
    result.sessions.push(...storeScan.sessions);
    result.seen.push(...storeScan.seen);
    result.warnings.push(...storeScan.warnings);
    const storeIds = new Set(stores.map((s) => path.basename(path.dirname(s))));
    const transcripts = transcriptFiles().filter((f) => !storeIds.has(path.basename(f, ".jsonl")));
    const tScan = await scanFiles(transcripts, ctx, parseTranscript);
    result.sessions.push(...tScan.sessions);
    result.seen.push(...tScan.seen);
    result.warnings.push(...tScan.warnings);
    return result;
  },
  async load(summary: SessionSummary) {
    const src = summary.source;
    if (src.kind === "sqlite" && src.path.endsWith("store.db")) return parseCliStore(src.path);
    if (src.kind === "sqlite" && src.path.includes("globalStorage")) {
      const user = path.dirname(path.dirname(src.path));
      return readGlobalComposers(user, src.path, summary.nativeId)[0] ?? null;
    }
    if (src.kind === "sqlite") {
      const wsDir = path.dirname(src.path);
      const user = path.dirname(path.dirname(wsDir));
      const folder = workspaceIndex(user).get(wsDir)?.folder;
      return readLegacyWorkspaceChats(wsDir, folder, src.path).find((s) => s.nativeId === summary.nativeId) ?? null;
    }
    return parseTranscript(src.path);
  },
};
