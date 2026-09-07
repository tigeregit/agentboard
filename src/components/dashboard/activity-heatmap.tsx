import Link from "next/link";
import type { DayBucket } from "@/engine/types";
import { addDays, startOfLocalDay, startOfLocalWeek } from "@/engine/util/time";
import { cn } from "@/lib/utils";
import { href, type DashboardFilters } from "@/lib/query";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];
const LEVEL_CLASS = [
  "bg-muted/70 dark:bg-muted/40",
  "bg-emerald-200 dark:bg-emerald-950",
  "bg-emerald-400 dark:bg-emerald-800",
  "bg-emerald-600 dark:bg-emerald-600",
  "bg-emerald-800 dark:bg-emerald-400",
];

function localDayString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  filters: Pick<DashboardFilters, "tools" | "project" | "search" | "surface" | "day">;
  weeks?: number;
}

/**
 * GitHub-style calendar heatmap. Cell colour = human turns that day (sum of
 * `userMessageCount` across sessions), which measures how much you actually
 * talked to agents rather than how many sessions were opened. Rendered on the
 * server; each cell links to the board filtered to that day.
 */
export function ActivityHeatmap({ days, filters, weeks = 52 }: Props) {
  const today = startOfLocalDay(new Date());
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

  const monthLabels = columns.map((col, w) => {
    const first = col[0].date;
    const prev = w > 0 ? columns[w - 1][0].date : null;
    return !prev || first.getMonth() !== prev.getMonth() ? MONTHS[first.getMonth()] : "";
  });
  // Avoid a cramped label when a month starts in the very last column.
  if (monthLabels.length > 1 && monthLabels[monthLabels.length - 1] && monthLabels[monthLabels.length - 2]) monthLabels[monthLabels.length - 1] = "";

  const linkFilters = { tools: filters.tools, project: filters.project, search: filters.search, surface: filters.surface };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <div className="inline-flex min-w-full flex-col gap-1" style={{ minWidth: `${weeks * 14 + 36}px` }}>
          <div className="flex gap-[3px] pl-9 text-[10px] leading-none text-muted-foreground">
            {monthLabels.map((m, i) => (
              <span key={i} className="w-[11px] shrink-0 overflow-visible whitespace-nowrap">
                {m}
              </span>
            ))}
          </div>
          <div className="flex gap-[3px]">
            <div className="flex w-9 shrink-0 flex-col gap-[3px] pr-1 text-[10px] leading-none text-muted-foreground">
              {WEEKDAYS.map((d, i) => (
                <span key={i} className="flex h-[11px] items-center justify-end">
                  {d}
                </span>
              ))}
            </div>
            {columns.map((col, w) => (
              <div key={w} className="flex flex-col gap-[3px]">
                {col.map((c) => {
                  const n = c.bucket?.userMessageCount ?? 0;
                  const level = levelFor(n, thresholds);
                  const selected = filters.day === c.day;
                  const label = c.future ? c.day : `${c.day}: ${n} human turn${n === 1 ? "" : "s"} across ${c.bucket?.sessionCount ?? 0} session${c.bucket?.sessionCount === 1 ? "" : "s"}`;
                  const cls = cn("block size-[11px] rounded-[2px] ring-offset-background", c.future ? "bg-transparent" : LEVEL_CLASS[level], selected && "ring-2 ring-primary ring-offset-1");
                  if (c.future || n === 0) return <span key={c.day} className={cls} title={label} aria-label={label} />;
                  return <Link key={c.day} href={href("/", { ...linkFilters, day: selected ? undefined : c.day })} className={cn(cls, "hover:ring-2 hover:ring-foreground/40")} title={label} aria-label={label} />;
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground tabular-nums">{total.toLocaleString()}</span> human turns on {activeDays} day{activeDays === 1 ? "" : "s"} in the last {weeks} weeks
          {busiest && busiest.n > 0 && (
            <>
              {" "}
              · busiest {busiest.day} ({busiest.n})
            </>
          )}
          {streak > 1 && <> · {streak}-day streak</>}
        </span>
        <span className="flex items-center gap-1">
          Less
          {LEVEL_CLASS.map((c, i) => (
            <span key={i} className={cn("inline-block size-[11px] rounded-[2px]", c)} title={i === 0 ? "0" : `> ${i === 1 ? 0 : thresholds[i - 2]} turns`} />
          ))}
          More
        </span>
      </div>
    </div>
  );
}
