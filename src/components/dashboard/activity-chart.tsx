import type { DayBucket, ToolId } from "@/engine/types";
import { TOOL_META } from "@/engine/tool-meta";
import { ToolDot } from "./tool-badge";

function localDayString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Stacked-bar activity strip rendered on the server (no chart library).
 * `days` come straight from the engine; missing days are filled with zeros.
 */
export function ActivityChart({ days, since, until, maxDays = 90 }: { days: DayBucket[]; since?: string; until?: string; maxDays?: number }) {
  const end = until ? new Date(until) : new Date();
  const firstBucket = days[0]?.day;
  let start = since ? new Date(since) : firstBucket ? new Date(`${firstBucket}T00:00:00`) : new Date(end.getTime() - 29 * 86400e3);
  const span = Math.ceil((end.getTime() - start.getTime()) / 86400e3);
  if (span > maxDays) start = new Date(end.getTime() - (maxDays - 1) * 86400e3);
  if (span < 7) start = new Date(end.getTime() - 6 * 86400e3);

  const byDay = new Map(days.map((d) => [d.day, d]));
  const series: DayBucket[] = [];
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400e3)) {
    const key = localDayString(d);
    series.push(byDay.get(key) ?? { day: key, sessionCount: 0, messageCount: 0, byTool: {} });
  }
  const max = Math.max(1, ...series.map((d) => d.sessionCount));
  const totals = new Map<ToolId, number>();
  for (const d of series) for (const [t, n] of Object.entries(d.byTool)) totals.set(t as ToolId, (totals.get(t as ToolId) ?? 0) + (n ?? 0));
  const legend = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const labelEvery = series.length > 45 ? 14 : series.length > 20 ? 7 : 1;

  if (!days.length) {
    return <div className="flex h-40 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">No activity in this range.</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-40 items-end gap-px sm:gap-0.5" role="img" aria-label="Sessions per day">
        {series.map((d) => {
          const tools = Object.entries(d.byTool).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
          return (
            <div key={d.day} className="group relative flex h-full flex-1 flex-col justify-end" title={`${d.day}: ${d.sessionCount} sessions, ${d.messageCount} messages`}>
              <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm" style={{ height: `${(d.sessionCount / max) * 100}%` }}>
                {tools.map(([t, n]) => (
                  <div key={t} style={{ height: `${((n ?? 0) / Math.max(1, d.sessionCount)) * 100}%`, backgroundColor: TOOL_META[t as ToolId]?.color ?? "#999" }} className="w-full opacity-90 group-hover:opacity-100" />
                ))}
              </div>
              {d.sessionCount === 0 && <div className="h-px w-full bg-border" />}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
        {series.map((d, i) => (
          <span key={d.day} className="flex-1 truncate text-center">
            {i % labelEvery === 0 || i === series.length - 1 ? d.day.slice(5) : ""}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {legend.map(([t, n]) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            <ToolDot tool={t} /> {TOOL_META[t]?.name ?? t} <span className="tabular-nums">{n}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
