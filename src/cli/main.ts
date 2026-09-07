#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";
import { Engine } from "../engine/engine";
import { isToolId, TOOL_IDS, TOOL_META } from "../engine/registry";
import { summaryToMarkdown, type Period } from "../engine/summary";
import type { SessionQuery, ToolId } from "../engine/types";
import { parseLooseDate } from "../engine/util/time";
import { parseChatGptExport, parseClaudeExport, parseMarkdownTranscript } from "../engine/webchat/exports";
import { writeImported } from "../engine/webchat/imported";
import { detailToMarkdown, fmtTime, SESSION_HEADER, sessionRows, table, truncate } from "./format";

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
  return { tools: parseTools(o.tool), project: o.project, since: parseLooseDate(o.since), until: parseLooseDate(o.until), search: o.search, surface: o.surface };
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
      const rows = reports.map((r) => [r.tool, String(r.upserted), String(r.removed), `${r.durationMs}ms`, r.error ? `ERROR ${r.error}` : r.warnings.length ? `${r.warnings.length} warnings` : "ok"]);
      console.log(table(rows, ["tool", "updated", "removed", "time", "status"]));
      const c = engine.counts();
      console.log(`\nIndex: ${c.sessions} sessions · ${c.tools} tools · ${c.projects} projects (${engine.store.file})`);
    }, { autoScan: false });
  });

filterOptions(program.command("list").alias("ls").description("list sessions, newest first"))
  .option("-n, --limit <n>", "max rows", "50")
  .option("--offset <n>", "skip rows", "0")
  .option("--asc", "oldest first")
  .option("--json", "machine-readable output (array of session summaries)")
  .option("--keys", "print only session keys, one per line")
  .action(async (o: FilterOpts & { limit: string; offset: string; asc?: boolean; json?: boolean; keys?: boolean }) => {
    const q = { ...toQuery(o), limit: Number(o.limit), offset: Number(o.offset), order: o.asc ? ("asc" as const) : ("desc" as const) };
    await withEngine(async (engine) => {
      const { items, total } = engine.list(q);
      if (o.json) return json({ total, items });
      if (o.keys) return console.log(items.map((s) => s.key).join("\n"));
      if (!items.length) return console.log("No sessions match. Run `agentboard sources` to check what was detected.");
      console.log(table(sessionRows(items), SESSION_HEADER));
      if (total > items.length) console.log(`\n${items.length} of ${total} shown (use --limit/--offset)`);
    }, { tools: q.tools });
  });

filterOptions(program.command("search <terms...>").description("full-text search over titles, prompts and projects"))
  .option("-n, --limit <n>", "max rows", "50")
  .option("--json", "machine-readable output")
  .action(async (terms: string[], o: FilterOpts & { limit: string; json?: boolean }) => {
    const q = { ...toQuery({ ...o, search: terms.join(" ") }), limit: Number(o.limit) };
    await withEngine(async (engine) => {
      const { items, total } = engine.list(q);
      if (o.json) return json({ total, items });
      if (!items.length) return console.log("No matches.");
      console.log(table(sessionRows(items), SESSION_HEADER));
      if (total > items.length) console.log(`\n${items.length} of ${total} shown`);
    }, { tools: q.tools });
  });

program
  .command("show <key>")
  .description("print one session's transcript (key or unique prefix of a native id)")
  .option("--json", "full session detail as JSON")
  .option("--max-chars <n>", "truncate each message to n characters (markdown output)", "4000")
  .option("--summary", "metadata only, no transcript")
  .action(async (key: string, o: { json?: boolean; maxChars: string; summary?: boolean }) => {
    await withEngine(async (engine) => {
      const summary = engine.getSummary(key);
      if (!summary) {
        console.error(`no session matches "${key}"`);
        process.exit(1);
      }
      if (o.summary) return o.json ? json(summary) : console.log(detailToMarkdown({ ...summary, messages: [] }));
      const detail = await engine.getDetail(summary.key);
      if (!detail) {
        console.error(`session ${summary.key} is indexed but its source could not be re-read (${summary.source.path})`);
        process.exit(1);
      }
      const children = engine.children(summary.key);
      if (o.json) return json({ ...detail, children: children.map((c) => c.key) });
      console.log(detailToMarkdown(detail, { maxChars: Number(o.maxChars) }));
      if (children.length) console.log(`\nSubagents / forks: ${children.map((c) => c.key).join(", ")}`);
    }, { autoScan: false });
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

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
