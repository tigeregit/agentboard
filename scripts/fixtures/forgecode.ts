import path from "node:path";
import type { Fixture } from "../demo-lib";

/** ForgeCode: ~/.forge/.forge.db conversations with `context` JSON in the Text/Tool/message.* serializations. */
export const forgecode: Fixture = (d) => {
  const base = d.ensure(path.join(d.HOME, ".forge"));
  d.write(path.join(base, ".forge_history"), "Add a retry with exponential backoff\nWhy does the nightly job fail?\n");
  d.ensure(path.join(base, "logs"));
  const db = d.openSqlite(path.join(base, ".forge.db"));
  db.exec(`create table conversations (
    id text primary key, workspace_id text not null, title text, context text, metrics text,
    created_at text not null, updated_at text not null, archived_at text
  )`);
  db.exec("create table workspaces (id text primary key, path text, created_at text)");
  db.exec("create index conversations_workspace on conversations (workspace_id)");
  const insert = (id: string, ws: string, title: string | null, context: unknown, metrics: unknown, created: number, updated: number) =>
    db.run("insert into conversations (id, workspace_id, title, context, metrics, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)", id, ws, title, typeof context === "string" || context === null ? context : JSON.stringify(context), metrics === null ? null : JSON.stringify(metrics), d.iso(created), d.iso(updated));

  for (let s = 0; s < 3; s++) {
    const { i, start, cwd } = d.next();
    const workspace = s === 1 ? d.md5ish("forge" + d.PROJECTS[0]) : d.md5ish("forge" + cwd);
    const wsCwd = s === 1 ? d.PROJECTS[0] : cwd;
    db.run("insert or ignore into workspaces (id, path, created_at) values (?, ?, ?)", workspace, wsCwd, d.iso(start));
    const messages: unknown[] = [];
    const turns = d.turns(i, start);
    for (const [k, t] of turns.entries()) {
      const callId = `forge_call_${d.uuid(`fc${i}${k}`).slice(0, 8)}`;
      if (k % 2 === 0) {
        // current serialization: { message: { text | tool: ... }, timestamp }
        messages.push({ message: { text: { role: "User", content: t.user } }, timestamp: d.iso(t.t) });
        messages.push({
          message: { text: { role: "Assistant", content: "Let me read the file first.", tool_calls: [{ name: "fs_read", call_id: callId, arguments: { path: `${wsCwd}/src/index.ts`, cwd: wsCwd } }], model: "anthropic/claude-sonnet-4" } },
          timestamp: d.iso(t.t + 10e3),
          usage: { prompt_tokens: { actual: 1200 }, completion_tokens: { actual: 90 }, cached_tokens: { actual: 300 }, cost: 0.0125 },
        });
        messages.push({ message: { tool: { name: "fs_read", call_id: callId, output: { values: [{ type: "text", text: "export const x = 1;" }], is_error: false } } }, timestamp: d.iso(t.t + 12e3) });
        messages.push({ message: { text: { role: "Assistant", content: t.reply, model: "anthropic/claude-sonnet-4" } }, timestamp: d.iso(t.t + 60e3), usage: { prompt_tokens: { actual: 1400 }, completion_tokens: { actual: 220 }, cost: 0.021 } });
      } else {
        // legacy externally tagged serialization: { Text | Tool: ... }
        messages.push({ Text: { role: "user", content: t.user, timestamp: d.iso(t.t) } });
        messages.push({ Text: { role: "assistant", content: [{ type: "text", text: "Applying the change." }, { type: "tool_use", id: callId, name: "patch", input: { path: `${wsCwd}/src/index.ts`, cwd: wsCwd } }], model: "anthropic/claude-sonnet-4", timestamp: d.iso(t.t + 10e3) } });
        messages.push({ Tool: { name: "patch", call_id: callId, output: { content: "patched 1 file", is_error: false }, timestamp: d.iso(t.t + 12e3) } });
        messages.push({ Text: { role: "assistant", content: t.reply, model: "anthropic/claude-sonnet-4", timestamp: d.iso(t.t + 60e3) } });
      }
    }
    const last = turns[turns.length - 1].t + 60e3;
    const context = { conversation_id: d.uuid(`forge${i}`), cwd: wsCwd, messages, tool_definitions: [], variables: {} };
    const metrics = { session_start_time: d.iso(start), file_operations: 2, files_accessed: [`${wsCwd}/src/index.ts`] };
    insert(d.uuid(`forge${i}`), workspace, s === 2 ? null : `Forge: ${d.rnd(d.PROMPTS, i).slice(0, 40)}`, context, metrics, start, last);
  }
  // Rows Forge leaves behind that must be skipped without warnings.
  const ws0 = d.md5ish("forge" + d.PROJECTS[0]);
  insert(d.uuid("forge-null"), ws0, "Empty conversation", null, null, d.now - 3 * d.D, d.now - 3 * d.D);
  insert(d.uuid("forge-bad"), ws0, "Malformed context", "{not-json", null, d.now - 2 * d.D, d.now - 2 * d.D);
  db.close();
};
