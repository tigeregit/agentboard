import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { IndexStore } from "../src/engine/index/store";
import { extractCommand, extractFiles, splitInjected, toolCategory } from "../src/engine/parts/classify";
import { messagesFromParts, outlineOf, PartList, partsFromMessages, turnsOf } from "../src/engine/parts/derive";
import { buildSession } from "../src/engine/util/session";

describe("parts: injected-context classifier", () => {
  it("separates harness wrappers from the human prompt", () => {
    const raw = `<timestamp>Monday, Sep 7, 2026</timestamp>\n<system_notification>\nThe following task has finished.\n</system_notification>\n<user_query>把这个项目的 CLI 测一下</user_query>`;
    const r = splitInjected(raw);
    assert.equal(r.prompt, "把这个项目的 CLI 测一下");
    assert.deepEqual(r.context.map((c) => c.form), ["snapshot", "notice"]);
  });

  it("treats pure injections as context only", () => {
    assert.equal(splitInjected("<recommended_plugins>\nfoo\n</recommended_plugins>").prompt, "");
    assert.equal(splitInjected("# AGENTS.md instructions\nuse uv").prompt, "");
    assert.equal(splitInjected("<permissions instructions>\nsandbox…").context[0]?.form, "instructions");
  });

  it("keeps unknown tags as prompt text", () => {
    assert.equal(splitInjected("please fix <div>foo</div> in the template").prompt, "please fix <div>foo</div> in the template");
  });
});

describe("parts: tool normalisation", () => {
  it("maps tool names across agents onto one category vocabulary", () => {
    for (const n of ["Bash", "exec_command", "run_terminal_command_v2", "shell", "local_shell"]) assert.equal(toolCategory(n), "shell", n);
    for (const n of ["Read", "read_file_v2", "list_dir", "cat"]) assert.equal(toolCategory(n), "read", n);
    for (const n of ["Edit", "apply_patch", "edit_file_v2", "str_replace_based_edit_tool", "Write"]) assert.equal(toolCategory(n), "edit", n);
    for (const n of ["Grep", "codebase_search", "ripgrep_raw_search", "Glob"]) assert.equal(toolCategory(n), "search", n);
    for (const n of ["Task", "spawn_agent", "task_v2", "wait_agent"]) assert.equal(toolCategory(n), "subagent", n);
    for (const n of ["TodoWrite", "update_plan", "todo_write"]) assert.equal(toolCategory(n), "plan", n);
    assert.equal(toolCategory("mcp__linear__create_issue"), "mcp");
    assert.equal(toolCategory("mystery", { command: "ls" }), "shell");
  });

  it("extracts commands and files from arguments in every shape", () => {
    assert.equal(extractCommand({ cmd: "rg -n foo", workdir: "/x" }), "rg -n foo");
    assert.equal(extractCommand('{"command":"make test"}'), "make test");
    assert.equal(extractCommand({ action: { command: ["git", "status"] } }), "git status");
    assert.deepEqual(extractFiles({ file_path: "/a/b.ts", old_string: "x", new_string: "y" }), ["/a/b.ts"]);
    assert.deepEqual(extractFiles({ input: "*** Begin Patch\n*** Add File: draft/A.md\n+hi\n*** Update File: src/b.py\n*** End Patch" }), ["draft/A.md", "src/b.py"]);
  });
});

describe("parts: derivation and turns", () => {
  it("derives parts from legacy messages and links results to calls", () => {
    const parts = partsFromMessages([
      { role: "user", text: "<system-reminder>ctx</system-reminder>\nfix the bug" },
      { role: "assistant", text: "Looking.", toolCalls: [{ name: "Bash", summary: "command: pytest -x" }] },
      { role: "tool", text: "1 failed\nexit code 1" },
      { role: "assistant", text: "Fixed." },
      { role: "user", text: "thanks" },
    ]);
    assert.deepEqual(parts.map((p) => p.kind), ["context", "prompt", "reply", "tool_call", "tool_result", "reply", "prompt"]);
    assert.deepEqual(parts.map((p) => p.turn), [0, 1, 1, 1, 1, 1, 2]);
    const call = parts[3];
    assert.equal(call.tool?.category, "shell");
    assert.equal(call.tool?.command, "pytest -x");
    const res = parts[4];
    assert.equal(res.tool?.name, "Bash");
    assert.equal(res.result?.exitCode, 1);
    assert.equal(res.result?.isError, true);
  });

  it("round-trips parts back into a legacy transcript", () => {
    const list = new PartList();
    list.pushUserText("hello");
    list.push({ kind: "reasoning", role: "assistant", text: "hmm" });
    list.push({ kind: "reply", role: "assistant", text: "hi", timestamp: "2026-01-01T00:00:00.000Z" });
    list.pushToolCall("Read", { file_path: "/x.ts" }, { timestamp: "2026-01-01T00:00:00.000Z" });
    list.pushToolResult("contents", { name: "Read" });
    const msgs = messagesFromParts(list.parts);
    assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "tool"]);
    assert.equal(msgs[1].toolCalls?.[0].name, "Read");
  });

  it("builds an outline with per-turn category counts and files", () => {
    const list = new PartList();
    list.pushUserText("do it");
    list.pushToolCall("apply_patch", { input: "*** Begin Patch\n*** Update File: src/a.py\n*** End Patch" });
    list.pushToolResult("ok");
    list.pushToolCall("Bash", { command: "pytest" });
    list.pushToolResult("boom", { isError: true });
    list.push({ kind: "reply", role: "assistant", text: "done" });
    const d = buildSession({ tool: "codex", surface: "cli", nativeId: "x", project: { path: "/repo", name: "repo" }, parts: list.parts, source: { kind: "file", path: "/tmp/f" }, fallbackTime: Date.now() });
    const o = outlineOf(d.key, d.parts);
    assert.equal(o.turns.length, 1);
    assert.deepEqual(o.turns[0].byCategory, { edit: 1, shell: 1 });
    assert.equal(o.turns[0].errors, 1);
    assert.deepEqual(o.files.map((f) => f.path), ["/repo/src/a.py"]);
    assert.equal(d.userMessageCount, 1);
    assert.equal(d.toolCallCount, 2);
    assert.equal(turnsOf(d.parts)[0].reply, "done");
  });
});

describe("parts: index + search", () => {
  it("indexes parts and finds them across sessions with snippets", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-parts-"));
    const store = new IndexStore(path.join(dir, "index.db"));
    try {
      const mk = (id: string, prompt: string, cmd: string) => {
        const list = new PartList();
        list.pushUserText(prompt);
        list.pushToolCall("Bash", { command: cmd });
        list.pushToolResult("exit code 0");
        return buildSession({ tool: "claude-code", surface: "cli", nativeId: id, project: { path: "/p", name: "p" }, parts: list.parts, source: { kind: "file", path: `/tmp/${id}` }, startedAt: "2026-01-0" + id + "T00:00:00Z" });
      };
      const a = mk("1", "菜谱系统的节点设计有问题", "docker compose up");
      const b = mk("2", "make the tests pass", "pytest -q");
      store.upsertSessions([a, b]);
      store.parts.replaceSession(a.key, a.parts, "rich");
      store.parts.replaceSession(b.key, b.parts, "rich");

      const cjk = store.parts.search({ text: "节点设计" });
      assert.equal(cjk.total, 1);
      assert.equal(cjk.hits[0].sessionKey, a.key);
      assert.match(cjk.hits[0].snippet, /⟦节点设计⟧/);

      const shortToken = store.parts.search({ text: "菜谱" }); // < 3 chars → LIKE path
      assert.equal(shortToken.total, 1);

      const shell = store.parts.search({ text: "docker", categories: ["shell"], kinds: ["tool_call"] });
      assert.equal(shell.total, 1);
      assert.equal(shell.hits[0].category, "shell");

      const onlyB = store.parts.search({ text: "pytest", sessionKey: b.key });
      assert.equal(onlyB.total, 1);

      assert.equal(store.parts.partsOf(a.key, { kinds: ["prompt"] }).length, 1);
      assert.equal(store.keysWithoutParts().length, 0);
      store.parts.deleteSession(a.key);
      assert.deepEqual(store.keysWithoutParts(), [a.key]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
