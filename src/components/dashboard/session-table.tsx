import Link from "next/link";
import { IconMessage, IconTool, IconClock } from "@tabler/icons-react";
import type { SessionSummary } from "@/engine/types";
import { duration, fmtDate, fmtTime, shortenPath } from "@/lib/format";
import { href, type DashboardFilters } from "@/lib/query";
import { ToolBadge } from "./tool-badge";

const SURFACE_LABEL: Record<SessionSummary["surface"], string> = { cli: "CLI", ide: "IDE", desktop: "Desktop", web: "Web" };

function groupByDay(items: SessionSummary[]) {
  const groups: { day: string; items: SessionSummary[] }[] = [];
  for (const s of items) {
    const day = fmtDate(s.startedAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(s);
    else groups.push({ day, items: [s] });
  }
  return groups;
}

export function SessionTable({ items, filters }: { items: SessionSummary[]; filters?: Partial<DashboardFilters> }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-5">
      {groupByDay(items).map((g) => (
        <section key={g.day}>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.day}</h3>
          <ul className="divide-y overflow-hidden rounded-lg border bg-card">
            {g.items.map((s) => (
              <li key={s.key} className="group relative flex flex-col gap-1.5 px-3 py-2.5 transition-colors hover:bg-muted/40 sm:flex-row sm:items-start sm:gap-4">
                <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums sm:w-12 sm:pt-1">{fmtTime(s.startedAt)}</div>
                <div className="min-w-0 flex-1">
                  <Link href={`/sessions/${encodeURIComponent(s.key)}`} className="line-clamp-2 font-medium text-sm after:absolute after:inset-0 group-hover:underline">
                    {s.title || s.firstPrompt || "(untitled session)"}
                  </Link>
                  {s.firstPrompt && s.title && s.firstPrompt !== s.title && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{s.firstPrompt}</p>}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <ToolBadge tool={s.tool} />
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase">{SURFACE_LABEL[s.surface]}</span>
                    <Link href={href("/", { ...filters, project: s.project.path, page: 1 })} className="relative z-10 truncate font-mono hover:text-foreground hover:underline" title={s.project.path}>
                      {s.project.name}
                      <span className="hidden text-muted-foreground/70 lg:inline"> · {shortenPath(s.project.path, 40)}</span>
                    </Link>
                    {s.gitBranch && <span className="font-mono">⎇ {s.gitBranch}</span>}
                    {s.model && <span className="hidden font-mono md:inline">{s.model}</span>}
                    {s.parentKey && <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">subagent</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground tabular-nums sm:pt-1">
                  <span className="inline-flex items-center gap-1" title="user prompts / total messages">
                    <IconMessage className="size-3.5" /> {s.userMessageCount}/{s.messageCount}
                  </span>
                  <span className="inline-flex items-center gap-1" title="tool calls">
                    <IconTool className="size-3.5" /> {s.toolCallCount}
                  </span>
                  <span className="inline-flex w-14 items-center gap-1" title="duration">
                    <IconClock className="size-3.5" /> {duration(s.startedAt, s.endedAt) || "—"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
