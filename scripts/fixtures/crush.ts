import path from "node:path";
import type { Fixture } from "../demo-lib";

/** Crush: per-project <project>/.crush/crush.db under ~/code/<project>. */
export const crush: Fixture = (d) => {
  const dbs = new Map<string, ReturnType<typeof d.openSqlite>>();
  const open = (project: string) => {
    let db = dbs.get(project);
    if (db) return db;
    const dir = d.ensure(path.join(project, ".crush"));
    d.write(path.join(dir, "crush.json"), JSON.stringify({ $schema: "https://charm.land/crush.json", options: { data_directory: ".crush" } }));
    db = d.openSqlite(path.join(dir, "crush.db"));
    db.exec(`create table sessions (
      id text primary key, parent_session_id text, title text not null, message_count integer not null default 0,
      prompt_tokens integer not null default 0, completion_tokens integer not null default 0, cost real not null default 0.0,
      updated_at integer not null, created_at integer not null, summary_message_id text
    )`);
    db.exec(`create table messages (
      id text primary key, session_id text not null, role text not null, parts text not null default '[]',
      model text, created_at integer not null, updated_at integer not null, finished_at integer, provider text,
      foreign key (session_id) references sessions (id) on delete cascade
    )`);
    db.exec("create table files (id text primary key, session_id text not null, path text not null, content text not null, version integer not null default 0, created_at integer not null, updated_at integer not null)");
    dbs.set(project, db);
    return db;
  };
  const secs = (t: number) => Math.floor(t / 1000);
  for (let s = 0; s < 3; s++) {
    const { i, start, cwd } = d.next();
    const project = path.join(d.HOME, "code", path.basename(cwd));
    const db = open(project);
    const sid = d.uuid(`crush${i}`);
    const turns = d.turns(i, start);
    db.run("insert into sessions (id, parent_session_id, title, message_count, prompt_tokens, completion_tokens, cost, updated_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)", sid, null, `Crush: ${d.rnd(d.PROMPTS, i).slice(0, 40)}`, 0, 5400 + i, 610, 0.0421, secs(start), secs(start));
    let n = 0;
    const insertMsg = (id: string, role: string, parts: unknown[], t: number, model?: string) => {
      db.run("insert into messages (id, session_id, role, parts, model, created_at, updated_at, finished_at, provider) values (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, sid, role, JSON.stringify(parts), model ?? null, secs(t), secs(t), role === "assistant" ? secs(t + 5e3) : null, model ? "anthropic" : null);
      n++;
    };
    for (const [k, t] of turns.entries()) {
      insertMsg(d.uuid(`cu${i}${k}`), "user", [{ type: "text", data: { text: t.user } }], t.t);
      if (k === 0) {
        const callId = `toolu_${d.uuid(`cc${i}${k}`).slice(0, 12)}`;
        insertMsg(d.uuid(`ca${i}${k}`), "assistant", [{ type: "reasoning", data: { thinking: "I should look at the file before editing.", signature: "" } }, { type: "text", data: { text: "Let me view the file." } }, { type: "tool_call", data: { id: callId, name: "view", input: JSON.stringify({ file_path: `${project}/src/index.ts` }), finished: true } }, { type: "finish", data: { reason: "tool_use", time: secs(t.t + 6e3) } }], t.t + 5e3, "claude-sonnet-4");
        insertMsg(d.uuid(`cr${i}${k}`), "tool", [{ type: "tool_result", data: { tool_call_id: callId, name: "view", content: "1| export const x = 1;", is_error: false } }], t.t + 7e3);
      }
      insertMsg(d.uuid(`cb${i}${k}`), "assistant", [{ type: "text", data: { text: t.reply } }, { type: "finish", data: { reason: "end_turn", time: secs(t.t + 60e3) } }], t.t + 60e3, "claude-sonnet-4");
    }
    const last = turns[turns.length - 1].t + 60e3;
    db.run("update sessions set updated_at = ?, message_count = ? where id = ?", secs(last), n, sid);
  }
  for (const db of dbs.values()) db.close();
};
