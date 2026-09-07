import path from "node:path";
import type { Fixture } from "../demo-lib";

/** Gemini CLI: ~/.gemini/tmp/<projectHash>/chats/session-*.jsonl (current) + one legacy session-*.json. */
export const gemini: Fixture = (d) => {
  for (let s = 0; s < 3; s++) {
    const { i, start, cwd } = d.next();
    const id = d.uuid(`gemini${i}`);
    const projectDir = path.join(d.HOME, ".gemini/tmp", d.md5ish("gemini" + cwd));
    d.write(path.join(projectDir, ".project_root"), cwd + "\n");
    const turns = d.turns(i, start);
    const records: unknown[] = [];
    for (const [k, t] of turns.entries()) {
      records.push({ id: d.uuid(`gu${i}${t.t}`), timestamp: d.iso(t.t), type: "user", content: [{ text: t.user }] });
      records.push({
        id: d.uuid(`ga${i}${t.t}`),
        timestamp: d.iso(t.t + 50e3),
        type: "gemini",
        content: t.reply,
        model: "gemini-3-flash-preview",
        thoughts: [{ subject: "Planning", description: "Read the relevant file before editing." }],
        tokens: { input: 1200, output: 300, cached: 100, thoughts: 40, tool: 0, total: 1540 },
        toolCalls: [
          {
            id: `tool-${k}`,
            name: k % 2 ? "run_shell_command" : "read_file",
            args: k % 2 ? { command: "npm test" } : { file_path: `${cwd}/src/index.ts` },
            result: [{ functionResponse: { id: `tool-${k}`, name: k % 2 ? "run_shell_command" : "read_file", response: { output: k % 2 ? "42 passing" : "export const x = 1;" } } }],
            status: "success",
            timestamp: d.iso(t.t + 40e3),
            ...(k === 0 ? { resultDisplay: { fileDiff: "--- a\n+++ b", fileName: "src/index.ts" } } : {}),
          },
        ],
      });
    }
    records.push({ id: d.uuid(`gi${i}`), timestamp: d.iso(start + 1e3), type: "info", content: "Model switched to gemini-3-flash-preview" });
    const stamp = d.iso(start).replace(/[:.]/g, "-");
    const meta = { sessionId: id, projectHash: path.basename(projectDir), startTime: d.iso(start), lastUpdated: d.iso(start), kind: "main", summary: `Gemini: ${d.rnd(d.PROMPTS, i).slice(0, 40)}` };
    if (s === 2) {
      d.write(path.join(projectDir, "chats", `session-${stamp}-${id.slice(0, 8)}.json`), JSON.stringify({ ...meta, lastUpdated: d.iso(start + 20 * 60e3), messages: records }, null, 2));
    } else {
      const lines: unknown[] = [meta, ...records, { $rewindTo: d.uuid(`gu${i}${turns[0].t}`) }, { $set: { lastUpdated: d.iso(start + 20 * 60e3) } }];
      d.write(path.join(projectDir, "chats", `session-${stamp}-${id.slice(0, 8)}.jsonl`), d.jsonl(lines));
    }
  }
};
