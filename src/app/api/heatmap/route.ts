import { NextResponse, type NextRequest } from "next/server";
import { getEngine } from "@/engine/engine";
import { addDays, startOfLocalDay, startOfLocalWeek } from "@/engine/util/time";
import { parseFilters, toSessionQuery } from "@/lib/query";

export const dynamic = "force-dynamic";

/**
 * GET /api/heatmap?weeks=52&tool=...&project=...&q=...
 * Per-day interaction counts for the calendar heatmap: `userMessageCount` is the
 * number of human turns summed over every session that ended that day.
 * Days with no activity are included with zeros so the series is dense.
 */
export function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const weeks = Math.min(260, Math.max(1, Number(sp.get("weeks") ?? 52) || 52));
  const f = parseFilters(sp, { range: "all" });
  const q = toSessionQuery(f);
  delete q.limit;
  delete q.offset;
  const today = startOfLocalDay(new Date());
  const start = addDays(startOfLocalWeek(today), -7 * (weeks - 1));
  q.since = start.toISOString();
  q.until = undefined;

  const byDay = new Map(getEngine().days(q).map((d) => [d.day, d]));
  const items = [];
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const b = byDay.get(day);
    items.push({ day, userMessageCount: b?.userMessageCount ?? 0, sessionCount: b?.sessionCount ?? 0, messageCount: b?.messageCount ?? 0 });
  }
  const total = items.reduce((n, i) => n + i.userMessageCount, 0);
  return NextResponse.json({ from: items[0]?.day ?? null, to: items.at(-1)?.day ?? null, weeks, total, activeDays: items.filter((i) => i.userMessageCount > 0).length, items });
}
