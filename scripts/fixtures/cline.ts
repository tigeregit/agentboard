import path from "node:path";
import type { Demo, Fixture } from "../demo-lib";

/**
 * Cline family: per-task `ui_messages.json` under the host editor's
 * globalStorage plus the three task-index layouts (Cline state/taskHistory.json,
 * Roo Code tasks/_index.json, Kilo Code globalState row in state.vscdb).
 */
function uiMessages(d: Demo, i: number, start: number, cwd: string): unknown[] {
  const msgs: unknown[] = [];
  const plan = d.turns(i, start);
  for (const [k, t] of plan.entries()) {
    if (k === 0) msgs.push({ ts: t.t, type: "say", say: "text", text: t.user, images: [], files: [] });
    else msgs.push({ ts: t.t, type: "say", say: "user_feedback", text: t.user, images: [] });
    msgs.push({ ts: t.t + 1e3, type: "say", say: "api_req_started", text: JSON.stringify({ request: `<task>\n${t.user}\n</task>`, tokensIn: 1200 + k, tokensOut: 340, cacheWrites: 0, cacheReads: 0, cost: 0.0123 }) });
    msgs.push({ ts: t.t + 2e3, type: "say", say: "reasoning", text: "The user wants a change in the uploader; I should read the current implementation first." });
    msgs.push({ ts: t.t + 3e3, type: "say", say: "text", text: "I'll start by reading the current implementation." });
    msgs.push({ ts: t.t + 4e3, type: "say", say: "tool", text: JSON.stringify({ tool: "readFile", path: "src/storage/s3.ts", content: `${cwd}/src/storage/s3.ts`, operationIsLocatedInWorkspace: true }) });
    msgs.push({ ts: t.t + 5e3, type: "say", say: "checkpoint_created" });
    if (k === 0) {
      msgs.push({ ts: t.t + 6e3, type: "say", say: "tool", text: JSON.stringify({ tool: "searchFiles", path: "src", regex: "putObject", filePattern: "*.ts", content: "src/storage/s3.ts\n│----\n│  await client.putObject(params)\n│----" }) });
      msgs.push({ ts: t.t + 7e3, type: "ask", ask: "tool", text: JSON.stringify({ tool: "editedExistingFile", path: "src/storage/s3.ts", diff: "-  await client.putObject(params);\n+  await withBackoff(() => client.putObject(params));" }) });
    }
    msgs.push({ ts: t.t + 8e3, type: "ask", ask: "command", text: "npm test" });
    msgs.push({ ts: t.t + 9e3, type: "say", say: "command_output", text: "\n> agentboard@0.1.0 test\n\n  42 passing (1.2s)\n" });
    if (k === 1) msgs.push({ ts: t.t + 10e3, type: "ask", ask: "followup", text: JSON.stringify({ question: "Should the retry count be configurable?", options: ["Yes, via env var", "No, hardcode 5"], selected: "Yes, via env var" }) });
    msgs.push({ ts: t.t + 11e3, type: "say", say: "api_req_started", text: JSON.stringify({ request: "...", tokensIn: 800, tokensOut: 200, cost: 0.004 }) });
    msgs.push({ ts: t.t + 12e3, type: "say", say: "completion_result", text: t.reply });
    msgs.push({ ts: t.t + 12e3, type: "ask", ask: "completion_result", text: "" });
  }
  return msgs;
}

function apiHistory(d: Demo, i: number, start: number): unknown[] {
  return d.turns(i, start).flatMap((t) => [
    { role: "user", content: [{ type: "text", text: `<task>\n${t.user}\n</task>` }] },
    { role: "assistant", content: [{ type: "text", text: t.reply }] },
  ]);
}

function writeTask(d: Demo, base: string, id: string, i: number, start: number, cwd: string) {
  const dir = path.join(base, "tasks", id);
  d.write(path.join(dir, "ui_messages.json"), JSON.stringify(uiMessages(d, i, start, cwd)));
  d.write(path.join(dir, "api_conversation_history.json"), JSON.stringify(apiHistory(d, i, start)));
  d.write(path.join(dir, "task_metadata.json"), JSON.stringify({ files_in_context: [{ path: "src/storage/s3.ts", record_state: "active", record_source: "read_tool" }], model_usage: [] }));
}

export const cline: Fixture = (d) => {
  // Cline in VS Code: state/taskHistory.json index.
  {
    const base = path.join(d.HOME, ".config/Code/User/globalStorage/saoudrizwan.claude-dev");
    const history: unknown[] = [];
    for (let s = 0; s < 2; s++) {
      const { i, start, cwd } = d.next();
      const id = String(start);
      writeTask(d, base, id, i, start, cwd);
      history.push({ id, ts: start, task: `Cline: ${d.rnd(d.PROMPTS, i)}`, tokensIn: 4200, tokensOut: 900, cacheWrites: 0, cacheReads: 0, totalCost: 0.031, size: 18321, shadowGitConfigWorkTree: cwd, cwdOnTaskInitialization: cwd, conversationHistoryDeletedRange: null, isFavorited: false, modelId: "claude-sonnet-4-5" });
    }
    d.write(path.join(base, "state/taskHistory.json"), JSON.stringify(history));
    d.write(path.join(base, "settings/cline_mcp_settings.json"), JSON.stringify({ mcpServers: {} }));
  }
  // Roo Code in VS Code: tasks/_index.json with `entries[]` and `workspace`.
  {
    const base = path.join(d.HOME, ".config/Code/User/globalStorage/rooveterinaryinc.roo-cline");
    const { i, start, cwd } = d.next();
    const id = d.uuid(`roo${i}`);
    writeTask(d, base, id, i, start, cwd);
    d.write(path.join(base, "tasks/_index.json"), JSON.stringify({ entries: [{ id, number: 1, ts: start, task: `Roo Code: ${d.rnd(d.PROMPTS, i)}`, tokensIn: 3900, tokensOut: 700, totalCost: 0.02, size: 15000, workspace: cwd, mode: "code" }] }));
  }
  // Kilo Code in VS Code Insiders: index only in the global state.vscdb ItemTable row.
  {
    const globalStorage = path.join(d.HOME, ".config/Code - Insiders/User/globalStorage");
    const base = path.join(globalStorage, "kilocode.kilo-code");
    const { i, start, cwd } = d.next();
    const id = d.uuid(`kilo${i}`);
    writeTask(d, base, id, i, start, cwd);
    d.ensure(globalStorage);
    const db = d.openSqlite(path.join(globalStorage, "state.vscdb"));
    db.exec("create table if not exists ItemTable (key text unique on conflict replace, value blob)");
    db.run("insert into ItemTable (key, value) values (?, ?)", "kilocode.kilo-code", JSON.stringify({ taskHistory: [{ id, number: 1, ts: start, task: `Kilo Code: ${d.rnd(d.PROMPTS, i)}`, tokensIn: 3100, tokensOut: 600, totalCost: 0.018, size: 12000, workspace: cwd, apiConfigName: "default", mode: "code" }], mode: "code", customModes: [] }));
    db.run("insert into ItemTable (key, value) values (?, ?)", "workbench.panel.pinnedPanels", "[]");
    db.close();
  }
};
