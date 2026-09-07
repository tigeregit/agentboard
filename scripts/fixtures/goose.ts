import path from "node:path";
import type { Fixture } from "../demo-lib";

function stamp(t: number): string {
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}

/** Goose: single sessions.db (sessions + messages with content_json arrays) under ~/.local/share/goose/sessions. */
export const goose: Fixture = (d) => {
  const dir = d.ensure(path.join(d.HOME, ".local/share/goose/sessions"));
  const db = d.openSqlite(path.join(dir, "sessions.db"));
  db.exec(`create table sessions (
    id text primary key, name text, description text, working_dir text not null,
    created_at timestamp default current_timestamp, updated_at timestamp default current_timestamp,
    schedule_id text, total_tokens integer, input_tokens integer, output_tokens integer,
    accumulated_total_tokens integer, accumulated_input_tokens integer, accumulated_output_tokens integer,
    message_count integer default 0, extension_data text default '{}', provider_name text
  )`);
  db.exec(`create table messages (
    id integer primary key autoincrement, message_id text, session_id text not null, role text not null,
    content_json text not null, created_timestamp integer not null, metadata_json text,
    foreign key (session_id) references sessions(id)
  )`);
  db.exec("create table sqlx_migrations (version bigint primary key, description text)");
  const insertMsg = (sid: string, mid: string, role: string, content: unknown, t: number) => db.run("insert into messages (message_id, session_id, role, content_json, created_timestamp, metadata_json) values (?, ?, ?, ?, ?, ?)", mid, sid, role, JSON.stringify(content), Math.floor(t / 1000), '{"userVisible":true,"agentVisible":true}');
  for (let s = 0; s < 3; s++) {
    const { i, start, cwd } = d.next();
    const sid = new Date(start).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
    const turns = d.turns(i, start);
    db.run("insert into sessions (id, name, description, working_dir, created_at, updated_at, total_tokens, input_tokens, output_tokens, message_count, provider_name) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", sid, s === 1 ? null : `goose-${d.uuid(`goose-name-${s}`).slice(0, 8)}`, s === 2 ? null : `Goose: ${d.rnd(d.PROMPTS, i).slice(0, 40)}`, cwd, stamp(start), stamp(start), 4200 + i, 3900, 300, 0, "anthropic");
    let n = 0;
    for (const [k, t] of turns.entries()) {
      insertMsg(sid, d.uuid(`gu${i}${k}`), "user", [{ type: "text", text: t.user }], t.t);
      n++;
      if (k === 0) {
        const callId = `call_${d.uuid(`gc${i}${k}`).slice(0, 12)}`;
        insertMsg(sid, d.uuid(`ga${i}${k}`), "assistant", [{ type: "thinking", thinking: "The user wants me to look at the code first.", signature: "sig" }, { type: "text", text: "Let me check the relevant file." }, { type: "toolRequest", id: callId, toolCall: { status: "success", value: { name: "developer__shell", arguments: { command: `cat ${cwd}/src/index.ts` } } } }], t.t + 20e3);
        insertMsg(sid, d.uuid(`gr${i}${k}`), "user", [{ type: "toolResponse", id: callId, toolResult: { status: "success", value: { content: [{ type: "text", text: "export const x = 1;" }] } } }], t.t + 25e3);
        n += 2;
      }
      insertMsg(sid, d.uuid(`gb${i}${k}`), "assistant", [{ type: "text", text: t.reply }], t.t + 60e3);
      n++;
    }
    const last = turns[turns.length - 1].t + 60e3;
    db.run("update sessions set updated_at = ?, message_count = ? where id = ?", stamp(last), n, sid);
  }
  db.close();
};
