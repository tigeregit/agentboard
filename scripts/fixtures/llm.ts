import path from "node:path";
import type { Fixture } from "../demo-lib";

/** llm CLI: logs.db with conversations + responses (UTC datetimes without a zone designator). */
export const llm: Fixture = (d) => {
  const dir = d.ensure(path.join(d.HOME, ".config/io.datasette.llm"));
  const db = d.openSqlite(path.join(dir, "logs.db"));
  db.exec("create table conversations (id text primary key, name text, model text)");
  db.exec(`create table responses (
    id text primary key, model text, prompt text, system text, prompt_json text, options_json text,
    response text, response_json text, conversation_id text references conversations(id),
    duration_ms integer, datetime_utc text, input_tokens integer, output_tokens integer, token_details text, schema_id text
  )`);
  db.exec("create table attachments (id text primary key, type text, path text, url text, content blob)");
  db.exec("create table prompt_attachments (response_id text, attachment_id text, \"order\" integer)");
  db.exec("create table tools (id integer primary key, hash text, name text, description text, input_schema text)");
  db.exec("create table tool_calls (id integer primary key, response_id text, tool_id integer, name text, arguments text, tool_call_id text)");
  db.exec("create table tool_results (id integer primary key, response_id text, tool_id integer, name text, output text, tool_call_id text)");
  const utc = (t: number) => d.iso(t).replace("Z", "");
  const ulid = (seed: string) => d.uuid(seed).replace(/-/g, "").slice(0, 26).toUpperCase();
  const insertResponse = (id: string, model: string, prompt: string, response: string, conv: string | null, t: number, inTok: number | null, outTok: number | null, system: string | null = null) =>
    db.run("insert into responses (id, model, prompt, system, prompt_json, options_json, response, response_json, conversation_id, duration_ms, datetime_utc, input_tokens, output_tokens, token_details) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, model, prompt, system, null, "{}", response, JSON.stringify({ content: response }), conv, 1800, utc(t), inTok, outTok, null);
  for (let s = 0; s < 2; s++) {
    const { i, start } = d.next();
    const conv = ulid(`llmconv${i}`);
    const model = s ? "gpt-4o-mini" : "claude-3.5-sonnet";
    db.run("insert into conversations (id, name, model) values (?, ?, ?)", conv, `llm: ${d.rnd(d.PROMPTS, i).slice(0, 40)}`, model);
    for (const [k, t] of d.turns(i, start).entries()) insertResponse(ulid(`llmr${i}${k}`), model, t.user, t.reply, conv, t.t, 120 + k, 80 + k, k === 0 ? "You are a concise assistant." : null);
  }
  const { i, start } = d.next();
  insertResponse(ulid(`llmo${i}a`), "gpt-4o", "Translate 'good morning' to Dutch", "Goedemorgen.", null, start, null, null);
  insertResponse(ulid(`llmo${i}b`), "gpt-4o", "One-line regex for an IPv4 address", "^(\\d{1,3}\\.){3}\\d{1,3}$", null, start + 2 * d.H, 14, 22);
  db.close();
};
