/**
 * Generates a synthetic home directory containing every storage format that
 * agentboard understands, so you can try the dashboard/CLI on a machine with
 * no agents installed (or verify parsers after an upstream format change).
 *
 *   npm run demo            # writes to /tmp/agentboard-demo-home
 *   AGENTBOARD_FAKE_HOME=/tmp/agentboard-demo-home npm run cli -- list
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSqlite } from "../src/engine/util/sqlite";
import type { Demo } from "./demo-lib";
import { FIXTURES } from "./fixtures";

/**
 * Wraps bytes in a valid zstd frame made of raw (stored) blocks. Node 22.14 has
 * no zstd encoder and fzstd is decode-only; a stored frame is enough to exercise
 * the harness adapter's multi-frame decoder.
 */
function compress(input: Uint8Array): Uint8Array {
  const MAX_BLOCK = 128 * 1024;
  const header = Buffer.alloc(4 + 1 + 4);
  header.writeUInt32LE(0xfd2fb528, 0);
  header[4] = 0xa0; // single segment, 4-byte frame content size, no checksum
  header.writeUInt32LE(input.length, 5);
  const blocks: Buffer[] = [header];
  if (input.length === 0) {
    blocks.push(Buffer.from([0x01, 0x00, 0x00]));
  }
  for (let off = 0; off < input.length; off += MAX_BLOCK) {
    const chunk = input.subarray(off, Math.min(off + MAX_BLOCK, input.length));
    const last = off + chunk.length >= input.length ? 1 : 0;
    const bh = last | (chunk.length << 3);
    blocks.push(Buffer.from([bh & 0xff, (bh >> 8) & 0xff, (bh >> 16) & 0xff]), Buffer.from(chunk));
  }
  return Buffer.concat(blocks);
}

const HOME = process.env.AGENTBOARD_FAKE_HOME || path.join(os.tmpdir(), "agentboard-demo-home");
const now = Date.now();
const H = 3600e3;
const D = 24 * H;

const PROJECTS = ["/Users/example/code/agentboard", "/Users/example/code/infra-terraform", "/Users/example/research/paper-reproduction", "/Users/example/code/mobile-app"];
const PROMPTS = [
  "Add a retry with exponential backoff to the S3 uploader and cover it with tests",
  "Why does the nightly job fail with a timezone error? Investigate and fix",
  "Refactor the auth middleware to use the new session store",
  "Write a weekly summary of the experiments in results/ as a markdown table",
  "Migrate the CI pipeline from CircleCI to GitHub Actions",
  "Profile the ingestion script; it takes 40 minutes on 2GB of logs",
  "Implement dark mode for the settings page",
  "Explain the difference between the two Kalman filter implementations in src/filters",
  "Bump dependencies and fix the resulting type errors",
  "Create a Dockerfile with a multi-stage build for the API",
];
const REPLIES = [
  "I looked at the uploader in `src/storage/s3.ts`. The failure comes from a missing `retry` around `PutObject`. I added a `withBackoff` helper (base 200ms, factor 2, 5 attempts) and three tests covering success, transient failure and exhaustion.",
  "The job reads `date.today()` in local time but compares against UTC timestamps from the database. I switched both to `datetime.now(timezone.utc)` and added a regression test that runs with `TZ=Asia/Shanghai`.",
  "Done. The middleware now pulls sessions from `SessionStore`, the old cookie parsing is removed, and all 42 tests pass.",
  "Here is the summary table. Three runs improved BLEU by 0.4-0.9; the run with the larger batch regressed and I flagged it.",
  "I ported the config to `.github/workflows/ci.yml`, kept the matrix (node 20/22) and added caching for pnpm. The first run is green.",
];
const TOOLS = ["Read", "Edit", "Bash", "Grep", "Write"];

function rnd<T>(list: T[], i: number): T {
  return list[i % list.length];
}
function ensure(p: string) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function write(p: string, content: string | Buffer) {
  ensure(path.dirname(p));
  fs.writeFileSync(p, content);
}
function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
function iso(t: number) {
  return new Date(t).toISOString();
}
function uuid(seed: string) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hex = (h.toString(16) + "abcdef0123456789abcdef0123456789").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function md5ish(s: string) {
  let h = 0x811c9dc5;
  for (const c of s) h = ((h ^ c.charCodeAt(0)) * 0x01000193) >>> 0;
  return (h.toString(16) + h.toString(16) + h.toString(16) + h.toString(16)).slice(0, 32);
}
const enc = (cwd: string) => cwd.replace(/[\/_]/g, "-");

/** Deterministic turn plan for one session. */
function turns(i: number, start: number) {
  const n = 2 + (i % 3);
  const out: { user: string; reply: string; tool: string; t: number }[] = [];
  for (let k = 0; k < n; k++) out.push({ user: rnd(PROMPTS, i + k), reply: rnd(REPLIES, i + k), tool: rnd(TOOLS, i + k), t: start + k * 6 * 60e3 });
  return out;
}

fs.rmSync(HOME, { recursive: true, force: true });
ensure(HOME);
let counter = 0;
const next = () => {
  counter++;
  return { i: counter, start: now - (counter % 13) * D - (counter % 7) * H, cwd: rnd(PROJECTS, counter) };
};

// ---------- Claude Code ----------
for (let s = 0; s < 6; s++) {
  const { i, start, cwd } = next();
  const id = uuid(`claude${i}`);
  const lines: unknown[] = [];
  for (const t of turns(i, start)) {
    lines.push({ type: "user", uuid: uuid(`u${i}${t.t}`), sessionId: id, cwd, gitBranch: "main", timestamp: iso(t.t), message: { role: "user", content: t.user } });
    lines.push({ type: "assistant", uuid: uuid(`a${i}${t.t}`), sessionId: id, cwd, timestamp: iso(t.t + 60e3), message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id: "tu1", name: t.tool, input: { file_path: `${cwd}/src/index.ts` } }] } });
    lines.push({ type: "user", uuid: uuid(`r${i}${t.t}`), sessionId: id, timestamp: iso(t.t + 61e3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "export const x = 1;" }] } });
    lines.push({ type: "assistant", uuid: uuid(`b${i}${t.t}`), sessionId: id, cwd, timestamp: iso(t.t + 120e3), message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: t.reply }] } });
  }
  if (s % 2) lines.unshift({ type: "summary", summary: `Claude: ${rnd(PROMPTS, i).slice(0, 40)}`, leafUuid: "x" });
  write(path.join(HOME, ".claude/projects", enc(cwd), `${id}.jsonl`), jsonl(lines));
}

// ---------- Codex ----------
for (let s = 0; s < 5; s++) {
  const { i, start, cwd } = next();
  const id = uuid(`codex${i}`);
  const d = new Date(start);
  const lines: unknown[] = [{ timestamp: iso(start), type: "session_meta", payload: { id, timestamp: iso(start), cwd, originator: "codex_cli_rs", cli_version: "0.80.0", git: { branch: "feat/backoff" } } }];
  lines.push({ timestamp: iso(start), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>" + cwd + "</cwd>\n</environment_context>" }] } });
  for (const t of turns(i, start)) {
    lines.push({ timestamp: iso(t.t), type: "event_msg", payload: { type: "user_message", message: t.user } });
    lines.push({ timestamp: iso(t.t), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: t.user }] } });
    lines.push({ timestamp: iso(t.t + 30e3), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["rg", "-n", "retry", "src"] }), call_id: "c1" } });
    lines.push({ timestamp: iso(t.t + 31e3), type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "src/storage/s3.ts:12:  // TODO retry" } });
    lines.push({ timestamp: iso(t.t + 90e3), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: t.reply }] } });
  }
  lines.push({ timestamp: iso(start), type: "turn_context", payload: { cwd, model: "gpt-5.6-sol" } });
  const p = path.join(HOME, ".codex/sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"), `rollout-${iso(start).replace(/[:.]/g, "-")}-${id}.jsonl`);
  write(p, jsonl(lines));
}

// ---------- Cursor: IDE state.vscdb + CLI store.db + JSONL transcript ----------
{
  const user = path.join(HOME, ".config/Cursor/User");
  const globalDb = openSqlite(path.join(ensure(path.join(user, "globalStorage")), "state.vscdb"));
  globalDb.exec("create table cursorDiskKV (key text primary key, value blob)");
  for (let s = 0; s < 4; s++) {
    const { i, start, cwd } = next();
    const composerId = uuid(`cursor-ide${i}`);
    const headers: unknown[] = [];
    let last = start;
    for (const t of turns(i, start)) {
      const b1 = uuid(`bub${i}${t.t}u`);
      const b2 = uuid(`bub${i}${t.t}a`);
      headers.push({ bubbleId: b1, type: 1 }, { bubbleId: b2, type: 2 });
      globalDb.run("insert into cursorDiskKV values (?,?)", `bubbleId:${composerId}:${b1}`, JSON.stringify({ type: 1, text: t.user, timestamp: t.t, workspaceProjectDir: cwd }));
      globalDb.run("insert into cursorDiskKV values (?,?)", `bubbleId:${composerId}:${b2}`, JSON.stringify({ type: 2, text: t.reply, timestamp: t.t + 90e3, modelInfo: { modelName: "claude-sonnet-5" }, toolFormerData: { name: "read_file", rawArgs: JSON.stringify({ path: "src/app.ts" }) } }));
      last = t.t + 90e3;
    }
    globalDb.run("insert into cursorDiskKV values (?,?)", `composerData:${composerId}`, JSON.stringify({ composerId, name: `Cursor: ${rnd(PROMPTS, i).slice(0, 36)}`, createdAt: start, lastUpdatedAt: last, unifiedMode: "agent", fullConversationHeadersOnly: headers }));
  }
  globalDb.close();
  // workspace mapping
  const wsHash = md5ish(PROJECTS[0]);
  write(path.join(user, "workspaceStorage", wsHash, "workspace.json"), JSON.stringify({ folder: `file://${PROJECTS[0]}` }));
  const wsDb = openSqlite(path.join(user, "workspaceStorage", wsHash, "state.vscdb"));
  wsDb.exec("create table ItemTable (key text primary key, value blob)");
  wsDb.run("insert into ItemTable values (?,?)", "composer.composerData", JSON.stringify({ allComposers: [] }));
  wsDb.close();

  for (let s = 0; s < 3; s++) {
    const { i, start, cwd } = next();
    const id = uuid(`cursor-cli${i}`);
    const dir = ensure(path.join(HOME, ".cursor/chats", md5ish(cwd), id));
    write(path.join(dir, "meta.json"), JSON.stringify({ title: `agent: ${rnd(PROMPTS, i).slice(0, 30)}`, cwd, createdAtMs: start, updatedAtMs: start + 20 * 60e3 }));
    const db = openSqlite(path.join(dir, "store.db"));
    db.exec("create table blobs (id text primary key, data blob); create table meta (key text primary key, value text)");
    db.run("insert into meta values (?,?)", "0", Buffer.from(JSON.stringify({ agentId: id, name: "agent", createdAt: start, model: "gpt-5.6-sol" })).toString("hex"));
    let n = 0;
    for (const t of turns(i, start)) {
      db.run("insert into blobs values (?,?)", `${id}-${n++}`, Buffer.from(JSON.stringify({ role: "user", content: t.user })));
      db.run("insert into blobs values (?,?)", `${id}-${n++}`, Buffer.from(JSON.stringify({ role: "assistant", content: [{ type: "tool-call", toolName: "shell", args: { command: "npm test" } }] })));
      db.run("insert into blobs values (?,?)", `${id}-${n++}`, Buffer.from(JSON.stringify({ role: "assistant", content: [{ type: "text", text: t.reply }] })));
    }
    db.close();
    // lossy transcript twin for one of them, plus one transcript-only session
    write(path.join(HOME, ".cursor/projects", enc(cwd).replace(/^-/, ""), "agent-transcripts", id, `${id}.jsonl`), jsonl([{ role: "user", message: { content: [{ type: "text", text: "dup" }] } }]));
  }
  {
    const { i, start, cwd } = next();
    const id = uuid(`cursor-tx${i}`);
    const lines = turns(i, start).flatMap((t) => [
      { role: "user", message: { content: [{ type: "text", text: t.user }] } },
      { role: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "TODO" } }, { type: "text", text: t.reply }] } },
    ]);
    write(path.join(HOME, ".cursor/projects", enc(cwd).replace(/^-/, ""), "agent-transcripts", id, `${id}.jsonl`), jsonl(lines));
    write(path.join(HOME, ".cursor/projects", enc(cwd).replace(/^-/, ""), "repo.json"), JSON.stringify({ path: cwd }));
  }
}

// ---------- OpenCode-family SQLite (opencode, zcode, minimax) ----------
function opencodeDb(file: string, count: number, model: string, tag: string) {
  const db = openSqlite(file);
  db.exec(`create table project (id text primary key, worktree text);
    create table session (id text primary key, project_id text, directory text not null, title text not null, version text, time_created integer, time_updated integer, parent_id text);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, session_id text, time_created integer, data text);
    create table model_usage (id text primary key, session_id text, model_id text, input_tokens integer, output_tokens integer, started_at integer);`);
  for (let s = 0; s < count; s++) {
    const { i, start, cwd } = next();
    const sid = `ses_${tag}${i}`;
    let last = start;
    let m = 0;
    for (const t of turns(i, start)) {
      const um = `msg_${sid}_${m++}`;
      db.run("insert into message values (?,?,?,?)", um, sid, t.t, JSON.stringify({ id: um, role: "user", sessionID: sid, time: { created: t.t } }));
      db.run("insert into part values (?,?,?,?,?)", `${um}_p0`, um, sid, t.t, JSON.stringify({ type: "text", text: t.user }));
      const am = `msg_${sid}_${m++}`;
      db.run("insert into message values (?,?,?,?)", am, sid, t.t + 40e3, JSON.stringify({ id: am, role: "assistant", sessionID: sid, modelID: model, providerID: tag, time: { created: t.t + 40e3 } }));
      db.run("insert into part values (?,?,?,?,?)", `${am}_p0`, am, sid, t.t + 40e3, JSON.stringify({ type: "tool", tool: "bash", state: { status: "completed", input: { command: "pytest -q" }, output: "12 passed" } }));
      db.run("insert into part values (?,?,?,?,?)", `${am}_p1`, am, sid, t.t + 80e3, JSON.stringify({ type: "text", text: t.reply }));
      last = t.t + 80e3;
    }
    db.run("insert into session values (?,?,?,?,?,?,?,?)", sid, "prj_1", cwd, `${tag}: ${rnd(PROMPTS, i).slice(0, 40)}`, "1.2.0", start, last, null);
    db.run("insert into model_usage values (?,?,?,?,?,?)", `mu_${sid}`, sid, model, 1200, 300, start);
  }
  db.close();
}
opencodeDb(path.join(ensure(path.join(HOME, ".local/share/opencode")), "opencode.db"), 4, "claude-sonnet-5", "opencode");
opencodeDb(path.join(ensure(path.join(HOME, ".zcode/cli/db")), "db.sqlite"), 3, "GLM-5.2", "zcode");
opencodeDb(path.join(ensure(path.join(HOME, ".minimax/data")), "mcode.db"), 3, "MiniMax-M2.5", "minimax");

// ---------- Copilot CLI + desktop + VS Code-hosted ----------
for (let s = 0; s < 6; s++) {
  const { i, start, cwd } = next();
  const id = uuid(`copilot${i}`);
  const host = s % 3 === 0 ? "cli" : s % 3 === 1 ? "app" : "vscode";
  const dir = ensure(path.join(HOME, ".copilot/session-state", id));
  const ev: unknown[] = [{ type: "session.start", timestamp: iso(start), data: { sessionId: id, context: { cwd, repository: "example/" + path.basename(cwd), branch: "main" } } }];
  ev.push({ type: "session.model_change", timestamp: iso(start), data: { model: "gpt-5.6-terra" } });
  for (const t of turns(i, start)) {
    ev.push({ type: "user.message", timestamp: iso(t.t), data: { content: t.user } });
    ev.push({ type: "assistant.message", timestamp: iso(t.t + 30e3), data: { content: "", toolRequests: [{ name: "bash", intentionSummary: "Run the test suite" }] } });
    ev.push({ type: "tool.execution_start", timestamp: iso(t.t + 31e3), data: { toolName: "bash", arguments: { command: "npm test" } } });
    ev.push({ type: "assistant.message", timestamp: iso(t.t + 90e3), data: { content: t.reply } });
  }
  ev.push({ type: "session.shutdown", timestamp: iso(start + H), data: { codeChanges: { filesModified: ["src/a.ts"] } } });
  write(path.join(dir, "events.jsonl"), jsonl(ev));
  write(path.join(dir, "workspace.yaml"), `id: ${id}\ncwd: ${cwd}\ngit_root: ${cwd}\nrepository: example/${path.basename(cwd)}\nhost_type: ${host}\nbranch: main\nsummary: "${host} · ${rnd(PROMPTS, i).slice(0, 40).replace(/"/g, "'")}"\ncreated_at: ${iso(start)}\nupdated_at: ${iso(start + H)}\n`);
}
// Newer Copilot builds drop host_type and record client_name + a user-facing name instead.
for (const [k, client] of ["github/autopilot", "github/cli"].entries()) {
  const { i, start, cwd } = next();
  const id = uuid(`copilot-client${k}`);
  const dir = ensure(path.join(HOME, ".copilot/session-state", id));
  const ev: unknown[] = [{ type: "session.start", timestamp: iso(start), data: { sessionId: id, context: { cwd, repository: "example/" + path.basename(cwd), branch: "main" } } }];
  for (const t of turns(i, start)) {
    ev.push({ type: "user.message", timestamp: iso(t.t), data: { content: t.user } });
    ev.push({ type: "assistant.message", timestamp: iso(t.t + 60e3), data: { content: t.reply } });
  }
  write(path.join(dir, "events.jsonl"), jsonl(ev));
  write(path.join(dir, "workspace.yaml"), `id: ${id}\ncwd: ${cwd}\nclient_name: ${client}\nname: "${client === "github/autopilot" ? "Desktop" : "CLI"} · ${rnd(PROMPTS, i).slice(0, 40).replace(/"/g, "'")}"\ncreated_at: ${iso(start)}\nupdated_at: ${iso(start + H)}\n`);
}
{
  const db = openSqlite(path.join(HOME, ".copilot/data.db"));
  db.exec("create table sessions (id text primary key, total_input_tokens integer, created_at text)");
  db.close();
  fs.writeFileSync(path.join(HOME, ".copilot/session-store.db"), "");
}

// ---------- VS Code Copilot Chat (jsonl mutation log + legacy json) ----------
{
  const user = path.join(HOME, ".config/Code/User");
  for (let s = 0; s < 4; s++) {
    const { i, start, cwd } = next();
    const wsHash = md5ish(cwd + "code");
    write(path.join(user, "workspaceStorage", wsHash, "workspace.json"), JSON.stringify({ folder: `file://${cwd}` }));
    const sid = uuid(`vscode${i}`);
    const reqs = turns(i, start).map((t, k) => ({
      requestId: `request_${k}`,
      timestamp: t.t,
      modelId: "copilot/claude-sonnet-4.6",
      agent: { id: "github.copilot.editsAgent" },
      message: { text: t.user, parts: [{ text: t.user }] },
      response: [{ kind: "toolInvocationSerialized", toolId: "copilot_readFile", invocationMessage: { value: "Read src/index.ts" } }, { value: t.reply }],
    }));
    if (s % 2 === 0) {
      const lines: unknown[] = [{ kind: 0, v: { version: 3, sessionId: sid, creationDate: start, requests: [reqs[0]], customTitle: `VS Code: ${rnd(PROMPTS, i).slice(0, 30)}` } }];
      for (const r of reqs.slice(1)) lines.push({ kind: 2, k: ["requests"], v: [r] });
      lines.push({ kind: 1, k: ["requests", 0, "response", 1, "value"], v: reqs[0].response[1].value + " (edited)" });
      write(path.join(user, "workspaceStorage", wsHash, "chatSessions", `${sid}.jsonl`), jsonl(lines));
    } else {
      write(path.join(user, "workspaceStorage", wsHash, "chatSessions", `${sid}.json`), JSON.stringify({ version: 3, sessionId: sid, creationDate: start, requests: reqs }));
    }
  }
}

// ---------- Grok Build ----------
for (let s = 0; s < 4; s++) {
  const { i, start, cwd } = next();
  const id = uuid(`grok${i}`);
  const dir = ensure(path.join(HOME, ".grok/sessions", encodeURIComponent(cwd), id));
  const lines: unknown[] = [];
  let p = 0;
  for (const t of turns(i, start)) {
    lines.push({ timestamp: Math.floor(t.t / 1000), params: { sessionId: id, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: t.user } }, _meta: { promptIndex: p } } });
    lines.push({ timestamp: Math.floor((t.t + 20e3) / 1000), params: { sessionId: id, update: { sessionUpdate: "tool_call", toolCallId: "tc1", title: "rg -n retry src", kind: "search", rawInput: { command: "rg -n retry src" } }, _meta: { promptId: `prompt-${p}` } } });
    const half = Math.floor(t.reply.length / 2);
    lines.push({ timestamp: Math.floor((t.t + 60e3) / 1000), params: { sessionId: id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t.reply.slice(0, half) } }, _meta: { promptId: `prompt-${p}` } } });
    lines.push({ timestamp: Math.floor((t.t + 61e3) / 1000), params: { sessionId: id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t.reply.slice(half) } }, _meta: { promptId: `prompt-${p}` } } });
    p++;
  }
  write(path.join(dir, "updates.jsonl"), jsonl(lines));
  write(path.join(dir, "summary.json"), JSON.stringify({ info: { id, cwd, created_at: iso(start), updated_at: iso(start + 40 * 60e3), model_id: "grok-build" }, generated_title: `Grok: ${rnd(PROMPTS, i).slice(0, 36)}`, created_at: iso(start), updated_at: iso(start + 40 * 60e3), model_id: "grok-build", session_kind: "main" }));
}

// ---------- pi ----------
for (let s = 0; s < 3; s++) {
  const { i, start, cwd } = next();
  const id = uuid(`pi${i}`);
  const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: iso(start), cwd }];
  let parent: string | null = null;
  let n = 0;
  lines.push({ type: "model_change", id: `e${n}`, parentId: parent, timestamp: iso(start), provider: "anthropic", modelId: "claude-opus-5" });
  parent = `e${n++}`;
  for (const t of turns(i, start)) {
    lines.push({ type: "message", id: `e${n}`, parentId: parent, timestamp: iso(t.t), message: { role: "user", content: [{ type: "text", text: t.user }], timestamp: t.t } });
    parent = `e${n++}`;
    lines.push({ type: "message", id: `e${n}`, parentId: parent, timestamp: iso(t.t + 30e3), message: { role: "assistant", content: [{ type: "toolCall", id: "tc", name: "bash", arguments: { command: "ls src" } }] } });
    parent = `e${n++}`;
    lines.push({ type: "message", id: `e${n}`, parentId: parent, timestamp: iso(t.t + 31e3), message: { role: "toolResult", toolCallId: "tc", content: [{ type: "text", text: "index.ts\napp.ts" }] } });
    parent = `e${n++}`;
    lines.push({ type: "message", id: `e${n}`, parentId: parent, timestamp: iso(t.t + 90e3), message: { role: "assistant", content: [{ type: "text", text: t.reply }] } });
    parent = `e${n++}`;
  }
  lines.push({ type: "session_info", id: `e${n}`, parentId: parent, timestamp: iso(start), name: `pi: ${rnd(PROMPTS, i).slice(0, 30)}` });
  write(path.join(HOME, ".pi/agent/sessions", `--${enc(cwd).replace(/^-/, "")}--`, `${iso(start).replace(/[:.]/g, "-")}_${id}.jsonl`), jsonl(lines));
}

// ---------- Kimi Code (wire.jsonl) + legacy Kimi CLI (context.jsonl) ----------
for (let s = 0; s < 3; s++) {
  const { i, start, cwd } = next();
  const id = uuid(`kimi${i}`);
  const dir = path.join(HOME, ".kimi-code/sessions", `wd_${path.basename(cwd)}_${md5ish(cwd).slice(0, 12)}`, id);
  const ev: unknown[] = [{ type: "metadata", timestamp: iso(start), protocol_version: "1.4", model: "kimi-k2.5" }];
  for (const t of turns(i, start)) {
    ev.push({ type: "context.append_message", timestamp: iso(t.t), message: { role: "user", content: [{ type: "text", text: t.user }] } });
    ev.push({ type: "step.begin", timestamp: iso(t.t + 10e3) });
    ev.push({ type: "tool_call", timestamp: iso(t.t + 20e3), data: { function: { name: "ReadFile", arguments: JSON.stringify({ path: "README.md" }) } } });
    for (const chunk of t.reply.match(/.{1,60}/g) ?? []) ev.push({ type: "content.part", timestamp: iso(t.t + 30e3), part: { type: "text", text: chunk } });
    ev.push({ type: "step.end", timestamp: iso(t.t + 90e3) });
  }
  write(path.join(dir, "agents/main/wire.jsonl"), jsonl(ev));
  write(path.join(dir, "state.json"), JSON.stringify({ title: `Kimi: ${rnd(PROMPTS, i).slice(0, 32)}`, workDir: cwd, createdAt: iso(start), updatedAt: iso(start + 30 * 60e3), lastPrompt: rnd(PROMPTS, i) }));
  fs.appendFileSync(path.join(HOME, ".kimi-code/session_index.jsonl"), JSON.stringify({ sessionId: id, sessionDir: dir, workDir: cwd }) + "\n");
}
{
  const { i, start, cwd } = next();
  const id = uuid(`kimicli${i}`);
  const dir = path.join(HOME, ".kimi/sessions", md5ish(cwd), id);
  const ctx: unknown[] = [{ role: "_system_prompt", content: "You are Kimi." }];
  for (const t of turns(i, start)) {
    ctx.push({ role: "user", content: t.user });
    ctx.push({ role: "assistant", content: [{ type: "text", text: t.reply }], tool_calls: [{ function: { name: "Bash", arguments: "{\"command\":\"ls\"}" } }] });
    ctx.push({ type: "_checkpoint", id: 1 });
  }
  write(path.join(dir, "context.jsonl"), jsonl(ctx));
  write(path.join(dir, "wire.jsonl"), jsonl([{ type: "metadata", timestamp: iso(start), model: "kimi-k2" }, { type: "status_update", timestamp: iso(start + 20 * 60e3), data: { model: "kimi-k2" } }]));
  write(path.join(dir, "state.json"), JSON.stringify({ custom_title: "Kimi CLI legacy session", cwd }));
}

// ---------- DeepSeek Harness (zstd + raw) ----------
for (let s = 0; s < 3; s++) {
  const { i, start, cwd } = next();
  const id = uuid(`dsh${i}`);
  const lines: unknown[] = [{ type: "session", id: `session-${id}`, createdAt: start, cwd }];
  let seq = 1;
  lines.push({ type: "user/message", seq: seq++, time: start, data: { source: { kind: "plugin", plugin: "skills" }, message: { role: "user", content: "<skills>catalogue</skills>" } } });
  for (const t of turns(i, start)) {
    lines.push({ type: "user/message", seq: seq++, time: t.t, data: { source: { kind: "user" }, message: { role: "user", content: t.user } } });
    lines.push({ type: "tool/call", seq: seq++, time: t.t + 10e3, data: { toolName: "bash", args: { command: "make test" } } });
    lines.push({ type: "tool/result", seq: seq++, time: t.t + 11e3, data: { result: [{ type: "tool-result", content: [{ type: "text", text: "ok" }] }] } });
    lines.push({ type: "assistant/chunk", seq: seq++, time: t.t + 20e3, data: { chunk: { type: "text-delta", textDelta: "partial " } } });
    lines.push({ type: "assistant/message", seq: seq++, time: t.t + 60e3, data: { message: { role: "assistant", model: "deepseek-v4", content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: t.reply }] } } });
  }
  lines.push({ type: "session/title", seq: seq++, time: start + 1000, data: { title: `dsh: ${rnd(PROMPTS, i).slice(0, 34)}` } });
  const dir = path.join(HOME, ".dsh/sessions", `--${enc(cwd).replace(/^-/, "")}--`, `session-${id}`);
  const text = jsonl(lines);
  if (s % 2 === 0) {
    // two zstd frames to mimic batched appends
    const mid = Math.floor(lines.length / 2);
    const a = Buffer.from(compress(new TextEncoder().encode(jsonl(lines.slice(0, mid)))));
    const b = Buffer.from(compress(new TextEncoder().encode(jsonl(lines.slice(mid)))));
    write(path.join(dir, "session.jsonl.zstd"), Buffer.concat([a, b]));
  } else {
    write(path.join(dir, "session.jsonl"), text);
  }
}

// ---------- Trae (trae-agent trajectories; IDE db is encrypted upstream so only a marker) ----------
for (let s = 0; s < 2; s++) {
  const { i, start, cwd } = next();
  const steps = turns(i, start).map((t, k) => ({
    step_number: k + 1,
    timestamp: iso(t.t),
    state: "completed",
    llm_response: { content: t.reply, model: "doubao-seed-2.0", tool_calls: [{ call_id: `c${k}`, name: "str_replace_based_edit_tool", arguments: { command: "view", path: "src/main.py" } }] },
    tool_calls: [{ call_id: `c${k}`, name: "str_replace_based_edit_tool", arguments: { command: "view", path: "src/main.py" } }],
    tool_results: [{ call_id: `c${k}`, success: true, result: "print('hi')" }],
  }));
  const traj = { task: rnd(PROMPTS, i), start_time: iso(start), end_time: iso(start + 12 * 60e3), provider: "doubao", model: "doubao-seed-2.0", max_steps: 20, llm_interactions: [], agent_steps: steps, success: true, final_result: "Task completed: " + rnd(REPLIES, i).slice(0, 60), execution_time: 720 };
  const stamp = iso(start).replace(/[-:T]/g, "").slice(0, 15).replace(/^(\d{8})(\d{6}).*/, "$1_$2");
  write(path.join(HOME, ".trae-agent/trajectories", path.basename(cwd), "trajectories", `trajectory_${stamp}.json`), JSON.stringify(traj, null, 2));
}
ensure(path.join(HOME, ".config/Trae/ModularData/ai-agent"));
fs.writeFileSync(path.join(HOME, ".config/Trae/ModularData/ai-agent/database.db"), "SQLite format 3\0encrypted-placeholder");
// Trae IDE per-workspace state.vscdb with icube mementos (chat + Agent/SOLO plan items).
for (let s = 0; s < 2; s++) {
  const { i, start, cwd } = next();
  const wsDir = ensure(path.join(HOME, ".config/Trae/User/workspaceStorage", md5ish("trae" + cwd)));
  write(path.join(wsDir, "workspace.json"), JSON.stringify({ folder: "file://" + cwd }));
  const messages: unknown[] = [];
  for (const [k, t] of turns(i, start).entries()) {
    messages.push({ role: "user", content: t.user, createdAt: t.t });
    if (k === 0) {
      messages.push({
        role: "ai",
        content: { data: { summary: t.reply } },
        createdAt: t.t + 45e3,
        agentTaskContent: { guideline: { planItems: [{ thought: "Inspect the failing module first.", toolName: "ReadFile", toolParams: { path: "src/main.py" }, result: "print('hi')" }, { thought: "Apply the fix.", toolName: "EditFile", toolParams: { path: "src/main.py" } }] } },
      });
    } else {
      messages.push({ role: "ai", content: t.reply, createdAt: t.t + 45e3 });
    }
  }
  const session = { id: uuid(`trae-ide${i}`), title: rnd(PROMPTS, i).slice(0, 48), createdAt: start, updatedAt: start + 40 * 60e3, messages };
  const db = openSqlite(path.join(wsDir, "state.vscdb"));
  db.exec("create table ItemTable (key text unique on conflict replace, value blob)");
  db.run("insert into ItemTable (key, value) values (?, ?)", s === 0 ? "memento/icube-ai-agent-storage" : "memento/icube-ai-ng-chat-storage-1042", JSON.stringify({ list: [session] }));
  db.run("insert into ItemTable (key, value) values (?, ?)", "workbench.panel.pinnedPanels", "[]");
  db.close();
}

// ---------- WorkBuddy / CodeBuddy Code (flat OpenAI items) ----------
for (let s = 0; s < 3; s++) {
  const { i, start, cwd } = next();
  const id = uuid(`workbuddy${i}`);
  const lines: unknown[] = [];
  for (const t of turns(i, start)) {
    lines.push({ type: "message", role: "user", timestamp: t.t, cwd, sessionId: id, id: uuid(`wbu${i}${t.t}`), content: [{ type: "input_text", text: t.user }] });
    lines.push({ type: "reasoning", timestamp: t.t + 5e3, cwd, sessionId: id, summaryContent: [{ type: "reasoning_text", text: "thinking" }], providerData: { requestModelName: "MaaS_Cl_Opus_4.7" } });
    lines.push({ type: "function_call", timestamp: t.t + 10e3, cwd, sessionId: id, callId: "fc1", name: "Bash", arguments: JSON.stringify({ command: "git status" }) });
    lines.push({ type: "function_call_result", timestamp: t.t + 11e3, cwd, sessionId: id, callId: "fc1", output: { type: "text", text: "On branch main" } });
    lines.push({ type: "message", role: "assistant", timestamp: t.t + 60e3, cwd, sessionId: id, id: uuid(`wba${i}${t.t}`), content: [{ type: "output_text", text: t.reply }], providerData: { model: "MaaS_Cl_Opus_4.7", rawUsage: { prompt_tokens: 100, completion_tokens: 50 } } });
  }
  lines.splice(1, 0, { type: "ai-title", timestamp: start + 2000, aiTitle: `WorkBuddy: ${rnd(PROMPTS, i).slice(0, 30)}`, cwd, sessionId: id });
  write(path.join(HOME, ".codebuddy/projects", enc(cwd), `${id}.jsonl`), jsonl(lines));
}

// ---------- ZCode legacy JSONL (Claude-shaped) ----------
{
  const { i, start, cwd } = next();
  const id = uuid(`zcode-legacy${i}`);
  const lines = turns(i, start).flatMap((t) => [
    { type: "user", sessionId: id, cwd, timestamp: iso(t.t), message: { role: "user", content: t.user } },
    { type: "assistant", sessionId: id, cwd, timestamp: iso(t.t + 60e3), message: { role: "assistant", model: "glm-5.2", content: [{ type: "text", text: t.reply }] }, usage: { input_tokens: 10, output_tokens: 20 } },
  ]);
  write(path.join(HOME, ".zcode/projects", enc(cwd), `${id}.jsonl`), jsonl(lines));
}

// ---------- Web chat exports (ChatGPT + Claude.ai) ----------
{
  const convs: unknown[] = [];
  for (let s = 0; s < 3; s++) {
    const { i, start } = next();
    const mapping: Record<string, unknown> = {};
    let parent: string | null = null;
    const root = uuid(`root${i}`);
    mapping[root] = { id: root, parent: null, children: [], message: { id: root, author: { role: "system" }, content: { content_type: "text", parts: [""] } } };
    parent = root;
    let current = root;
    for (const t of turns(i, start)) {
      const u = uuid(`gu${i}${t.t}`);
      const a = uuid(`ga${i}${t.t}`);
      (mapping[parent] as { children: string[] }).children.push(u);
      mapping[u] = { id: u, parent, children: [a], message: { id: u, author: { role: "user" }, create_time: t.t / 1000, content: { content_type: "text", parts: [t.user] } } };
      mapping[a] = { id: a, parent: u, children: [], message: { id: a, author: { role: "assistant" }, create_time: (t.t + 30e3) / 1000, content: { content_type: "text", parts: [t.reply] }, metadata: { model_slug: "gpt-5.6" } } };
      parent = a;
      current = a;
    }
    convs.push({ title: `ChatGPT: ${rnd(PROMPTS, i).slice(0, 34)}`, create_time: start / 1000, update_time: (start + 20 * 60e3) / 1000, mapping, current_node: current, conversation_id: uuid(`gconv${i}`), default_model_slug: "gpt-5.6" });
  }
  write(path.join(HOME, "Downloads/chatgpt-export/conversations.json"), JSON.stringify(convs));
  const claude: unknown[] = [];
  for (let s = 0; s < 2; s++) {
    const { i, start } = next();
    claude.push({
      uuid: uuid(`cconv${i}`),
      name: `Claude.ai: ${rnd(PROMPTS, i).slice(0, 34)}`,
      created_at: iso(start),
      updated_at: iso(start + 15 * 60e3),
      model: "claude-opus-5",
      chat_messages: turns(i, start).flatMap((t) => [
        { uuid: uuid(`cu${t.t}`), sender: "human", text: t.user, created_at: iso(t.t), content: [{ type: "text", text: t.user }] },
        { uuid: uuid(`ca${t.t}`), sender: "assistant", text: t.reply, created_at: iso(t.t + 40e3), content: [{ type: "text", text: t.reply }] },
      ]),
    });
  }
  write(path.join(HOME, "Downloads/claude-export/conversations.json"), JSON.stringify(claude));
}

// ---------- Per-tool fixture modules (scripts/fixtures/*.ts) ----------
const demo: Demo = { HOME, now, H, D, PROJECTS, PROMPTS, REPLIES, TOOLS, rnd, ensure, write, jsonl, iso, uuid, md5ish, turns, next, compress, openSqlite };
for (const fixture of FIXTURES) fixture(demo);

console.log(`demo home written to ${HOME} (${counter} sessions across all formats)`);
console.log(`\nTry:\n  AGENTBOARD_FAKE_HOME=${HOME} npm run cli -- scan\n  AGENTBOARD_FAKE_HOME=${HOME} npm run cli -- import chatgpt ${path.join(HOME, "Downloads/chatgpt-export/conversations.json")}\n  AGENTBOARD_FAKE_HOME=${HOME} npm run dev`);
