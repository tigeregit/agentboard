import fs from "node:fs";
import path from "node:path";
import type { Demo, Fixture } from "../demo-lib";

/** Continue session store (`<global-dir>/sessions/<sessionId>.json` + `sessions.json` index), shared with the PearAI fixture. */
export function writeContinueSessions(d: Demo, globalDir: string, label: string, count: number) {
  const index: unknown[] = [];
  for (let s = 0; s < count; s++) {
    const { i, start, cwd } = d.next();
    const sessionId = d.uuid(`${label}${i}`);
    const history: unknown[] = [];
    for (const [k, t] of d.turns(i, start).entries()) {
      history.push({
        message: { role: "user", content: k === 0 ? [{ type: "text", text: t.user }] : t.user },
        contextItems: k === 0 ? [{ content: "export async function upload() {}", name: "s3.ts", description: "src/storage/s3.ts", id: { providerTitle: "file", itemId: `${cwd}/src/storage/s3.ts` }, uri: { type: "file", value: `file://${cwd}/src/storage/s3.ts` } }] : [],
        editorState: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: t.user }] }] },
      });
      if (k === 0) {
        const callId = `call_${d.md5ish(`${sessionId}${k}`).slice(0, 12)}`;
        const args = { filepath: "src/storage/s3.ts" };
        history.push({
          message: { role: "assistant", content: "", toolCalls: [{ id: callId, type: "function", function: { name: "read_file", arguments: JSON.stringify(args) } }] },
          contextItems: [],
          toolCallStates: [{ toolCallId: callId, toolCall: { id: callId, type: "function", function: { name: "read_file", arguments: JSON.stringify(args) } }, status: "done", parsedArgs: args, output: [{ name: "Tool output", description: "read_file", content: "export async function upload() {}" }] }],
        });
        history.push({ message: { role: "tool", content: "export async function upload() {}", toolCallId: callId }, contextItems: [] });
      }
      history.push({ message: { role: "assistant", content: [{ type: "text", text: t.reply }] }, contextItems: [] });
    }
    const title = s % 2 ? "New Session" : `${label}: ${d.rnd(d.PROMPTS, i).slice(0, 40)}`;
    const file = path.join(globalDir, "sessions", `${sessionId}.json`);
    d.write(file, JSON.stringify({ sessionId, title, workspaceDirectory: cwd, history }, null, 2));
    // Continue records no timestamps inside the document; the file mtime is the only "last activity" signal.
    fs.utimesSync(file, new Date(start + 25 * 60e3), new Date(start + 25 * 60e3));
    index.push({ sessionId, title, dateCreated: String(start), workspaceDirectory: cwd });
  }
  d.write(path.join(globalDir, "sessions", "sessions.json"), JSON.stringify(index));
  d.write(path.join(globalDir, "sessions", "notes.txt"), "not a session");
}

export const continueDev: Fixture = (d) => {
  const globalDir = process.env.CONTINUE_GLOBAL_DIR?.trim() || path.join(d.HOME, ".continue");
  writeContinueSessions(d, globalDir, "Continue", 3);
  d.write(path.join(globalDir, "config.yaml"), "name: Local Assistant\nversion: 1.0.0\nschema: v1\n");
};
