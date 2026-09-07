import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { classifyCopilotSession, copilotCli, copilotDesktop } from "../src/engine/adapters/copilot";
import { vscodeCopilot } from "../src/engine/adapters/vscode-copilot";
import { openSqlite } from "../src/engine/util/sqlite";
import { fullScanContext, makeFakeHome, removeDir, write } from "./helpers/fixtures";

const none = new Set<string>();

describe("copilot: classifyCopilotSession", () => {
  it("routes by client_name when host_type is absent", () => {
    assert.equal(classifyCopilotSession({ client_name: "github/autopilot" }, "x", none), "copilot-desktop");
    assert.equal(classifyCopilotSession({ client_name: "github/cli" }, "x", none), "copilot-cli");
    assert.equal(classifyCopilotSession({ client_name: "github/vscode" }, "x", none), "vscode-copilot");
    assert.equal(classifyCopilotSession({ client_name: "GitHub/AutoPilot" }, "x", none), "copilot-desktop");
  });

  it("keeps host_type as the highest-precedence signal", () => {
    assert.equal(classifyCopilotSession({ host_type: "cli", client_name: "github/autopilot" }, "x", none), "copilot-cli");
    assert.equal(classifyCopilotSession({ host_type: "app" }, "x", none), "copilot-desktop");
    assert.equal(classifyCopilotSession({ host_type: "vscode" }, "x", none), "vscode-copilot");
  });

  it("falls back to data.db membership, then CLI", () => {
    assert.equal(classifyCopilotSession({}, "in-db", new Set(["in-db"])), "copilot-desktop");
    assert.equal(classifyCopilotSession({}, "elsewhere", new Set(["in-db"])), "copilot-cli");
    assert.equal(classifyCopilotSession({ client_name: "github/something-new" }, "elsewhere", none), "copilot-cli");
  });
});

describe("copilot: workspace.yaml name + client_name end to end", () => {
  let home: string;
  const events = (id: string, prompt: string) =>
    [
      { type: "session.start", timestamp: "2026-09-01T10:00:00Z", data: { sessionId: id, context: { cwd: "/home/example/code/app" } } },
      { type: "user.message", timestamp: "2026-09-01T10:00:05Z", data: { content: prompt } },
      { type: "assistant.message", timestamp: "2026-09-01T10:00:20Z", data: { content: "Sure." } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";

  before(() => {
    home = makeFakeHome("copilot");
    const state = path.join(home, ".copilot/session-state");
    write(path.join(state, "desk/events.jsonl"), events("desk", "desktop prompt"));
    write(path.join(state, "desk/workspace.yaml"), "id: desk\ncwd: /home/example/code/app\nclient_name: github/autopilot\nname: Friendly desktop name\n");
    write(path.join(state, "cli/events.jsonl"), events("cli", "cli prompt"));
    write(path.join(state, "cli/workspace.yaml"), "id: cli\ncwd: /home/example/code/app\nclient_name: github/cli\nsummary: legacy summary\n");
    write(path.join(state, "code/events.jsonl"), events("code", "vscode prompt"));
    write(path.join(state, "code/workspace.yaml"), "id: code\ncwd: /home/example/code/app\nclient_name: github/vscode\n");
    write(path.join(state, "bare/events.jsonl"), events("bare", "bare prompt"));
    write(path.join(state, "bare/workspace.yaml"), "id: bare\ncwd: /home/example/code/app\n");
    const db = openSqlite(path.join(home, ".copilot/data.db"));
    db.exec("create table sessions (id text primary key)");
    db.run("insert into sessions values ('bare')");
    db.close();
  });
  after(() => removeDir(home));

  it("splits one shared store across the three Copilot adapters", async () => {
    const ctx = fullScanContext();
    const [cli, desktop, code] = await Promise.all([copilotCli.scan(ctx), copilotDesktop.scan(ctx), vscodeCopilot.scan(ctx)]);
    assert.deepEqual(cli.sessions.map((s) => s.nativeId).sort(), ["cli"]);
    assert.deepEqual(desktop.sessions.map((s) => s.nativeId).sort(), ["bare", "desk"]);
    assert.deepEqual(code.sessions.filter((s) => s.source.path.includes(".copilot")).map((s) => s.nativeId), ["code"]);
    for (const r of [cli, desktop]) assert.equal(r.seen.length, 4, "every adapter must report the whole shared store as seen");
  });

  it("prefers workspace.yaml name over summary over the first prompt", async () => {
    const ctx = fullScanContext();
    const desktop = await copilotDesktop.scan(ctx);
    const cli = await copilotCli.scan(ctx);
    assert.equal(desktop.sessions.find((s) => s.nativeId === "desk")!.title, "Friendly desktop name");
    assert.equal(desktop.sessions.find((s) => s.nativeId === "bare")!.title, "bare prompt");
    assert.equal(cli.sessions[0].title, "legacy summary");
    assert.equal(desktop.sessions.find((s) => s.nativeId === "desk")!.extra?.clientName, "github/autopilot");
  });
});
