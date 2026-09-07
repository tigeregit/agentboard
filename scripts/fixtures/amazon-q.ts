import path from "node:path";
import type { Fixture } from "../demo-lib";

/** Amazon Q CLI: one ConversationState per cwd in ~/.local/share/amazon-q/data.sqlite3. */
export const amazonQ: Fixture = (d) => {
  const dir = d.ensure(path.join(d.HOME, ".local/share/amazon-q"));
  const db = d.openSqlite(path.join(dir, "data.sqlite3"));
  db.exec("create table conversations (key text primary key, value text)");
  db.exec("create table auth_kv (key text primary key, value text)");
  const used = new Set<string>();
  for (let s = 0; s < 2; s++) {
    const { i, start, cwd } = d.next();
    const key = used.has(cwd) ? path.join(cwd, "services", "api") : cwd;
    used.add(key);
    const history: unknown[] = [];
    for (const [k, t] of d.turns(i, start).entries()) {
      const toolId = `tooluse_${d.uuid(`q${i}${k}`).slice(0, 8)}`;
      history.push({
        user: { additional_context: "", env_context: { env_state: { operating_system: "macos", current_working_directory: key } }, content: { Prompt: { prompt: t.user } }, timestamp: d.iso(t.t) },
        assistant: { ToolUse: { message_id: d.uuid(`qa${i}${k}`), content: "Let me look at that.", tool_uses: [{ id: toolId, name: k % 2 ? "execute_bash" : "fs_read", args: k % 2 ? { command: "git status --short" } : { path: `${key}/src/index.ts`, mode: "Line" } }] } },
      });
      history.push({
        user: { additional_context: "", content: { ToolUseResults: { tool_use_results: [{ tool_use_id: toolId, content: [{ Text: k % 2 ? " M src/index.ts" : "export const x = 1;" }], status: "Success" }] } }, timestamp: d.iso(t.t + 30e3) },
        assistant: { Response: { message_id: d.uuid(`qb${i}${k}`), content: t.reply } },
      });
    }
    const state = { conversation_id: d.uuid(`amazonq${i}`), next_message: null, history, valid_history_range: [0, history.length], transcript: [], tools: {}, context_manager: { max_context_files_size: 150000 }, context_message_length: 0, latest_summary: null, model: "claude-sonnet-4" };
    db.run("insert into conversations (key, value) values (?, ?)", key, JSON.stringify(state));
  }
  db.run("insert into conversations (key, value) values (?, ?)", path.join(d.HOME, "scratch"), JSON.stringify({ conversation_id: d.uuid("amazonq-empty"), history: [] }));
  db.close();
};
