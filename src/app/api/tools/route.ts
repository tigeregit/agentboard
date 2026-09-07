import { NextResponse, type NextRequest } from "next/server";
import { getEngine } from "@/engine/engine";
import { TOOL_META } from "@/engine/registry";
import { parseFilters, toSessionQuery } from "@/lib/query";

export const dynamic = "force-dynamic";

/** GET /api/tools?project=...&range=... → per-tool aggregates with display metadata. */
export function GET(req: NextRequest) {
  const f = parseFilters(req.nextUrl.searchParams, { range: "all" });
  const q = toSessionQuery(f);
  delete q.limit;
  delete q.offset;
  const items = getEngine().toolStats(q).map((s) => ({ ...s, ...TOOL_META[s.tool] }));
  return NextResponse.json({ items });
}
