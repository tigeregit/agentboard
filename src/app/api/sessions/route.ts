import { NextResponse, type NextRequest } from "next/server";
import { getEngine } from "@/engine/engine";
import { parseFilters, toSessionQuery } from "@/lib/query";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions?tool=claude-code,codex&project=infra&q=timezone&range=7d|since=2026-09-01&until=...&page=1&limit=50
 * Same filters the CLI `list` command accepts. Returns { total, page, pageSize, items }.
 */
export async function GET(req: NextRequest) {
  await getEngine().ensureFresh();
  const f = parseFilters(req.nextUrl.searchParams, { range: "all" });
  const order = req.nextUrl.searchParams.get("order") === "asc" ? "asc" : "desc";
  const { total, items } = getEngine().list({ ...toSessionQuery(f), order });
  return NextResponse.json({ total, page: f.page, pageSize: f.pageSize, filters: { ...f, since: f.since ?? null, until: f.until ?? null }, items });
}
