import { NextResponse, type NextRequest } from "next/server";
import { getEngine } from "@/engine/engine";
import { parseFilters, toSessionQuery } from "@/lib/query";

export const dynamic = "force-dynamic";

/** GET /api/days?range=30d&tool=... → daily activity buckets (local days) for charts / cron reports. */
export function GET(req: NextRequest) {
  const f = parseFilters(req.nextUrl.searchParams, { range: "30d" });
  const q = toSessionQuery(f);
  delete q.limit;
  delete q.offset;
  return NextResponse.json({ since: f.since ?? null, until: f.until ?? null, items: getEngine().days(q) });
}
