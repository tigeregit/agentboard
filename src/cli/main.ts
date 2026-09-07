#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";
import { Engine } from "../engine/engine";
import { isToolId, TOOL_IDS, TOOL_META } from "../engine/registry";
import { summaryToMarkdown, type Period } from "../engine/summary";
import { PART_KINDS, TOOL_CATEGORIES, type PartQuery } from "../engine/parts/types";
import type { SessionQuery, SessionSummary, ToolId } from "../engine/types";
import { parseLooseDate } from "../engine/util/time";
import { parseChatGptExport, parseClaudeExport, parseMarkdownTranscript } from "../engine/webchat/exports";
import { writeImported } from "../engine/webchat/imported";
import { fmtTime, SESSION_HEADER, sessionRows, table, truncate } from "./format";
import { dumpParts, filesTable, hitsBySession, hitsTable, outlineToText, partsTable, sessionHeader } from "./parts-format";
import { currentStatus, DEFAULT_HOST, DEFAULT_PORT, serveForeground, startDaemon, stopDaemon, type ServeOptions, type StatusResult } from "./server";

// node:sqlite prints an ExperimentalWarning on stderr; agents often merge stderr into stdout and it lands inside JSON output.
process.removeAllListeners("warning");

const program = new Command();

program
  .name("agentboard")
  .description("Query the session history of every AI coding agent on this machine. Shares its engine with the agentboard dashboard.")
  .version("0.1.0")
  .option("--index <file>", "index database (default ~/.agentboard/index.db, or $AGENTBOARD_HOME/index.db)")
  .option("--no-auto-scan", "do not refresh the index before querying");

function json(v: unknown) {
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
}

function parseTools(value: string | undefined): ToolId[] | undefined {
  if (!value) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  for (const t of list) {
    if (!isToolId(t)) {
      console.error(`unknown tool "${t}". Known tools: ${TOOL_IDS.join(", ")}`);
      process.exit(2);
    }
  }
  return list as ToolId[];
}

function filterOptions(cmd: Command) {
  return cmd
    .option("-t, --tool <ids>", "comma-separated tool ids (see `agentboard sources`)")
    .option("-p, --project <text>", "project path/name contains")
    .option("--since <date>", "ISO date, YYYY-MM-DD, or relative (7d, 2w, today, yesterday)")
    .option("--until <date>", "exclusive upper bound, same formats")
    .option("-s, --search <text>", "free text over title, prompts, project, model")
    .addOption(new Option("--surface <kind>", "cli | ide | desktop | web").choices(["cli", "ide", "desktop", "web"]));
}

interface FilterOpts {
  tool?: string;
  project?: string;
  since?: string;
  until?: string;
  search?: string;
  surface?: SessionQuery["surface"];
}

function toQuery(o: FilterOpts): SessionQuery {
  return { tools: parseTools(o.tool), project: o.project, since: dateOpt(o.since, "since"), until: dateOpt(o.until, "until"), search: o.search, surface: o.surface };
}

async function withEngine<T>(fn: (engine: Engine) => Promise<T>, opts: { autoScan?: boolean; tools?: ToolId[] } = {}): Promise<T> {
  const globals = program.opts<{ index?: string; autoScan: boolean }>();
  const engine = new Engine(globals.index);
  try {
    if (opts.autoScan !== false && globals.autoScan !== false && process.env.AGENTBOARD_NO_AUTO_SCAN !== "1") {
      await engine.scan({ tools: opts.tools });
    }
    return await fn(engine);
  } finally {
    engine.close();
  }
}

program
  .command("sources")
  .description("show every supported tool, how it is read, whether it is installed, and how many sessions are indexed")
  .option("--json", "machine-readable output")
  .action(async (o: { json?: boolean }) => {
    await withEngine(async (engine) => {
      const sources = await engine.sources();
      if (o.json) return json(sources);
      const rows = sources.map((s) => [
        s.id,
        s.name,
        s.detection.installed ? "yes" : "no",
        String(s.sessionCount),
        s.lastActivity ? fmtTime(s.lastActivity) : "-",
        s.strategies.find((x) => x.status === "implemented")?.kind ?? "-",
        s.lastScan?.warnings.length ? `${s.lastScan.warnings.length} warnings` : "",
      ]);
      console.log(table(rows, ["id", "tool", "found", "sessions", "last activity", "via", ""]));
      const notes = sources.flatMap((s) => (s.detection.notes ?? []).map((n) => `${s.id}: ${n}`));
      if (notes.length) console.log("\n" + notes.map((n) => `• ${n}`).join("\n"));
      console.log(`\nStrategies: api = tool's own query API, native-index = index maintained by the tool, sqlite/file = parse private store, import = official export.\nRun \`agentboard sources --json\` for per-tool strategy details and probed paths.`);
    }, { autoScan: false });
  });

program
  .command("scan")
  .description("refresh the index from all sources (incremental by default)")
  .option("-t, --tool <ids>", "only these tools")
  .option("--full", "ignore fingerprints and re-parse everything")
  .option("--json", "machine-readable report")
  .option("-q, --quiet", "no progress output")
  .action(async (o: { tool?: string; full?: boolean; json?: boolean; quiet?: boolean }) => {
    await withEngine(async (engine) => {
      const reports = await engine.scan({ tools: parseTools(o.tool), full: o.full, log: o.quiet || o.json ? undefined : (m) => console.error(m) });
      if (o.json) return json(reports);
      const rows = reports.map((r) => [r.tool, String(r.upserted), String(r.removed), String(r.partsIndexed), `${r.durationMs}ms`, r.error ? `ERROR ${r.error}` : r.warnings.length ? `${r.warnings.length} warnings` : "ok"]);
      console.log(table(rows, ["tool", "updated", "removed", "parts", "time", "status"]));
      const c = engine.counts();
      const p = engine.partCounts();
      console.log(`\nIndex: ${c.sessions} sessions · ${c.tools} tools · ${c.projects} projects · ${p.parts} parts (${engine.store.file})`);
    }, { autoScan: false });
  });

/** Compact session record for machine consumers; `--full` restores the complete summary (incl. promptText). */
function slimSession(s: SessionSummary) {
  return {
    key: s.key,
    tool: s.tool,
    project: s.project.name,
    projectPath: s.project.path,
    title: s.title,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    turns: s.userMessageCount,
    toolCalls: s.toolCallCount,
    messages: s.messageCount,
    model: s.model,
    parentKey: s.parentKey,
  };
}

function intOpt(v: string, name: string, min = 0): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    console.error(`--${name} must be an integer >= ${min} (got "${v}")`);
    process.exit(2);
  }
  return n;
}

function dateOpt(v: string | undefined, name: string): string | undefined {
  if (v === undefined) return undefined;
  const iso = parseLooseDate(v);
  if (!iso) {
    console.error(`--${name}: cannot parse "${v}" (use ISO, YYYY-MM-DD, today, yesterday, or 7d/2w/1m)`);
    process.exit(2);
  }
  return iso;
}

function listOpt<T extends string>(v: string | undefined, allowed: readonly T[], name: string): T[] | undefined {
  if (!v) return undefined;
  const items = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const it of items) {
    if (!allowed.includes(it as T)) {
      console.error(`--${name}: unknown value "${it}". Allowed: ${allowed.join(", ")}`);
      process.exit(2);
    }
  }
  return items as T[];
}

function rangeOpt(v: string | undefined, name: string): [number, number] | undefined {
  if (v === undefined) return undefined;
  const m = v.match(/^(\d+)(?::(\d*))?$/);
  if (!m) {
    console.error(`--${name}: expected N or A:B (got "${v}")`);
    process.exit(2);
  }
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : m[2] === "" ? Number.MAX_SAFE_INTEGER : Number(m[2]);
  return [a, b];
}

filterOptions(program.command("list").alias("ls").description("list sessions, newest first"))
  .option("-n, --limit <n>", "max rows", "50")
  .option("--offset <n>", "skip rows", "0")
  .option("--asc", "oldest first")
  .option("--json", "machine-readable output ({ total, items }); compact records unless --full")
  .option("--full", "with --json: complete session summaries including promptText")
  .option("--keys", "print only session keys, one per line")
  .action(async (o: FilterOpts & { limit: string; offset: string; asc?: boolean; json?: boolean; full?: boolean; keys?: boolean }) => {
    const q = { ...toQuery(o), limit: intOpt(o.limit, "limit", 1), offset: intOpt(o.offset, "offset"), order: o.asc ? ("asc" as const) : ("desc" as const) };
    await withEngine(async (engine) => {
      const { items, total } = engine.list(q);
      if (o.json) return json({ total, items: o.full ? items : items.map(slimSession) });
      if (o.keys) return console.log(items.map((s) => s.key).join("\n"));
      if (!items.length) return console.log("No sessions match. Run `agentboard sources` to check what was detected.");
      console.log(table(sessionRows(items), SESSION_HEADER));
      if (total > items.length) console.log(`\n${items.length} of ${total} shown (use --limit/--offset)`);
    }, { tools: q.tools });
  });

filterOptions(program.command("search <terms...>").description("find sessions by title / prompts / project (session level; use `grep` for transcript contents)"))
  .option("-n, --limit <n>", "max rows", "50")
  .option("--json", "machine-readable output (compact records unless --full)")
  .option("--full", "with --json: complete session summaries")
  .action(async (terms: string[], o: FilterOpts & { limit: string; json?: boolean; full?: boolean }) => {
    const q = { ...toQuery({ ...o, search: terms.join(" ") }), limit: intOpt(o.limit, "limit", 1) };
    await withEngine(async (engine) => {
      const { items, total } = engine.list(q);
      if (o.json) return json({ total, items: o.full ? items : items.map(slimSession) });
      if (!items.length) return console.log("No matches.");
      console.log(table(sessionRows(items), SESSION_HEADER));
      if (total > items.length) console.log(`\n${items.length} of ${total} shown`);
    }, { tools: q.tools });
  });

interface PartFilterOpts {
  kind?: string;
  category?: string;
  toolName?: string;
  file?: string;
  grep?: string;
  errors?: boolean;
}

function partFilterOptions(cmd: Command) {
  return cmd
    .option("-k, --kind <kinds>", `comma-separated part kinds: ${PART_KINDS.join(",")}`)
    .option("-c, --category <cats>", `comma-separated tool categories: ${TOOL_CATEGORIES.join(",")}`)
    .option("--tool-name <name>", "exact tool name as the agent calls it (Bash, exec_command, edit_file_v2, ...)")
    .option("--file <text>", "parts touching a file whose path contains text")
    .option("--errors", "only failed tool results");
}

partFilterOptions(
  program
    .command("show <key>")
    .description("one session: outline of turns by default; --turn / --seq / --parts / --full for transcript parts")
    .option("--turn <n|a:b>", "dump every part of these turns")
    .option("--seq <n|a:b>", "dump parts by sequence number (a: = to the end)")
    .option("--parts", "table of parts (one row each) instead of a dump; combine with filters")
    .option("--full", "dump every part (old transcript view, still budget-limited)")
    .option("--files", "files touched in this session")
    .option("--summary", "metadata only")
    .option("--grep <text>", "filter parts whose text contains text")
    .option("--max-chars <n>", "cap per part when dumping", "2000")
    .option("--budget <n>", "cap total dump size in chars; prints how to continue", "24000")
    .option("--json", "machine-readable output"),
).action(async (key: string, o: PartFilterOpts & { turn?: string; seq?: string; parts?: boolean; full?: boolean; files?: boolean; summary?: boolean; maxChars: string; budget: string; json?: boolean }) => {
  const kinds = listOpt(o.kind, PART_KINDS, "kind");
  const categories = listOpt(o.category, TOOL_CATEGORIES, "category");
  const turns = rangeOpt(o.turn, "turn");
  const seqs = rangeOpt(o.seq, "seq");
  const maxChars = intOpt(o.maxChars, "max-chars", 1);
  const budget = intOpt(o.budget, "budget", 1);
  const hasFilter = !!(kinds || categories || o.toolName || o.file || o.grep || o.errors);
  await withEngine(async (engine) => {
    const summary = engine.getSummary(key);
    if (!summary) {
      console.error(`no session matches "${key}"`);
      process.exit(1);
    }
    const children = engine.children(summary.key);
    if (o.summary) return o.json ? json({ ...slimSession(summary), source: summary.source, gitBranch: summary.gitBranch, children: children.map((c) => c.key) }) : console.log(sessionHeader(summary).join("\n"));

    const filter = { kinds, categories, toolName: o.toolName, file: o.file, text: o.grep, onlyErrors: o.errors, turns, seqs };
    const dumpMode = !!(turns || seqs || o.full || o.parts || hasFilter);
    if (o.files) {
      const files = engine.files({ sessionKey: summary.key, file: o.file, limit: 500 });
      return o.json ? json(files) : console.log(filesTable(files));
    }
    if (!dumpMode) {
      const outline = await engine.outline(summary.key);
      if (!outline) {
        console.error(`session ${summary.key} is indexed but its source could not be re-read (${summary.source.path})`);
        process.exit(1);
      }
      const meta = engine.store.parts.meta(summary.key);
      if (o.json)
        return json({
          ...slimSession(summary),
          fidelity: meta?.fidelity,
          children: children.map((c) => c.key),
          outline: {
            ...outline,
            files: outline.files.slice(0, 50),
            turns: outline.turns.map((t) => ({ ...t, prompt: t.prompt.slice(0, 500), reply: t.reply.slice(0, 500), files: t.files.slice(0, 20), commands: t.commands.slice(0, 10).map((c) => c.slice(0, 200)) })),
          },
        });
      console.log(outlineToText(summary, outline, { fidelity: meta?.fidelity }));
      if (children.length) console.log(`\nSubagents / forks: ${children.map((c) => c.key).join(", ")}`);
      return;
    }
    const parts = await engine.parts(summary.key, filter);
    if (o.json) return json({ key: summary.key, total: parts.length, parts: parts.map((p) => ({ ...p, text: o.full ? p.text : p.text.slice(0, maxChars) })) });
    if (!parts.length) return console.log("No parts match.");
    if (o.parts) {
      console.log(partsTable(parts, summary.startedAt));
      console.log(`\n${parts.length} parts · dump with \`show ${summary.key} --seq a:b\``);
      return;
    }
    console.log(sessionHeader(summary).join("\n") + "\n");
    console.log(dumpParts(parts, { maxChars, budget, key: summary.key, dayRef: summary.startedAt }));
  }, { autoScan: false });
});

filterOptions(partFilterOptions(program.command("grep <query...>").description("search inside transcripts across sessions: returns matching parts with snippets")))
  .option("--session <key>", "restrict to one session")
  .option("--role <role>", "user | assistant | tool | system")
  .option("-n, --limit <n>", "max hits", "20")
  .option("--offset <n>", "skip hits", "0")
  .option("--asc", "oldest first")
  .option("--by-session", "aggregate hits per session")
  .option("--width <n>", "snippet width in text mode", "140")
  .option("--json", "machine-readable output ({ total, hits })")
  .action(async (query: string[], o: FilterOpts & PartFilterOpts & { session?: string; role?: string; limit: string; offset: string; asc?: boolean; bySession?: boolean; width: string; json?: boolean }) => {
    const q: PartQuery = {
      text: query.join(" "),
      kinds: listOpt(o.kind, PART_KINDS, "kind"),
      categories: listOpt(o.category, TOOL_CATEGORIES, "category"),
      toolName: o.toolName,
      file: o.file,
      sessionKey: o.session,
      role: o.role as PartQuery["role"],
      onlyErrors: o.errors,
      tools: parseTools(o.tool),
      project: o.project,
      since: dateOpt(o.since, "since"),
      until: dateOpt(o.until, "until"),
      limit: o.bySession ? 500 : intOpt(o.limit, "limit", 1),
      offset: intOpt(o.offset, "offset"),
      order: o.asc ? "asc" : "desc",
    };
    await withEngine(async (engine) => {
      const { hits, total } = engine.grep(q);
      if (o.json) return json({ total, hits });
      if (!hits.length) return console.log("No matches.");
      if (o.bySession) {
        console.log(hitsBySession(hits));
        console.log(`\n${total} hits in ${new Set(hits.map((h) => h.sessionKey)).size} sessions${total > hits.length ? ` (first ${hits.length} aggregated)` : ""}`);
        return;
      }
      console.log(hitsTable(hits, intOpt(o.width, "width", 20)));
      const shown = hits.length;
      console.log(`\n${shown} of ${total} hits${total > shown ? ` (--offset ${q.offset! + shown} for more, --by-session to aggregate)` : ""} · open one: \`show <session> --seq <seq>\` or \`--turn <turn>\``);
    }, { tools: q.tools as ToolId[] | undefined });
  });

filterOptions(program.command("files").description("files touched by agents (edits / reads) across sessions"))
  .option("--session <key>", "restrict to one session")
  .option("--file <text>", "path contains text")
  .option("-n, --limit <n>", "max rows", "50")
  .option("--json", "machine-readable output")
  .action(async (o: FilterOpts & { session?: string; file?: string; limit: string; json?: boolean }) => {
    await withEngine(async (engine) => {
      const files = engine.files({ tools: parseTools(o.tool), project: o.project, since: dateOpt(o.since, "since"), until: dateOpt(o.until, "until"), sessionKey: o.session, file: o.file, limit: intOpt(o.limit, "limit", 1) });
      if (o.json) return json(files);
      if (!files.length) return console.log("No file activity indexed.");
      console.log(filesTable(files));
    }, { tools: parseTools(o.tool) });
  });

filterOptions(program.command("projects").description("projects with session counts"))
  .option("--json", "machine-readable output")
  .action(async (o: FilterOpts & { json?: boolean }) => {
    const q = toQuery(o);
    await withEngine(async (engine) => {
      const projects = engine.projects(q);
      if (o.json) return json(projects);
      const rows = projects.map((p) => [truncate(p.name, 28), String(p.sessionCount), String(p.messageCount), fmtTime(p.lastActivity), p.tools.map((t) => TOOL_META[t]?.short ?? t).join(","), truncate(p.path, 60)]);
      console.log(table(rows, ["project", "sessions", "msgs", "last activity", "tools", "path"]));
    }, { tools: q.tools });
  });

filterOptions(program.command("tools").description("per-tool session counts"))
  .option("--json", "machine-readable output")
  .action(async (o: FilterOpts & { json?: boolean }) => {
    const q = toQuery(o);
    await withEngine(async (engine) => {
      const stats = engine.toolStats(q);
      if (o.json) return json(stats);
      console.log(table(stats.map((s) => [s.tool, TOOL_META[s.tool]?.name ?? s.tool, String(s.sessionCount), String(s.messageCount), s.lastActivity ? fmtTime(s.lastActivity) : "-"]), ["id", "tool", "sessions", "msgs", "last activity"]));
    }, { tools: q.tools });
  });

program
  .command("summary")
  .description("daily / weekly / monthly activity summary (for reports and automation)")
  .addOption(new Option("--period <p>", "day | week | month").choices(["day", "week", "month"]).default("day"))
  .option("--date <date>", "anchor date inside the period (default today)")
  .option("-t, --tool <ids>", "only these tools")
  .option("-p, --project <text>", "project path/name contains")
  .option("--json", "structured summary")
  .option("--prompts", "include the first prompt of each session in the markdown")
  .action(async (o: { period: Period; date?: string; tool?: string; project?: string; json?: boolean; prompts?: boolean }) => {
    const anchorIso = parseLooseDate(o.date);
    const anchor = anchorIso ? new Date(anchorIso) : new Date();
    const tools = parseTools(o.tool);
    await withEngine(async (engine) => {
      const s = engine.periodSummary(o.period, anchor, { tools, project: o.project });
      if (o.json) return json(s);
      console.log(summaryToMarkdown(s, { includePrompts: o.prompts }));
    }, { tools });
  });

program
  .command("import <kind> <file>")
  .description("import an official export: chatgpt | claude-web (conversations.json) | markdown (any chat export, use --tool)")
  .option("--tool <id>", "tool id to attribute a markdown import to (e.g. trae, vscode-copilot)", "trae")
  .option("--project <path>", "project path to attribute a markdown import to")
  .option("--title <text>", "title override for markdown import")
  .action(async (kind: string, file: string, o: { tool: string; project?: string; title?: string }) => {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) {
      console.error(`file not found: ${abs}`);
      process.exit(1);
    }
    let details;
    if (kind === "chatgpt") details = parseChatGptExport(JSON.parse(fs.readFileSync(abs, "utf8")), abs);
    else if (kind === "claude-web" || kind === "claude") details = parseClaudeExport(JSON.parse(fs.readFileSync(abs, "utf8")), abs);
    else if (kind === "markdown" || kind === "md") {
      if (!isToolId(o.tool)) {
        console.error(`unknown tool "${o.tool}"`);
        process.exit(2);
      }
      const d = parseMarkdownTranscript(fs.readFileSync(abs, "utf8"), { tool: o.tool, sourcePath: abs, project: o.project, title: o.title });
      details = d ? [d] : [];
    } else {
      console.error(`unknown import kind "${kind}" (chatgpt | claude-web | markdown)`);
      process.exit(2);
    }
    for (const d of details) writeImported(d);
    console.log(`imported ${details.length} session(s) from ${abs}`);
    if (details.length) {
      await withEngine(async (engine) => {
        await engine.scan({ tools: [details![0].tool] });
        console.log(`indexed under tool "${details![0].tool}". Try: agentboard list -t ${details![0].tool}`);
      }, { autoScan: false });
    }
  });

// ---------- dashboard server ----------

interface ServeOpts {
  port: string;
  host: string;
  dev?: boolean;
  build?: boolean;
  json?: boolean;
}

function serveOptions(o: ServeOpts): ServeOptions {
  const port = Number(o.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`invalid port "${o.port}"`);
    process.exit(2);
  }
  return { port, host: o.host, dev: !!o.dev, build: !!o.build };
}

function serverFlags(cmd: Command) {
  return cmd
    .option("-p, --port <n>", "port to listen on", process.env.AGENTBOARD_PORT || String(DEFAULT_PORT))
    .option("-H, --host <addr>", "address to bind (0.0.0.0 for LAN access)", process.env.AGENTBOARD_HOST || DEFAULT_HOST)
    .option("--dev", "run `next dev` instead of the production build")
    .option("--build", "rebuild the dashboard before starting");
}

function printStatus(s: StatusResult) {
  if (!s.state) {
    console.log("agentboard server: not running");
    return;
  }
  if (!s.running) {
    console.log(`agentboard server: not running (stale state file for pid ${s.state.pid}, started ${s.state.startedAt}; run \`agentboard server start\`)`);
    return;
  }
  const h = s.health;
  console.log(`agentboard server: running${h ? "" : " (process alive, HTTP not answering yet)"}`);
  console.log(table(
    [
      ["url", s.state.url],
      ["pid", String(s.state.pid)],
      ["mode", s.state.dev ? "dev" : "production"],
      ["started", fmtTime(s.state.startedAt)],
      ["uptime", h?.uptimeSeconds !== undefined ? `${Math.floor(h.uptimeSeconds / 3600)}h ${Math.floor((h.uptimeSeconds % 3600) / 60)}m` : "-"],
      ["index", h?.counts ? `${h.counts.sessions} sessions · ${h.counts.tools} tools · ${h.counts.projects} projects` : "-"],
      ["last scan", h?.lastScan ? `${fmtTime(h.lastScan)}${h.scanning ? " (scanning now)" : ""}` : "-"],
      ["auto-refresh", h?.autoScanSeconds !== undefined ? (h.autoScanSeconds > 0 ? `every ${h.autoScanSeconds}s` : "off") : "-"],
      ["log", s.state.log],
    ],
    ["field", "value"],
  ));
}

serverFlags(
  program
    .command("serve")
    .description("run the web dashboard in the foreground (blocks until Ctrl-C); the index refreshes itself while it runs"),
).action(async (o: ServeOpts) => {
  const code = await serveForeground(serveOptions(o));
  process.exit(code);
});

const server = program.command("server").description("manage the dashboard as a background service: start | stop | status | restart");

serverFlags(server.command("start").description("start the dashboard in the background")).option("--json", "machine-readable output").action(async (o: ServeOpts) => {
  const r = await startDaemon(serveOptions(o));
  if (o.json) return json({ status: r.status, ...r.state, health: r.health });
  if (r.status === "already-running") console.log(`already running at ${r.state.url} (pid ${r.state.pid}); use \`agentboard server restart\` to restart`);
  else console.log(`started at ${r.state.url} (pid ${r.state.pid}, log ${r.state.log})`);
});

server
  .command("stop")
  .description("stop the background dashboard")
  .option("--json", "machine-readable output")
  .action(async (o: { json?: boolean }) => {
    const r = await stopDaemon();
    if (o.json) return json(r);
    if (r.status === "not-running") console.log("agentboard server: not running");
    else console.log(`${r.status === "killed" ? "killed" : "stopped"} pid ${r.state!.pid} (${r.state!.url})`);
  });

server
  .command("status")
  .description("show whether the background dashboard is running, its URL and index state (exit code 0 running / 3 stopped)")
  .option("--json", "machine-readable output")
  .action(async (o: { json?: boolean }) => {
    const s = await currentStatus();
    if (o.json) json({ running: s.running, stale: s.stale, ...(s.state ?? {}), health: s.health });
    else printStatus(s);
    process.exitCode = s.running ? 0 : 3;
  });

serverFlags(server.command("restart").description("stop (if running) and start again; keeps the previous port/host unless overridden")).option("--json", "machine-readable output").action(async (o: ServeOpts, cmd: Command) => {
  const prev = await stopDaemon();
  const opts = serveOptions(o);
  // Flags not given explicitly inherit the previous run's settings.
  if (prev.state) {
    if (cmd.getOptionValueSource("port") === "default") opts.port = prev.state.port;
    if (cmd.getOptionValueSource("host") === "default") opts.host = prev.state.host;
    if (cmd.getOptionValueSource("dev") === undefined) opts.dev = prev.state.dev;
  }
  const r = await startDaemon(opts);
  if (o.json) return json({ previous: prev.status, status: r.status, ...r.state, health: r.health });
  console.log(`${prev.status === "not-running" ? "was not running; " : ""}started at ${r.state.url} (pid ${r.state.pid})`);
});

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
