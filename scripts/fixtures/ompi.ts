import path from "node:path";
import type { Fixture } from "../demo-lib";

/** oh-my-pi: pi-format tree JSONL relocated to ~/.omp/agent/sessions/<escaped-cwd>/<timestamp>_<sessionId>.jsonl. */
export const ompi: Fixture = (d) => {
  for (let s = 0; s < 2; s++) {
    const { i, start, cwd } = d.next();
    const id = d.uuid(`omp${i}`);
    const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: d.iso(start), cwd }];
    let parent: string | null = null;
    let n = 0;
    const push = (rec: Record<string, unknown>) => {
      lines.push({ id: `e${n}`, parentId: parent, ...rec });
      parent = `e${n++}`;
    };
    push({ type: "model_change", timestamp: d.iso(start), model: "anthropic/claude-opus-4-8" });
    for (const t of d.turns(i, start)) {
      push({ type: "message", timestamp: d.iso(t.t), message: { role: "user", content: [{ type: "text", text: t.user }], timestamp: t.t } });
      push({ type: "message", timestamp: d.iso(t.t + 30e3), message: { role: "assistant", content: [{ type: "toolCall", id: "tc", name: "bash", arguments: { command: "git status --short" } }] } });
      push({ type: "message", timestamp: d.iso(t.t + 31e3), message: { role: "toolResult", toolCallId: "tc", content: [{ type: "text", text: " M src/index.ts" }] } });
      push({ type: "message", timestamp: d.iso(t.t + 90e3), message: { role: "assistant", content: [{ type: "text", text: t.reply }] } });
    }
    push({ type: "session_info", timestamp: d.iso(start), name: `omp: ${d.rnd(d.PROMPTS, i).slice(0, 30)}` });
    const escaped = cwd.replace(/[\/_]/g, "-");
    d.write(path.join(d.HOME, ".omp/agent/sessions", escaped, `${d.iso(start).replace(/[:.]/g, "-")}_${id}.jsonl`), d.jsonl(lines));
  }
};
