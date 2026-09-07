import Link from "next/link";
import { IconDatabaseOff, IconFilterOff } from "@tabler/icons-react";
import { getEngine } from "@/engine/engine";
import { ActivityChart } from "@/components/dashboard/activity-chart";
import { FilterBar } from "@/components/dashboard/filter-bar";
import { Pagination } from "@/components/dashboard/pagination";
import { ScanButton } from "@/components/dashboard/scan-button";
import { SessionTable } from "@/components/dashboard/session-table";
import { StatCard } from "@/components/dashboard/stat-card";
import { Button } from "@/components/ui/button";
import { compact, relTime } from "@/lib/format";
import { href, parseFilters, RANGE_PRESETS, toSessionQuery } from "@/lib/query";

export const dynamic = "force-dynamic";

export default async function OverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const engine = getEngine();

  // First visit on a fresh index: build it right away instead of showing an empty board.
  if (engine.store.lastRuns().length === 0) await engine.scan();

  const filters = parseFilters(sp, { range: "30d", pageSize: 40 });
  const q = toSessionQuery(filters);
  const aggQ = { ...q, limit: undefined, offset: undefined };

  const { total, items } = engine.list(q);
  const days = engine.days(aggQ);
  const toolStats = engine.toolStats({ ...aggQ, tools: undefined });
  const projectStats = engine.projects({ ...aggQ, project: undefined });
  const counts = engine.counts();
  const lastScan = engine.store.lastRuns().map((r) => r.finishedAt).sort().at(-1);

  const inRange = engine.toolStats(aggQ);
  const sessionsInRange = inRange.reduce((n, s) => n + s.sessionCount, 0);
  const messagesInRange = inRange.reduce((n, s) => n + s.messageCount, 0);
  const projectsInRange = engine.projects(aggQ).length;
  const rangeLabel = RANGE_PRESETS.find((p) => p.id === filters.range)?.label ?? "range";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sessions</h1>
          <p className="text-sm text-muted-foreground">
            {compact(counts.sessions)} sessions indexed from {counts.tools} tools · last scan {relTime(lastScan)}
          </p>
        </div>
      </div>

      {counts.sessions === 0 ? (
        <EmptyIndex />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label={`Sessions · ${rangeLabel}`} value={compact(sessionsInRange)} hint={`${compact(counts.sessions)} all time`} />
            <StatCard label="Messages" value={compact(messagesInRange)} hint="user + assistant + tool" />
            <StatCard label="Tools active" value={inRange.length} hint={`${counts.tools} with any history`} />
            <StatCard label="Projects" value={projectsInRange} hint={`${counts.projects} all time`} />
          </div>

          <section className="rounded-xl border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">Activity</h2>
              <span className="text-xs text-muted-foreground">sessions per day, by tool</span>
            </div>
            <ActivityChart days={days} since={filters.since} until={filters.until} />
          </section>

          <FilterBar filters={filters} tools={toolStats.map((t) => ({ tool: t.tool, count: t.sessionCount }))} projects={projectStats.map((p) => ({ id: p.path, label: p.name, count: p.sessionCount }))} />

          {items.length ? (
            <>
              <SessionTable items={items} filters={filters} />
              <Pagination pathname="/" filters={filters} total={total} />
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
              <IconFilterOff className="size-8 text-muted-foreground" />
              <p className="font-medium">No sessions match these filters</p>
              <p className="max-w-md text-sm text-muted-foreground">Try a wider time range or clear the tool / project filter. The index has {compact(counts.sessions)} sessions in total.</p>
              <Button asChild variant="outline" size="sm">
                <Link href={href("/", { range: "all" })}>Show all time</Link>
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EmptyIndex() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center">
      <IconDatabaseOff className="size-10 text-muted-foreground" />
      <div>
        <p className="text-lg font-medium">Nothing indexed yet</p>
        <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
          agentboard reads the local history of Claude Code, Codex, Cursor, Copilot, OpenCode, Grok Build, pi, Kimi, DeepSeek Harness, Trae, WorkBuddy, MiniMax and ZCode. Run a scan to
          build the index, or check the <Link href="/sources" className="underline">Sources</Link> page to see what was detected on this machine.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <ScanButton label="Scan now" variant="default" size="default" />
        <Button asChild variant="outline">
          <Link href="/sources">View sources</Link>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        No agents on this machine? Try <code className="rounded bg-muted px-1 py-0.5">npm run demo</code> and restart with <code className="rounded bg-muted px-1 py-0.5">AGENTBOARD_FAKE_HOME</code> set.
      </p>
    </div>
  );
}
