import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { extractTraeSessions, trae, traeSessionsFromValue } from "../src/engine/adapters/trae";
import { openSqlite } from "../src/engine/util/sqlite";
import { fullScanContext, makeFakeHome, removeDir, write } from "./helpers/fixtures";

const DB = "/tmp/fixture/state.vscdb";

describe("trae state.vscdb: extractTraeSessions", () => {
  const session = { id: "s1", title: "Fix login", messages: [{ role: "user", content: "why does login fail?" }, { role: "ai", content: "Checking" }] };

  it("reads every known container shape", () => {
    assert.equal(extractTraeSessions({ list: [session] }).length, 1);
    assert.equal(extractTraeSessions({ sessions: { s1: session } }).length, 1);
    assert.equal(extractTraeSessions({ conversations: [session] }).length, 1);
    assert.equal(extractTraeSessions({ entries: [session] }).length, 1);
    assert.equal(extractTraeSessions([session]).length, 1);
  });

  it("drops sessions without an id or without messages", () => {
    assert.equal(extractTraeSessions({ list: [{ title: "no id", messages: [{ role: "user", content: "x" }] }] }).length, 0);
    assert.equal(extractTraeSessions({ list: [{ id: "empty", messages: [] }] }).length, 0);
    assert.equal(extractTraeSessions("garbage").length, 0);
    assert.equal(extractTraeSessions(null).length, 0);
  });

  it("accepts sessionId/key and name aliases", () => {
    const [s] = extractTraeSessions({ list: [{ sessionId: "alias", name: "Named", history: [{ role: "user", text: "hi" }] }] });
    assert.equal(s.id, "alias");
    assert.equal(s.title, "Named");
    assert.equal(s.messages.length, 1);
  });
});

describe("trae state.vscdb: traeSessionsFromValue", () => {
  it("maps ai/model roles, nested content and Agent/SOLO plan items", () => {
    const value = {
      list: [
        {
          id: "agent-1",
          title: "Refactor parser",
          createdAt: 1_757_000_000_000,
          updatedAt: 1_757_000_600_000,
          messages: [
            { role: "user", content: "refactor the parser", createdAt: 1_757_000_000_000 },
            {
              role: "ai",
              content: { data: { summary: "Done, two files touched." } },
              agentTaskContent: { guideline: { planItems: [{ thought: "Look at parser.ts first", toolName: "ReadFile", toolParams: { path: "src/parser.ts" } }, { toolName: "EditFile", toolParams: { path: "src/parser.ts" } }, { content: "All tests pass." }] } },
            },
            { role: "model", text: "Anything else?" },
            { role: "system", content: "ignored" },
          ],
        },
      ],
    };
    const [s] = traeSessionsFromValue(value, DB, "/home/example/code/app", 0);
    assert.equal(s.tool, "trae");
    assert.equal(s.surface, "ide");
    assert.equal(s.nativeId, "agent-1");
    assert.equal(s.title, "Refactor parser");
    assert.equal(s.project.name, "app");
    assert.deepEqual(s.source, { kind: "sqlite", path: DB, locator: "agent-1" });
    assert.equal(s.messages.length, 3, "system message is dropped");
    assert.deepEqual(s.messages.map((m) => m.role), ["user", "assistant", "assistant"]);
    const agent = s.messages[1];
    assert.match(agent.text, /^Done, two files touched\./);
    assert.match(agent.text, /Look at parser\.ts first/);
    assert.match(agent.text, /All tests pass\./);
    assert.deepEqual(agent.toolCalls?.map((t) => t.name), ["ReadFile", "EditFile"]);
    assert.match(agent.toolCalls![0].summary ?? "", /src\/parser\.ts/);
    assert.equal(s.toolCallCount, 2);
    assert.equal(s.startedAt, new Date(1_757_000_000_000).toISOString());
    assert.equal(s.endedAt, new Date(1_757_000_600_000).toISOString());
    assert.equal(s.extra?.workspaceHash, "fixture");
  });

  it("skips sessions whose messages carry no text", () => {
    const value = { list: [{ id: "blank", messages: [{ role: "user", content: "" }, { role: "ai", content: null }] }] };
    assert.equal(traeSessionsFromValue(value, DB, undefined, 0).length, 0);
  });
});

describe("trae state.vscdb: adapter scan + load", () => {
  let home: string;
  before(() => {
    home = makeFakeHome("trae");
    const storage = path.join(home, ".config/Trae/User/workspaceStorage");

    // Workspace A: primary exact key plus a decoy suffixed key that must lose precedence.
    const a = path.join(storage, "aaaa");
    write(path.join(a, "workspace.json"), JSON.stringify({ folder: "file:///home/example/code/alpha" }));
    let db = openSqlite(path.join(a, "state.vscdb"));
    db.exec("create table ItemTable (key text unique, value blob)");
    db.run("insert into ItemTable values (?, ?)", "memento/icube-ai-agent-storage", JSON.stringify({ list: [{ id: "a-1", title: "Primary", messages: [{ role: "user", content: "hello from agent storage" }, { role: "ai", content: "hi" }] }] }));
    db.run("insert into ItemTable values (?, ?)", "memento/icube-ai-chat-storage-7", JSON.stringify({ list: [{ id: "a-decoy", messages: [{ role: "user", content: "should not be picked" }] }] }));
    db.close();

    // Workspace B: only the install-suffixed key, stored as a BLOB, two sessions.
    const b = path.join(storage, "bbbb");
    write(path.join(b, "workspace.json"), JSON.stringify({ folder: "file:///home/example/code/beta" }));
    db = openSqlite(path.join(b, "state.vscdb"));
    db.exec("create table ItemTable (key text unique, value blob)");
    const payload = { sessions: { "b-1": { id: "b-1", messages: [{ role: "user", content: "first" }, { role: "assistant", content: "ok" }] }, "b-2": { id: "b-2", title: "Second", messages: [{ role: "user", content: "second" }] } } };
    db.run("insert into ItemTable values (?, ?)", "memento/icube-ai-ng-chat-storage-3", Buffer.from(JSON.stringify(payload)));
    db.close();

    // Workspace C: a VS Code workspace without any Trae chat, must be ignored silently.
    const c = path.join(storage, "cccc");
    write(path.join(c, "workspace.json"), JSON.stringify({ folder: "file:///home/example/code/gamma" }));
    db = openSqlite(path.join(c, "state.vscdb"));
    db.exec("create table ItemTable (key text unique, value blob)");
    db.run("insert into ItemTable values (?, ?)", "workbench.panel.pinnedPanels", "[]");
    db.close();
  });
  after(() => removeDir(home));

  it("finds sessions across workspaces with the documented key precedence", async () => {
    const r = await trae.scan(fullScanContext());
    assert.deepEqual(r.warnings, []);
    const ide = r.sessions.filter((s) => s.surface === "ide");
    assert.deepEqual(ide.map((s) => s.nativeId).sort(), ["a-1", "b-1", "b-2"]);
    const a1 = ide.find((s) => s.nativeId === "a-1")!;
    assert.equal(a1.title, "Primary");
    assert.equal(a1.project.path, "/home/example/code/alpha");
    assert.equal(ide.find((s) => s.nativeId === "b-2")!.project.name, "beta");
    assert.equal(r.seen.length, 3, "every state.vscdb is reported as seen, chat or not");
  });

  it("reports the workspaceStorage in detect()", async () => {
    const d = await trae.detect();
    assert.equal(d.installed, true);
    assert.ok(d.locations.some((l) => l.exists && l.path.endsWith("workspaceStorage")));
  });

  it("loads one session from its sqlite source", async () => {
    const r = await trae.scan(fullScanContext());
    const b2 = r.sessions.find((s) => s.nativeId === "b-2")!;
    const detail = await trae.load(b2);
    assert.ok(detail);
    assert.equal(detail.nativeId, "b-2");
    assert.equal(detail.title, "Second");
    assert.deepEqual(detail.messages.map((m) => m.text), ["second"]);
  });
});
