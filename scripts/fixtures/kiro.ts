import path from "node:path";
import type { Fixture } from "../demo-lib";

/** Kiro CLI: conversations_v2 rows (many per cwd) in ~/.local/share/kiro-cli/data.sqlite3. */
export const kiro: Fixture = (d) => {
  const dir = d.ensure(path.join(d.HOME, ".local/share/kiro-cli"));
  const db = d.openSqlite(path.join(dir, "data.sqlite3"));
  db.exec("create table conversations_v2 (key text not null, conversation_id text primary key, value text not null, created_at integer not null, updated_at integer not null)");
  db.exec("create table state (key text primary key, value text)");
  db.exec("create index conversations_v2_key on conversations_v2 (key)");
  for (let s = 0; s < 3; s++) {
    const { i, start, cwd } = d.next();
    const key = s === 2 ? d.PROJECTS[0] : cwd;
    const convId = d.uuid(`kiro${i}`);
    const history: unknown[] = [];
    for (const [k, t] of d.turns(i, start).entries()) {
      const toolId = `tooluse_${d.uuid(`k${i}${k}`).slice(0, 8)}`;
      if (k === 0) {
        history.push({
          user: { content: { Prompt: { prompt: t.user } }, timestamp: d.iso(t.t), images: null },
          assistant: { ToolUse: { message_id: d.uuid(`ka${i}${k}`), content: "I'll inspect the repository first.", tool_uses: [{ id: toolId, name: "execute_bash", args: { command: "ls -la src" }, orig_name: "execute_bash", orig_args: { command: "ls -la src" } }] } },
          request_metadata: { request_id: d.uuid(`kr${i}${k}`), model_id: "claude-sonnet-4.5" },
        });
        history.push({
          user: { content: { ToolUseResults: { tool_use_results: [{ tool_use_id: toolId, content: [{ Text: "index.ts\nutils.ts" }], status: "Success" }] } }, timestamp: d.iso(t.t + 20e3) },
          assistant: { Response: { message_id: d.uuid(`kb${i}${k}`), content: t.reply } },
        });
      } else if (k === 1) {
        history.push({
          user: { content: { Prompt: { prompt: t.user } }, timestamp: d.iso(t.t) },
          assistant: { ToolUse: { message_id: d.uuid(`ka${i}${k}`), content: "", tool_uses: [{ id: toolId, name: "fs_write", args: { command: "create", path: `${key}/src/new.ts`, file_text: "export {}" } }] } },
        });
        history.push({
          user: { content: { CancelledToolUses: { prompt: "actually stop", tool_use_results: [{ tool_use_id: toolId, content: [{ Text: "Tool use was cancelled by the user" }], status: "Error" }] } }, timestamp: d.iso(t.t + 15e3) },
          assistant: { Response: { message_id: d.uuid(`kb${i}${k}`), content: "Understood, I've stopped." } },
        });
      } else {
        history.push({
          user: { content: { Prompt: { prompt: t.user } }, timestamp: d.iso(t.t) },
          assistant: { Response: { message_id: d.uuid(`kb${i}${k}`), content: t.reply } },
        });
      }
    }
    const state = { conversation_id: convId, next_message: null, history, valid_history_range: [0, history.length], transcript: [], tools: {}, context_manager: null, context_message_length: null, latest_summary: null, model: "claude-sonnet-4.5", model_info: { model_id: "claude-sonnet-4.5", model_name: "claude-sonnet-4.5", context_window_tokens: 200000 } };
    db.run("insert into conversations_v2 (key, conversation_id, value, created_at, updated_at) values (?, ?, ?, ?, ?)", key, convId, JSON.stringify(state), start, start + 25 * 60e3);
  }
  db.close();
};
