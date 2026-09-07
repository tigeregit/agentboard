import Link from "next/link";
import { IconFolderCode } from "@tabler/icons-react";
import { TOOL_META } from "@/engine/tool-meta";
import type { DayBucket, ProjectStat, ToolStat } from "@/engine/types";
import { addDays, startOfLocalDay, startOfLocalWeek } from "@/engine/util/time";
import { ScrollEnd } from "@/components/dashboard/scroll-end";
import { cn } from "@/lib/utils";
import { href, type DashboardFilters } from "@/lib/query";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];
/** Column pitch used for the minimum width; below this the graph scrolls horizontally instead of shrinking cells. */
const MIN_COLUMN_PX = 13;
const LABEL_COLUMN_PX = 32;

function localDayString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** "August 28th" for the tooltip, GitHub style; year added when it is not the current one. */
function prettyDay(d: Date, now: Date): string {
  const base = `${MONTHS_LONG[d.getMonth()]} ${ordinal(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** First day of the heatmap window: the Monday `weeks` weeks before the current week. */
export function heatmapStart(weeks: number, now = new Date()): Date {
  return addDays(startOfLocalWeek(now), -7 * (weeks - 1));
}

/**
 * Quartile thresholds over the non-zero values, so a handful of very busy days
 * do not flatten everything else into the lightest shade (same idea as GitHub).
 */
function levelFor(value: number, thresholds: number[]): number {
  if (value <= 0) return 0;
  let level = 1;
  for (const t of thresholds) if (value > t) level++;
  return Math.min(level, 4);
}

function quartiles(values: number[]): number[] {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return [0, 0, 0];
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const q = [at(0.25), at(0.5), at(0.75)];
  // Guarantee strictly increasing thresholds for tiny samples; equal thresholds would skip shades.
  for (let i = 1; i < q.length; i++) if (q[i] <= q[i - 1]) q[i] = q[i - 1] + 1;
  return q;
}

interface Props {
  days: DayBucket[];
  /** Per-tool and per-project totals over the same window, for the overview under the graph. */
  tools: ToolStat[];
  projects: ProjectStat[];
  filters: Pick<DashboardFilters, "tools" | "project" | "search" | "surface" | "day">;
  weeks?: number;
}

/**
 * GitHub-style contribution graph. Cell colour = human turns that day (sum of
 * `userMessageCount` across sessions), which measures how much you actually
 * talked to agents rather than how many sessions were opened. Rendered on the
 * server; each cell links to the board filtered to that day.
 */
export function ActivityHeatmap({ days, tools, projects, filters, weeks = 52 }: Props) {
  const now = new Date();
  const today = startOfLocalDay(now);
  const start = heatmapStart(weeks, today);
  const byDay = new Map(days.map((d) => [d.day, d]));

  const columns: { day: string; date: Date; bucket?: DayBucket; future: boolean }[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, w * 7 + i);
      const day = localDayString(date);
      col.push({ day, date, bucket: byDay.get(day), future: date > today });
    }
    columns.push(col);
  }

  const values = columns.flat().map((c) => c.bucket?.userMessageCount ?? 0);
  const thresholds = quartiles(values);
  const total = values.reduce((a, b) => a + b, 0);
  const activeDays = values.filter((v) => v > 0).length;
  const busiest = columns.flat().reduce<{ day: string; n: number } | null>((best, c) => {
    const n = c.bucket?.userMessageCount ?? 0;
    return !best || n > best.n ? { day: c.day, n } : best;
  }, null);

  // Streak: consecutive active days ending today (or yesterday, if today has none yet).
  let streak = 0;
  for (let d = today; ; d = addDays(d, -1)) {
    const n = byDay.get(localDayString(d))?.userMessageCount ?? 0;
    if (n > 0) streak++;
    else if (d.getTime() === today.getTime()) continue;
    else break;
    if (d < start) break;
  }

  // A month label sits over the first column whose Monday falls in that month; the very first
  // column is labelled only when the next month does not start within two columns.
  const monthLabels: (string | null)[] = columns.map((col, w) => {
    const first = col[0].date;
    const prev = w > 0 ? columns[w - 1][0].date : null;
    return !prev || first.getMonth() !== prev.getMonth() ? MONTHS[first.getMonth()] : null;
  });
  if (monthLabels[1] || monthLabels[2]) monthLabels[0] = null;
  // A label over the last two columns would be clipped by the scroll container.
  for (let i = Math.max(0, monthLabels.length - 2); i < monthLabels.length; i++) monthLabels[i] = null;

  const linkFilters = { tools: filters.tools, project: filters.project, search: filters.search, surface: filters.surface };
  const gridStyle = { gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` };
  const period = weeks === 52 ? "in the last year" : `in the last ${weeks} weeks`;

  return (
    <section className="rounded-xl border bg-card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold tracking-tight">
          <span className="tabular-nums">{total.toLocaleString()}</span> human turn{total === 1 ? "" : "s"} {period}
        </h2>
        <span className="text-xs text-muted-foreground">
          {activeDays} active day{activeDays === 1 ? "" : "s"}
          {busiest && busiest.n > 0 && <> · busiest {busiest.day} ({busiest.n})</>}
          {streak > 1 && <> · {streak}-day streak</>}
        </span>
      </div>

      <div className="rounded-lg border px-3 pb-2 pt-3 sm:px-4">
        <ScrollEnd className="overflow-x-auto">
          <div style={{ minWidth: `${weeks * MIN_COLUMN_PX + LABEL_COLUMN_PX}px` }}>
            <div className="mb-1.5 grid gap-[3px] text-[11px] leading-none text-muted-foreground" style={{ ...gridStyle, marginLeft: LABEL_COLUMN_PX }}>
              {monthLabels.map((m, i) => (m ? <span key={i} className="whitespace-nowrap" style={{ gridColumnStart: i + 1 }}>{m}</span> : null))}
            </div>
            <div className="flex gap-[3px]">
              <div className="grid shrink-0 grid-rows-7 gap-[3px] text-[11px] leading-none text-muted-foreground" style={{ width: LABEL_COLUMN_PX - 3 }}>
                {WEEKDAYS.map((d, i) => (
                  <span key={i} className="flex items-center">
                    {d}
                  </span>
                ))}
              </div>
              <div className="grid flex-1 gap-[3px]" style={gridStyle}>
                {columns.map((col, w) => (
                  <div key={w} className="grid grid-rows-7 gap-[3px]">
                    {col.map((c) => {
                      const n = c.bucket?.userMessageCount ?? 0;
                      const sessions = c.bucket?.sessionCount ?? 0;
                      const level = levelFor(n, thresholds);
                      const selected = filters.day === c.day;
                      const when = prettyDay(c.date, now);
                      const label = c.future ? when : n === 0 ? `No human turns on ${when}.` : `${n} human turn${n === 1 ? "" : "s"} on ${when} · ${sessions} session${sessions === 1 ? "" : "s"}`;
                      const style = c.future ? undefined : { backgroundColor: `var(--heat-${level})` };
                      const cls = cn("block aspect-square w-full rounded-[3px] outline -outline-offset-1 outline-(--heat-outline)", c.future && "opacity-0", selected && "ring-2 ring-primary ring-offset-1 ring-offset-card");
                      if (c.future || n === 0) return <span key={c.day} className={cls} style={style} title={label} aria-label={label} />;
                      return (
                        <Link
                          key={c.day}
                          href={href("/", { ...linkFilters, day: selected ? undefined : c.day })}
                          className={cn(cls, "transition-[filter] hover:brightness-110 hover:ring-1 hover:ring-foreground/50")}
                          style={style}
                          title={label}
                          aria-label={label}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </ScrollEnd>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span title="A human turn is one user message inside a session. Sessions are bucketed by their last activity, in local time.">How turns are counted</span>
          <span className="flex items-center gap-1">
            <span className="mr-0.5">Less</span>
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className="inline-block size-[11px] rounded-[3px] outline -outline-offset-1 outline-(--heat-outline)"
                style={{ backgroundColor: `var(--heat-${i})` }}
                title={i === 0 ? "0 turns" : `> ${i === 1 ? 0 : thresholds[i - 2]} turns`}
              />
            ))}
            <span className="ml-0.5">More</span>
          </span>
        </div>
      </div>

      <ActivityOverview tools={tools} projects={projects} filters={linkFilters} total={total} period={period} />
    </section>
  );
}

const SHOWN_PROJECTS = 3;
const SHOWN_TOOLS = 5;

/** The "Activity overview" strip under the graph: where the work happened and which tools took the turns. */
function ActivityOverview({ tools, projects, filters, total, period }: { tools: ToolStat[]; projects: ProjectStat[]; filters: Pick<DashboardFilters, "tools" | "project" | "search" | "surface">; total: number; period: string }) {
  const rankedProjects = [...projects].filter((p) => p.userMessageCount > 0).sort((a, b) => b.userMessageCount - a.userMessageCount);
  const shownProjects = rankedProjects.slice(0, SHOWN_PROJECTS);
  const moreProjects = rankedProjects.length - shownProjects.length;

  const rankedTools = [...tools].filter((t) => t.userMessageCount > 0).sort((a, b) => b.userMessageCount - a.userMessageCount);
  const shownTools = rankedTools.slice(0, SHOWN_TOOLS);
  const restTurns = rankedTools.slice(SHOWN_TOOLS).reduce((n, t) => n + t.userMessageCount, 0);
  const denominator = Math.max(1, total);
  const pct = (n: number) => `${Math.round((n / denominator) * 100)}%`;

  if (!rankedProjects.length && !rankedTools.length) return null;

  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2 md:divide-x md:divide-border">
      <div className="min-w-0">
        <h3 className="mb-2 text-sm font-medium">Activity overview</h3>
        <div className="flex gap-2 text-sm">
          <IconFolderCode className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p className="min-w-0 leading-6">
            <span className="text-muted-foreground">Worked in </span>
            {shownProjects.map((p, i) => (
              <span key={p.path}>
                <Link href={href("/", { ...filters, project: p.path })} className="font-medium text-sky-600 hover:underline dark:text-sky-400" title={`${p.path} · ${p.userMessageCount} human turns`}>
                  {p.name}
                </Link>
                {i < shownProjects.length - 1 ? ", " : ""}
              </span>
            ))}
            {moreProjects > 0 && (
              <>
                <span className="text-muted-foreground"> and </span>
                <Link href="/projects" className="hover:underline">
                  {moreProjects} other project{moreProjects === 1 ? "" : "s"}
                </Link>
              </>
            )}
          </p>
        </div>
      </div>
      <div className="min-w-0 md:pl-4">
        <h3 className="mb-2 text-sm font-medium">
          Turns by tool <span className="font-normal text-muted-foreground">{period}</span>
        </h3>
        <ul className="flex flex-col gap-1.5">
          {shownTools.map((t) => (
            <li key={t.tool} className="flex items-center gap-2 text-xs">
              <Link href={href("/", { ...filters, tools: [t.tool] })} className="flex w-32 shrink-0 items-center gap-1.5 truncate hover:underline" title={TOOL_META[t.tool]?.name ?? t.tool}>
                <span className="inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: TOOL_META[t.tool]?.color ?? "#999" }} />
                <span className="truncate">{TOOL_META[t.tool]?.short ?? t.tool}</span>
              </Link>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full" style={{ width: pct(t.userMessageCount), backgroundColor: TOOL_META[t.tool]?.color ?? "#999" }} />
              </span>
              <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{pct(t.userMessageCount)}</span>
            </li>
          ))}
          {restTurns > 0 && (
            <li className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="w-32 shrink-0 truncate pl-3.5">{rankedTools.length - SHOWN_TOOLS} other tool{rankedTools.length - SHOWN_TOOLS === 1 ? "" : "s"}</span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-muted-foreground/40" style={{ width: pct(restTurns) }} />
              </span>
              <span className="w-10 shrink-0 text-right tabular-nums">{pct(restTurns)}</span>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
