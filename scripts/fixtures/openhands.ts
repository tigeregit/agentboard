import path from "node:path";
import type { Fixture } from "../demo-lib";

/** OpenHands 0.x: ~/.openhands/sessions/<sid>/events/<N>.json + metadata.json. */
export const openhands: Fixture = (d) => {
  const naive = (t: number) => d.iso(t).replace(/\.\d{3}Z$/, "");
  for (let s = 0; s < 2; s++) {
    const { i, start, cwd } = d.next();
    const sid = d.uuid(`openhands${i}`).replace(/-/g, "");
    const dir = path.join(d.HOME, ".openhands/sessions", sid);
    const events: unknown[] = [{ id: 0, timestamp: naive(start), source: "agent", message: "", action: "system", args: { content: "You are OpenHands agent.", tools: [] } }];
    let last = start;
    for (const [k, t] of d.turns(i, start).entries()) {
      const base = events.length;
      events.push({ id: base, timestamp: naive(t.t), source: "user", message: t.user, action: "message", args: { content: k === 0 ? `OpenHands: ${t.user}` : t.user, image_urls: null, wait_for_response: false } });
      events.push({ id: base + 1, timestamp: naive(t.t + 3e3), source: "agent", message: "Running command: git status", action: "run", args: { command: "git status --short", is_input: false, thought: "Let me check the working tree first.", blocking: false, hidden: false, confirmation_state: "confirmed" } });
      events.push({ id: base + 2, timestamp: naive(t.t + 5e3), source: "agent", message: "Command `git status --short` executed with exit code 0.", cause: base + 1, observation: "run", content: " M src/main.py\n?? notes.md", extras: { command: "git status --short", metadata: { exit_code: 0, pid: 4242, working_dir: cwd } } });
      events.push({ id: base + 3, timestamp: naive(t.t + 8e3), source: "agent", message: "Reading file: src/main.py", action: "read", args: { path: "src/main.py", thought: "", impl_source: "oh_aci" } });
      events.push({ id: base + 4, timestamp: naive(t.t + 9e3), source: "agent", message: "I read the file src/main.py.", cause: base + 3, observation: "read", content: "print('hi')\n", extras: { path: "src/main.py", impl_source: "oh_aci" } });
      events.push({ id: base + 5, timestamp: naive(t.t + 40e3), source: "agent", message: t.reply, action: "message", args: { content: t.reply, image_urls: null, wait_for_response: true } });
      events.push({ id: base + 6, timestamp: naive(t.t + 41e3), source: "environment", message: "", action: "change_agent_state", args: { agent_state: "awaiting_user_input", thought: "" } });
      last = t.t + 41e3;
    }
    if (s === 0) events.push({ id: events.length, timestamp: naive(last + 2e3), source: "agent", message: "All done.", action: "finish", args: { final_thought: "Task completed.", task_completed: "true", outputs: {} } });
    for (const e of events) d.write(path.join(dir, "events", `${(e as { id: number }).id}.json`), JSON.stringify(e, null, 2));
    d.write(
      path.join(dir, "metadata.json"),
      JSON.stringify(
        {
          conversation_id: sid,
          user_id: null,
          selected_repository: s === 0 ? "feng/" + path.basename(cwd) : null,
          selected_branch: s === 0 ? "main" : null,
          git_provider: s === 0 ? "github" : null,
          title: `OpenHands: ${d.rnd(d.PROMPTS, i).slice(0, 40)}`,
          last_updated_at: d.iso(last),
          created_at: d.iso(start),
          trigger: "gui",
          llm_model: "anthropic/claude-sonnet-4-5",
          accumulated_cost: 0.42,
          prompt_tokens: 12_000,
          completion_tokens: 3_400,
          total_tokens: 15_400,
        },
        null,
        2,
      ),
    );
  }
};
