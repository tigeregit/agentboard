import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { ADAPTERS } from "../src/engine/registry";
import type { ScanResult, SessionSummary, SourceAdapter } from "../src/engine/types";
import { parseChatGptExport, parseClaudeExport } from "../src/engine/webchat/exports";
import { writeImported } from "../src/engine/webchat/imported";
import { fullScanContext, generateDemoHome, makeFakeHome, project, removeDir, sortProjections, type Projection } from "./helpers/fixtures";

/**
 * Per-adapter fixture tests. Every adapter scans the synthetic dataset from
 * scripts/demo-data.ts (one fake $HOME with all 15 tools + web-chat imports)
 * and the normalized result is compared with tests/adapters.snapshot.json.
 *
 * Regenerate the snapshot after an intentional parser change with
 *   UPDATE_SNAPSHOTS=1 npm test
 */
const SNAPSHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "adapters.snapshot.json");
const UPDATE = !!process.env.UPDATE_SNAPSHOTS;

/** Adapters whose only strategy needs a live service; they must scan to nothing without one. */
const REMOTE_ONLY = new Set(["openwebui"]);

let home: string;
const results = new Map<string, ScanResult>();
const snapshot: Record<string, Projection[]> = fs.existsSync(SNAPSHOT) ? JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) : {};
const actual: Record<string, Projection[]> = {};

before(async () => {
  home = makeFakeHome("adapters");
  generateDemoHome(home);
  // Web-chat exports are opt-in: mirror `agentboard import <tool> conversations.json`.
  const read = (p: string) => JSON.parse(fs.readFileSync(path.join(home, p), "utf8"));
  for (const d of parseChatGptExport(read("Downloads/chatgpt-export/conversations.json"), path.join(home, "Downloads/chatgpt-export/conversations.json"))) writeImported(d);
  for (const d of parseClaudeExport(read("Downloads/claude-export/conversations.json"), path.join(home, "Downloads/claude-export/conversations.json"))) writeImported(d);
  // One shared ScanContext: adapters that share a store (Copilot family) memoize through it.
  const ctx = fullScanContext();
  for (const adapter of ADAPTERS) results.set(adapter.id, await adapter.scan(ctx));
});

after(() => {
  if (UPDATE) fs.writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 2) + "\n");
  removeDir(home);
});

async function loadRoundTrip(adapter: SourceAdapter, s: SessionSummary) {
  const detail = await adapter.load(s);
  assert.ok(detail, `${adapter.id}: load() returned null for ${s.key} (${s.source.kind} ${s.source.path})`);
  assert.equal(detail.nativeId, s.nativeId, `${adapter.id}: load() returned a different session`);
  assert.equal(detail.messages.length, s.messageCount, `${adapter.id}: message count differs between scan and load for ${s.key}`);
  assert.ok(detail.messages.some((m) => m.role === "user" && m.text.trim()), `${adapter.id}: ${s.key} has no user message`);
}

for (const adapter of ADAPTERS) {
  describe(adapter.id, () => {
    it("detects its fixture locations", async () => {
      const d = await adapter.detect();
      assert.ok(Array.isArray(d.locations) && d.locations.length > 0, "detect() must list probed locations");
      if (!REMOTE_ONLY.has(adapter.id)) assert.equal(d.installed, true, `${adapter.id} should be detected in the demo home`);
    });

    it("scans sessions with sane invariants", () => {
      const r = results.get(adapter.id)!;
      assert.deepEqual(r.warnings, [], "scan produced warnings");
      if (REMOTE_ONLY.has(adapter.id)) {
        assert.equal(r.sessions.length, 0);
        return;
      }
      assert.ok(r.sessions.length > 0, "expected at least one session from the fixtures");
      assert.ok(r.seen.length > 0, "scan must report the source files it saw, or reconcile would drop the sessions");
      for (const s of r.sessions) {
        assert.equal(s.tool, adapter.id, `session ${s.key} attributed to ${s.tool}`);
        assert.equal(s.key, `${s.tool}:${s.nativeId}`);
        assert.ok(s.title.trim(), `${s.key} has an empty title`);
        assert.ok(s.messageCount > 0 && s.userMessageCount > 0, `${s.key} has no user messages`);
        assert.ok(s.startedAt <= s.endedAt, `${s.key} ends before it starts`);
        assert.notEqual(s.startedAt, new Date(0).toISOString(), `${s.key} fell back to the epoch timestamp`);
        assert.ok(s.source.path.startsWith(home), `${s.key} source outside the fake home: ${s.source.path}`);
        assert.ok(s.project.path, `${s.key} has no project`);
      }
      const keys = r.sessions.map((s) => s.key);
      assert.equal(new Set(keys).size, keys.length, "duplicate session keys");
    });

    it("matches the snapshot", () => {
      const r = results.get(adapter.id)!;
      const got = sortProjections(r.sessions.map(project));
      actual[adapter.id] = got;
      if (UPDATE) return;
      assert.ok(adapter.id in snapshot, `no snapshot for ${adapter.id}; run UPDATE_SNAPSHOTS=1 npm test`);
      assert.deepEqual(got, snapshot[adapter.id]);
    });

    it("loads every scanned session back to a full transcript", async () => {
      const r = results.get(adapter.id)!;
      for (const s of r.sessions) await loadRoundTrip(adapter, s);
    });
  });
}

describe("registry", () => {
  it("covers every tool exactly once", () => {
    const ids = ADAPTERS.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const required of ["copilot-cli", "copilot-desktop", "vscode-copilot", "opencode", "codex", "cursor", "grok-build", "claude-code", "pi", "kimi", "deepseek-harness", "trae", "workbuddy", "minimax", "zcode"]) {
      assert.ok(ids.includes(required as (typeof ids)[number]), `missing adapter ${required}`);
    }
  });

  it("never attributes one source session to two tools", () => {
    const owners = new Map<string, string[]>();
    for (const [tool, r] of results) {
      for (const s of r.sessions) {
        const id = `${s.source.kind}:${s.source.path}:${s.source.locator ?? s.nativeId}`;
        owners.set(id, [...(owners.get(id) ?? []), tool]);
      }
    }
    const dupes = [...owners].filter(([, tools]) => tools.length > 1);
    assert.deepEqual(dupes, []);
  });
});
