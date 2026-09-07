import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentboardHome } from "../engine/util/paths";

/**
 * Runs the dashboard (the Next.js app in this repo) from the CLI.
 *
 *  - `agentboard serve`            foreground: blocks until Ctrl-C, logs to the terminal
 *  - `agentboard server start`     background daemon; pid/port recorded in ~/.agentboard/server.json,
 *                                  output appended to ~/.agentboard/server.log
 *  - `agentboard server stop|status|restart`
 *
 * Production mode (`next start`) needs a build; `serve`/`start` build on first
 * use (or with --build). `--dev` runs `next dev` instead, for hacking on the UI.
 */

export const DEFAULT_PORT = 4817;
export const DEFAULT_HOST = "127.0.0.1";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ServeOptions {
  port: number;
  host: string;
  dev?: boolean;
  build?: boolean;
}

export interface ServerState {
  pid: number;
  port: number;
  host: string;
  url: string;
  dev: boolean;
  startedAt: string;
  log: string;
  indexHome: string;
}

function stateFile() {
  return path.join(agentboardHome(), "server.json");
}
export function logFile() {
  return path.join(agentboardHome(), "server.log");
}

function nextBin(): string {
  return require.resolve("next/dist/bin/next");
}

export function urlFor(host: string, port: number): string {
  const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${h.includes(":") ? `[${h}]` : h}:${port}`;
}

function isBuilt(): boolean {
  return fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"));
}

/** `next build` in the foreground; throws when it fails. */
export function build(log: (m: string) => void = console.error): void {
  log("building the dashboard (first run, takes a minute)…");
  const r = spawnSync(process.execPath, [nextBin(), "build"], { cwd: ROOT, stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error(`next build failed with exit code ${r.status ?? "unknown"}`);
}

function ensureBuilt(opts: ServeOptions, log: (m: string) => void) {
  if (opts.dev) return;
  if (opts.build || !isBuilt()) build(log);
}

function nextArgs(opts: ServeOptions): string[] {
  return [nextBin(), opts.dev ? "dev" : "start", "-p", String(opts.port), "-H", opts.host];
}

/** Foreground server: inherits the terminal, resolves with the exit code when it stops. */
export async function serveForeground(opts: ServeOptions, log: (m: string) => void = console.error): Promise<number> {
  ensureBuilt(opts, log);
  log(`agentboard dashboard → ${urlFor(opts.host, opts.port)}  (Ctrl-C to stop)`);
  const child = spawn(process.execPath, nextArgs(opts), { cwd: ROOT, stdio: "inherit", env: { ...process.env, PORT: String(opts.port), HOSTNAME: opts.host } });
  const forward = (sig: NodeJS.Signals) => () => {
    if (!child.killed) child.kill(sig);
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  return new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? (signal ? 130 : 0))));
}

export function readState(): ServerState | null {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as ServerState;
    return typeof s.pid === "number" && typeof s.port === "number" ? s : null;
  } catch {
    return null;
  }
}

function clearState() {
  fs.rmSync(stateFile(), { force: true });
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface HealthInfo {
  counts?: { sessions: number; tools: number; projects: number };
  lastScan?: string | null;
  scanning?: boolean;
  autoScanSeconds?: number;
  uptimeSeconds?: number;
  pid?: number;
}

/** Probe /api/stats; null when the server is not answering. */
export async function probe(url: string, timeoutMs = 2000): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`${url}/api/stats`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as HealthInfo;
  } catch {
    return null;
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function tailLog(lines = 20): string {
  try {
    const text = fs.readFileSync(logFile(), "utf8");
    return text.split("\n").filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export type StartResult = { status: "started" | "already-running"; state: ServerState; health: HealthInfo | null };

/** Detach a server process and wait until it answers HTTP (or dies). */
export async function startDaemon(opts: ServeOptions, log: (m: string) => void = console.error): Promise<StartResult> {
  const existing = await currentStatus();
  if (existing.running && existing.state) return { status: "already-running", state: existing.state, health: existing.health };
  if (existing.state) clearState();

  ensureBuilt(opts, log);
  fs.mkdirSync(agentboardHome(), { recursive: true });
  const out = fs.openSync(logFile(), "a");
  fs.writeSync(out, `\n[${new Date().toISOString()}] agentboard server start ${opts.dev ? "(dev) " : ""}on ${urlFor(opts.host, opts.port)}\n`);
  const child = spawn(process.execPath, nextArgs(opts), {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, PORT: String(opts.port), HOSTNAME: opts.host },
  });
  fs.closeSync(out);
  if (!child.pid) throw new Error("failed to spawn the server process");
  child.unref();

  const state: ServerState = {
    pid: child.pid,
    port: opts.port,
    host: opts.host,
    url: urlFor(opts.host, opts.port),
    dev: !!opts.dev,
    startedAt: new Date().toISOString(),
    log: logFile(),
    indexHome: agentboardHome(),
  };
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2) + "\n");

  const deadline = Date.now() + (opts.dev ? 90_000 : 30_000);
  while (Date.now() < deadline) {
    const health = await probe(state.url, 1500);
    if (health) return { status: "started", state, health };
    if (!processAlive(child.pid)) {
      clearState();
      throw new Error(`server exited during startup. Last log lines (${logFile()}):\n${tailLog()}`);
    }
    await sleep(300);
  }
  throw new Error(`server did not answer on ${state.url} within the startup timeout; it is still running as pid ${child.pid} (see ${logFile()})`);
}

/** Kill the process group started by startDaemon (falls back to the pid alone). */
function terminate(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* not a group leader (Windows, or already gone) */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

export type StopResult = { status: "stopped" | "not-running" | "killed"; state: ServerState | null };

export async function stopDaemon(timeoutMs = 10_000): Promise<StopResult> {
  const state = readState();
  if (!state) return { status: "not-running", state: null };
  if (!processAlive(state.pid)) {
    clearState();
    return { status: "not-running", state };
  }
  terminate(state.pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(state.pid)) {
      clearState();
      return { status: "stopped", state };
    }
    await sleep(200);
  }
  terminate(state.pid, "SIGKILL");
  await sleep(300);
  clearState();
  return { status: "killed", state };
}

export interface StatusResult {
  running: boolean;
  state: ServerState | null;
  health: HealthInfo | null;
  /** State file exists but the process is gone (crashed or killed externally). */
  stale: boolean;
}

export async function currentStatus(): Promise<StatusResult> {
  const state = readState();
  if (!state) return { running: false, state: null, health: null, stale: false };
  const alive = processAlive(state.pid);
  const health = alive ? await probe(state.url) : null;
  return { running: alive, state, health, stale: !alive };
}

export function stateRoot(): string {
  return ROOT;
}
