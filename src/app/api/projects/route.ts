import { NextResponse, type NextRequest } from "next/server";
import { getEngine } from "@/engine/engine";
import { parseFilters, toSessionQuery } from "@/lib/query";

export const dynamic = "force-dynamic";

/** GET /api/projects?tool=...&range=... → per-project aggregates. */
export async function GET(req: NextRequest) {
  await getEngine().ensureFresh();
  const f = parseFilters(req.nextUrl.searchParams, { range: "all" });
  const q = toSessionQuery(f);
  delete q.limit;
  delete q.offset;
  return NextResponse.json({ items: getEngine().projects(q) });
}
