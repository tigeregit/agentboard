import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScanContext, SessionSummary } from "../../src/engine/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A ScanContext that never treats anything as fresh, so every fixture is parsed. */
export function fullScanContext(): ScanContext {
  return { isFresh: () => false, full: true, memo: new Map() };
}

/** Isolated fake $HOME; every adapter resolves its stores under it via AGENTBOARD_FAKE_HOME. */
export function makeFakeHome(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agentboard-test-${label}-`));
  process.env.AGENTBOARD_FAKE_HOME = dir;
  process.env.AGENTBOARD_HOME = path.join(dir, ".agentboard");
  return dir;
}

export function removeDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Populate `home` with the synthetic multi-tool dataset from scripts/demo-data.ts.
 * Runs in a child process because the script writes on import.
 */
export function generateDemoHome(home: string) {
  execFileSync(process.execPath, ["--import", "tsx", path.join(ROOT, "scripts", "demo-data.ts")], {
    cwd: ROOT,
    env: { ...process.env, AGENTBOARD_FAKE_HOME: home },
    stdio: "pipe",
  });
}

export function write(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Stable, time-independent projection of a session used for snapshot comparison. */
export function project(s: SessionSummary) {
  return {
    tool: s.tool,
    surface: s.surface,
    source: s.source.kind,
    title: s.title,
    project: s.project.name,
    messages: s.messageCount,
    user: s.userMessageCount,
    assistant: s.assistantMessageCount,
    toolCalls: s.toolCallCount,
    model: s.model ?? null,
    branch: s.gitBranch ?? null,
    firstPrompt: s.firstPrompt.slice(0, 60),
  };
}

export type Projection = ReturnType<typeof project>;

export function sortProjections(list: Projection[]): Projection[] {
  const key = (p: Projection) => [p.tool, p.surface, p.source, p.project, p.title, p.messages, p.firstPrompt].join("\u0000");
  return [...list].sort((a, b) => key(a).localeCompare(key(b)));
}
