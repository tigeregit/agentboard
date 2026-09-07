import { NextResponse } from "next/server";
import { getEngine } from "@/engine/engine";
import { TOOL_IDS } from "@/engine/registry";

export const dynamic = "force-dynamic";

/** GET /api/stats → index totals plus the list of supported tool ids (handy for agents discovering the API). */
export function GET() {
  const engine = getEngine();
  const runs = engine.store.lastRuns();
  const lastScan = runs.map((r) => r.finishedAt).sort().at(-1) ?? null;
  return NextResponse.json({
    counts: engine.counts(),
    lastScan,
    tools: TOOL_IDS,
    endpoints: ["/api/sessions", "/api/sessions/{key}", "/api/projects", "/api/tools", "/api/days", "/api/sources", "/api/summary", "/api/scan"],
  });
}
