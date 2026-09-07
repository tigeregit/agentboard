import Link from "next/link";
import type { Metadata } from "next";
import { IconFolderOff } from "@tabler/icons-react";
import { getEngine } from "@/engine/engine";
import { FilterBar } from "@/components/dashboard/filter-bar";
import { ToolDot } from "@/components/dashboard/tool-badge";
import { TOOL_META } from "@/engine/tool-meta";
import { compact, relTime, shortenPath } from "@/lib/format";
import { href, parseFilters, toSessionQuery } from "@/lib/query";

export const metadata: Metadata = { title: "Projects" };
export const dynamic = "force-dynamic";

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const engine = getEngine();
  await engine.ensureFresh();
  const filters = parseFilters(sp, { range: "all" });
  const q = { ...toSessionQuery(filters), limit: undefined, offset: undefined };
  const projects = engine.projects(q);
  const toolStats = engine.toolStats({ ...q, tools: undefined });
  const maxSessions = Math.max(1, ...projects.map((p) => p.sessionCount));

  // Per-project tool breakdown for the stacked bar (one aggregate query per project is fine at this scale).
  const breakdown = new Map(projects.map((p) => [p.path, engine.toolStats({ ...q, project: p.path }).filter((t) => t.sessionCount > 0)]));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
        <p className="text-sm text-muted-foreground">Working directories grouped across tools. Click a project to see its sessions.</p>
      </div>

      <FilterBar filters={filters} tools={toolStats.map((t) => ({ tool: t.tool, count: t.sessionCount }))} projects={projects.map((p) => ({ id: p.path, label: p.name, count: p.sessionCount }))} showSearch={false} />

      {projects.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
          <IconFolderOff className="size-8 text-muted-foreground" />
          <p className="font-medium">No projects in this range</p>
          <p className="text-sm text-muted-foreground">Widen the time range or rescan your sources.</p>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {projects.map((p) => {
            const tools = breakdown.get(p.path) ?? [];
            return (
              <li key={p.path} className="rounded-xl border bg-card p-4 transition-colors hover:bg-muted/30">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={href("/", { ...filters, project: p.path, range: filters.range })} className="block truncate font-medium hover:underline">
                      {p.name}
                    </Link>
                    <p className="truncate font-mono text-xs text-muted-foreground" title={p.path}>
                      {shortenPath(p.path, 60)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-sm tabular-nums">
                    <div className="font-semibold">{p.sessionCount}</div>
                    <div className="text-xs text-muted-foreground">{compact(p.messageCount)} msgs</div>
                  </div>
                </div>
                <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-muted" style={{ width: `${Math.max(12, (p.sessionCount / maxSessions) * 100)}%` }} aria-hidden>
                  {tools.map((t) => (
                    <span key={t.tool} style={{ width: `${(t.sessionCount / p.sessionCount) * 100}%`, backgroundColor: TOOL_META[t.tool]?.color }} title={`${TOOL_META[t.tool]?.name}: ${t.sessionCount}`} />
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {tools.map((t) => (
                    <Link key={t.tool} href={href("/", { ...filters, project: p.path, tools: [t.tool] })} className="inline-flex items-center gap-1 hover:text-foreground">
                      <ToolDot tool={t.tool} /> {TOOL_META[t.tool]?.short ?? t.tool} <span className="tabular-nums">{t.sessionCount}</span>
                    </Link>
                  ))}
                  <span className="ml-auto">active {relTime(p.lastActivity)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
