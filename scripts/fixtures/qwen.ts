import path from "node:path";
import type { Fixture } from "../demo-lib";

/** Qwen Code: ~/.qwen/projects/<sanitizedCwd>/chats/<sessionId>.jsonl ChatRecord lines with genai parts. */
export const qwen: Fixture = (d) => {
  for (let s = 0; s < 3; s++) {
    const { i, start, cwd } = d.next();
    const id = d.uuid(`qwen${i}`);
    const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const lines: unknown[] = [];
    let parent: string | null = null;
    const push = (rec: Record<string, unknown>) => {
      const uuid = d.uuid(`q${i}${lines.length}`);
      lines.push({ uuid, parentUuid: parent, sessionId: id, cwd, ...rec });
      parent = uuid;
    };
    for (const [k, t] of d.turns(i, start).entries()) {
      push({ timestamp: d.iso(t.t), type: "user", message: { role: "user", parts: [{ text: t.user }] } });
      push({
        timestamp: d.iso(t.t + 20e3),
        type: "assistant",
        model: "qwen3-coder-plus",
        usageMetadata: { promptTokenCount: 812, candidatesTokenCount: 120, cachedContentTokenCount: 200, thoughtsTokenCount: 30 },
        message: { role: "model", parts: [{ text: "Let me check the code first.", thought: true }, { text: "Checking the implementation." }, { functionCall: { id: `c${k}`, name: "run_shell_command", args: { command: `rg -n retry ${cwd}/src` } } }] },
      });
      push({ timestamp: d.iso(t.t + 21e3), type: "tool_result", message: { role: "user", parts: [{ functionResponse: { id: `c${k}`, name: "run_shell_command", response: { output: "src/storage/s3.ts:12:  // TODO retry" } } }] } });
      push({ timestamp: d.iso(t.t + 80e3), type: "assistant", model: "qwen3-coder-plus", message: { role: "model", parts: [{ text: t.reply }] } });
    }
    push({ timestamp: d.iso(start + 2e3), type: "system", subtype: "custom_title", message: { role: "user", parts: [{ text: `Qwen: ${d.rnd(d.PROMPTS, i).slice(0, 40)}` }] } });
    d.write(path.join(d.HOME, ".qwen/projects", sanitized, "chats", `${id}.jsonl`), d.jsonl(lines));
  }
};
