import path from "node:path";
import type { Fixture } from "../demo-lib";

/** Mistral Vibe: ~/.vibe/logs/session/session_<stamp>_<id>/{meta.json,messages.jsonl}. */
export const vibe: Fixture = (d) => {
  for (let s = 0; s < 3; s++) {
    const { i, start, cwd } = d.next();
    const stamp = d.iso(start).replace(/[-:T]/g, "").slice(0, 15).replace(/^(\d{8})(\d{6}).*/, "$1_$2");
    const shortId = d.md5ish(`vibe${i}`).slice(0, 6);
    const dir = path.join(d.HOME, ".vibe/logs/session", `session_${stamp}_${shortId}`);
    const lines: unknown[] = [{ role: "system", content: "You are Vibe, Mistral's coding agent.", message_id: d.uuid(`vibe-sys${i}`) }];
    let prompt = 0;
    let completion = 0;
    let end = start;
    for (const [k, t] of d.turns(i, start).entries()) {
      const call = `call_${d.uuid(`vibe-call${i}${k}`).slice(0, 8)}`;
      const user: Record<string, unknown> = { role: "user", content: k === 0 ? `Vibe: ${t.user}` : t.user, message_id: d.uuid(`vibe-u${i}${k}`), timestamp: d.iso(t.t) };
      if (k === 1) user.images = [{ source: { kind: "inline", data: "iVBORw0KGgo=" }, alias: "screenshot", mime_type: "image/png" }];
      lines.push(user);
      lines.push({
        role: "assistant",
        content: k % 2 ? [{ type: "think", think: "Plan: inspect then edit." }, { type: "text", text: "Let me look at the file first." }] : "Let me look at the file first.",
        reasoning_content: "Need to read before editing.",
        message_id: d.uuid(`vibe-a1${i}${k}`),
        timestamp: d.iso(t.t + 4e3),
        tool_calls: [{ id: call, type: "function", function: { name: t.tool === "Bash" ? "bash" : "read_file", arguments: JSON.stringify(t.tool === "Bash" ? { command: "git status" } : { path: "src/main.py" }) } }],
      });
      lines.push({ role: "tool", tool_call_id: call, content: t.tool === "Bash" ? "On branch main\nnothing to commit" : "print('hi')\n", message_id: d.uuid(`vibe-t${i}${k}`), timestamp: d.iso(t.t + 6e3) });
      lines.push({ role: "assistant", content: t.reply, message_id: d.uuid(`vibe-a2${i}${k}`), timestamp: d.iso(t.t + 50e3) });
      prompt += 900 + k * 120;
      completion += 240 + k * 30;
      end = t.t + 50e3;
    }
    d.write(path.join(dir, "messages.jsonl"), d.jsonl(lines));
    d.write(
      path.join(dir, "meta.json"),
      JSON.stringify(
        {
          session_id: d.uuid(`vibe-session${i}`),
          start_time: d.iso(start),
          end_time: d.iso(end),
          environment: { working_directory: cwd, shell: "/bin/zsh", os: "darwin" },
          title: s === 2 ? null : `Vibe: ${d.rnd(d.PROMPTS, i).slice(0, 40)}`,
          title_source: s === 0 ? "manual" : "auto",
          model: "devstral-medium-2507",
          stats: { session_prompt_tokens: prompt, session_completion_tokens: completion, turns: 2 + (i % 3) },
        },
        null,
        2,
      ),
    );
  }
};
