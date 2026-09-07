import path from "node:path";
import type { Fixture } from "../demo-lib";

/**
 * Antigravity CLI (~/.gemini/antigravity-cli: history.jsonl + brain transcripts) and the
 * desktop app (~/.gemini/antigravity: brain labels + .token-monitor/rpc-cache usage.jsonl).
 */
export const antigravity: Fixture = (d) => {
  // ---- CLI layout ----
  const cliRoot = path.join(d.HOME, ".gemini/antigravity-cli");
  const history: unknown[] = [];
  for (let s = 0; s < 2; s++) {
    const { i, start, cwd } = d.next();
    const conv = d.uuid(`agcli${i}`);
    const turns = d.turns(i, start);
    if (s === 0) history.push({ display: `Antigravity CLI: ${turns[0].user.slice(0, 40)}`, timestamp: start, workspace: cwd, type: "chat", conversationId: conv });
    const steps: unknown[] = [];
    let idx = 0;
    for (const [k, t] of turns.entries()) {
      steps.push({ step_index: idx++, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: t.user, created_at: d.iso(t.t) });
      if (k === 0) steps.push({ step_index: idx++, source: "SYSTEM", type: "CONVERSATION_HISTORY", status: "DONE", content: "replayed context" });
      steps.push({ step_index: idx++, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE" });
      steps.push({ step_index: idx++, source: "MODEL", type: "SEARCH_WEB", status: "DONE", content: "Searched the docs for the failing API.", created_at: d.iso(t.t + 20e3) });
      steps.push({ step_index: idx++, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: t.reply, created_at: d.iso(t.t + 60e3) });
    }
    d.write(path.join(cliRoot, "brain", conv, ".system_generated/logs/transcript_full.jsonl"), d.jsonl(steps));
    d.write(path.join(cliRoot, "brain", conv, "task.md"), `# Task: ${turns[0].user}\n`);
  }
  history.push({ display: "no conversation id", timestamp: d.now, workspace: d.PROJECTS[0] });
  d.write(path.join(cliRoot, "history.jsonl"), d.jsonl(history));
  d.ensure(path.join(cliRoot, "brain", d.uuid("agcli-empty")));

  // ---- desktop layout ----
  const root = path.join(d.HOME, ".gemini/antigravity");
  const rpc = path.join(root, ".token-monitor/rpc-cache/v1");
  d.write(path.join(root, "monitor-state.archive-2026-05.json"), JSON.stringify({ sessions: {} }));
  for (let s = 0; s < 2; s++) {
    const { i, start } = d.next();
    const id = d.uuid(`agdesk${i}`);
    const turns = d.turns(i, start);
    const usage = turns.map((t, k) => ({
      recordType: "usage",
      sessionId: id,
      sequence: k + 1,
      model: k % 2 ? "MODEL_PLACEHOLDER_M8" : "claude-sonnet-4-6-thinking",
      inputTokens: 1200 + k * 100,
      outputTokens: 300 + k * 10,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
      reasoningTokens: 80,
      totalTokens: 2030 + k * 110,
      raw: { chatModel: { chatStartMetadata: { createdAt: d.iso(t.t) } } },
    }));
    d.write(path.join(rpc, id, "usage.jsonl"), d.jsonl(usage));
    d.write(path.join(rpc, id, "steps.jsonl"), d.jsonl(turns.map((_t, k) => ({ recordType: "step", sessionId: id, stepIndex: k }))));
    d.write(path.join(rpc, id, "manifest.json"), JSON.stringify({ exportedAt: start + 30 * 60e3, serverLastModifiedMs: start + 29 * 60e3, stepCount: turns.length }));
    if (s === 0) {
      d.write(path.join(root, "brain", id, "task.md"), `# Task: Antigravity: ${turns[0].user.slice(0, 40)}\n\n- [x] investigate\n`);
      d.write(path.join(root, "brain", id, "walkthrough.md"), `# Walkthrough\n\n${turns[0].reply}\n`);
      d.write(path.join(root, "conversations", `${id}.pb`), Buffer.from([0x0a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]));
    }
  }
};
