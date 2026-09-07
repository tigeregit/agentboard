import path from "node:path";
import type { Fixture } from "../demo-lib";

/** Open Interpreter v1: Codex-identical rollouts under ~/.openinterpreter/sessions/YYYY/MM/DD/ (+ archived_sessions/). */
export const openinterpreter: Fixture = (d) => {
  for (let s = 0; s < 3; s++) {
    const { i, start, cwd } = d.next();
    const id = d.uuid(`interpreter${i}`);
    const dt = new Date(start);
    const lines: unknown[] = [{ timestamp: d.iso(start), type: "session_meta", payload: { id, timestamp: d.iso(start), cwd, originator: "interpreter", cli_version: "1.0.0", git: { branch: "main" } } }];
    lines.push({ timestamp: d.iso(start), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>` }] } });
    for (const t of d.turns(i, start)) {
      lines.push({ timestamp: d.iso(t.t), type: "event_msg", payload: { type: "user_message", message: t.user } });
      lines.push({ timestamp: d.iso(t.t), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: t.user }] } });
      lines.push({ timestamp: d.iso(t.t + 30e3), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["python", "-c", "print(1)"] }), call_id: "c1" } });
      lines.push({ timestamp: d.iso(t.t + 31e3), type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "1" } });
      lines.push({ timestamp: d.iso(t.t + 90e3), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: t.reply }] } });
    }
    lines.push({ timestamp: d.iso(start), type: "turn_context", payload: { cwd, model: "gpt-5.6" } });
    const sub = s === 2 ? "archived_sessions" : "sessions";
    const file = path.join(d.HOME, ".openinterpreter", sub, String(dt.getFullYear()), String(dt.getMonth() + 1).padStart(2, "0"), String(dt.getDate()).padStart(2, "0"), `rollout-${d.iso(start).replace(/[:.]/g, "-")}-${id}.jsonl`);
    d.write(file, d.jsonl(lines));
  }
};
