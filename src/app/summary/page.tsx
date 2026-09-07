import Link from "next/link";
import type { Metadata } from "next";
import { IconChevronLeft, IconChevronRight, IconExternalLink } from "@tabler/icons-react";
import { getEngine } from "@/engine/engine";
import { summaryToMarkdown, type Period } from "@/engine/summary";
import { TOOL_META } from "@/engine/tool-meta";
import { CopyButton } from "@/components/dashboard/copy-button";
import { SessionTable } from "@/components/dashboard/session-table";
import { StatCard } from "@/components/dashboard/stat-card";
import { ToolDot } from "@/components/dashboard/tool-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { compact, shortenPath } from "@/lib/format";
import { href, parseTools } from "@/lib/query";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

const PERIODS: { id: Period; label: string; days: number }[] = [
  { id: "day", label: "Daily", days: 1 },
  { id: "week", label: "Weekly", days: 7 },
  { id: "month", label: "Monthly", days: 30 },
];

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

function shiftAnchor(anchor: Date, period: Period, dir: -1 | 1): string {
  const d = new Date(anchor);
  if (period === "month") d.setMonth(d.getMonth() + dir);
  else d.setDate(d.getDate() + dir * (period === "week" ? 7 : 1));
  return d.toISOString().slice(0, 10);
}

export default async function SummaryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const periodRaw = first(sp.period);
  const period: Period = PERIODS.some((p) => p.id === periodRaw) ? (periodRaw as Period) : "week";
  const anchorRaw = first(sp.anchor);
  const anchor = anchorRaw && !Number.isNaN(new Date(anchorRaw).getTime()) ? new Date(`${anchorRaw}T12:00:00`) : new Date();
  const tools = parseTools(first(sp.tool));
  const project = first(sp.project) || undefined;

  const summary = getEngine().periodSummary(period, anchor, { tools, project });
  const markdown = summaryToMarkdown(summary, { maxSessions: 100 });

  const params = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { period, anchor: anchorRaw, tool: tools?.join(","), project, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const qs = p.toString();
    return qs ? `/summary?${qs}` : "/summary";
  };
  const apiParams = new URLSearchParams({ period, ...(anchorRaw ? { anchor: anchorRaw } : {}), ...(tools ? { tool: tools.join(",") } : {}), ...(project ? { project } : {}) });
  const cli = `agentboard summary --period ${period}${anchorRaw ? ` --date ${anchorRaw}` : ""}${tools ? ` --tool ${tools.join(",")}` : ""}${project ? ` --project "${project}"` : ""}`;
  const isCurrent = !anchorRaw;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground">Daily / weekly / monthly digests. The same data is served at <code className="rounded bg-muted px-1">/api/summary</code> for automation.</p>
        </div>
        <div className="inline-flex rounded-md border p-0.5">
          {PERIODS.map((p) => (
            <Link key={p.id} href={params({ period: p.id })} className={cn("rounded-[5px] px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground", period === p.id && "bg-primary text-primary-foreground hover:text-primary-foreground")}>
              {p.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link href={params({ anchor: shiftAnchor(anchor, period, -1) })} className={buttonVariants({ variant: "outline", size: "sm" })} aria-label="Previous period">
          <IconChevronLeft className="size-4" />
        </Link>
        <span className="min-w-48 text-center font-medium tabular-nums">{summary.range.label}</span>
        <Link href={params({ anchor: shiftAnchor(anchor, period, 1) })} className={buttonVariants({ variant: "outline", size: "sm" })} aria-label="Next period">
          <IconChevronRight className="size-4" />
        </Link>
        {!isCurrent && (
          <Button asChild variant="ghost" size="sm">
            <Link href={params({ anchor: undefined })}>Current {period}</Link>
          </Button>
        )}
        {(tools || project) && (
          <span className="text-xs text-muted-foreground">
            filtered by {tools?.map((t) => TOOL_META[t]?.name ?? t).join(", ")}
            {tools && project ? " · " : ""}
            {project}
            {" · "}
            <Link href={params({ tool: undefined, project: undefined })} className="underline">
              clear
            </Link>
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Sessions" value={summary.totals.sessions} />
        <StatCard label="Messages" value={compact(summary.totals.messages)} hint={`${compact(summary.totals.userMessages)} prompts`} />
        <StatCard label="Tool calls" value={compact(summary.totals.toolCalls)} />
        <StatCard label="Tools" value={summary.totals.tools} />
        <StatCard label="Projects" value={summary.totals.projects} />
      </div>

      {summary.totals.sessions === 0 ? (
        <div className="rounded-lg border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">No sessions recorded in this period.</div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="rounded-xl border bg-card p-4">
            <h2 className="mb-3 text-sm font-medium">By tool</h2>
            <ul className="flex flex-col gap-2 text-sm">
              {summary.byTool.map((t) => (
                <li key={t.tool} className="flex items-center gap-2">
                  <ToolDot tool={t.tool} />
                  <Link href={params({ tool: t.tool })} className="hover:underline">
                    {TOOL_META[t.tool]?.name ?? t.tool}
                  </Link>
                  <span className="ml-auto text-muted-foreground tabular-nums">
                    {t.sessionCount} sessions · {compact(t.messageCount)} msgs
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-xl border bg-card p-4">
            <h2 className="mb-3 text-sm font-medium">By project</h2>
            <ul className="flex flex-col gap-2 text-sm">
              {summary.byProject.map((p) => (
                <li key={p.path} className="flex items-center gap-2">
                  <Link href={params({ project: p.path })} className="truncate font-mono hover:underline" title={p.path}>
                    {p.name}
                  </Link>
                  <span className="hidden truncate text-xs text-muted-foreground md:inline">{shortenPath(p.path, 36)}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{p.sessionCount} sessions</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Markdown digest</h2>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton text={markdown} label="Copy markdown" />
            <CopyButton text={cli} label="Copy CLI command" />
            <Button asChild variant="outline" size="sm">
              <a href={`/api/summary?${apiParams.toString()}&format=md`} target="_blank" rel="noreferrer">
                Raw <IconExternalLink className="size-3.5" />
              </a>
            </Button>
          </div>
        </div>
        <pre className="max-h-96 overflow-auto rounded-xl border bg-muted/40 p-4 font-mono text-xs whitespace-pre-wrap">{markdown}</pre>
      </section>

      {summary.sessions.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Sessions in this period</h2>
          <SessionTable items={[...summary.sessions].reverse()} filters={{ range: "all" }} />
          <p className="text-xs text-muted-foreground">
            Open the same set with filters on the{" "}
            <Link href={href("/", { range: "all", tools, project })} className="underline">
              sessions board
            </Link>
            .
          </p>
        </section>
      )}
    </div>
  );
}
