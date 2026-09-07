import path from "node:path";
import type { Demo, Fixture } from "../demo-lib";

/** Zed Agent Panel `threads/threads.db`: DbThread JSON rows (plain + zstd) and one legacy SerializedThread row. */
function dbThread(d: Demo, i: number, start: number, cwd: string, title: string) {
  const messages: unknown[] = [];
  for (const [k, t] of d.turns(i, start).entries()) {
    const content: unknown[] = [{ Text: t.user }];
    if (k === 0) content.push({ Mention: { uri: `file://${cwd}/src/storage/s3.ts`, content: "export async function upload() {}" } });
    messages.push({ User: { id: k * 2, content } });
    const toolId = `toolu_${d.md5ish(`${title}${k}`).slice(0, 10)}`;
    messages.push({
      Agent: {
        content: [
          { Thinking: { text: "Need to look at the uploader before changing anything.", signature: null } },
          { Text: "Let me read the uploader first." },
          { ToolUse: { id: toolId, name: k % 2 ? "grep" : "read_file", raw_input: JSON.stringify({ path: "src/storage/s3.ts" }), input: { path: "src/storage/s3.ts" }, is_input_complete: true } },
        ],
        tool_results: { [toolId]: { tool_use_id: toolId, tool_name: k % 2 ? "grep" : "read_file", is_error: false, content: [{ Text: "src/storage/s3.ts:12:  await client.putObject(params)" }], output: null } },
      },
    });
    messages.push({ Agent: { content: [{ Text: t.reply }], tool_results: {} } });
  }
  messages.push("Resume");
  return {
    title,
    messages,
    updated_at: d.iso(start + 30 * 60e3),
    detailed_summary: null,
    initial_project_snapshot: { worktree_snapshots: [{ worktree_path: cwd, git_state: { remote_url: "git@github.com:example/agentboard.git", head_sha: "0123abcd", current_branch: "main", diff: null } }], unsaved_buffer_paths: [], timestamp: d.iso(start) },
    cumulative_token_usage: { input_tokens: 5200, output_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    request_token_usage: {},
    model: { provider: "anthropic", model: "claude-sonnet-4-5" },
    completion_mode: "normal",
    profile: "write",
  };
}

export const zed: Fixture = (d) => {
  const dataDir = path.join(process.env.XDG_DATA_HOME || path.join(d.HOME, ".local", "share"), "zed");
  const db = d.openSqlite(path.join(d.ensure(path.join(dataDir, "threads")), "threads.db"));
  db.exec("create table if not exists threads (id text primary key, summary text not null, updated_at text not null, data_type text not null, data blob not null, folder_paths text, created_at text)");
  const insert = (id: string, summary: string, start: number, cwd: string, dataType: "json" | "zstd", data: Buffer) =>
    db.run("insert into threads (id, summary, updated_at, data_type, data, folder_paths, created_at) values (?,?,?,?,?,?,?)", id, summary, d.iso(start + 30 * 60e3), dataType, data, JSON.stringify([cwd]), d.iso(start));
  for (let s = 0; s < 2; s++) {
    const { i, start, cwd } = d.next();
    const title = `Zed: ${d.rnd(d.PROMPTS, i).slice(0, 40)}`;
    const json = Buffer.from(JSON.stringify(dbThread(d, i, start, cwd, title)));
    if (s === 0) insert(d.uuid(`zed${i}`), title, start, cwd, "json", json);
    else insert(d.uuid(`zed${i}`), title, start, cwd, "zstd", Buffer.from(d.compress(new Uint8Array(json))));
  }
  {
    const { i, start, cwd } = d.next();
    const title = `Zed (legacy): ${d.rnd(d.PROMPTS, i).slice(0, 32)}`;
    const messages = d.turns(i, start).flatMap((t, k) => [
      { id: k * 2, role: "user", segments: [{ type: "text", text: t.user }], tool_uses: [], tool_results: [], context: "" },
      { id: k * 2 + 1, role: "assistant", segments: [{ type: "thinking", text: "hmm", signature: "s" }, { type: "text", text: t.reply }], tool_uses: [], tool_results: [], context: "" },
    ]);
    insert(d.uuid(`zed-legacy${i}`), title, start, cwd, "json", Buffer.from(JSON.stringify({ version: "0.2.0", summary: title, updated_at: d.iso(start + 10 * 60e3), messages })));
  }
  db.close();
};
