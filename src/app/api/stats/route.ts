import { NextResponse } from "next/server";
import { autoScanIntervalMs, getEngine } from "@/engine/engine";
import { TOOL_IDS } from "@/engine/registry";

export const dynamic = "force-dynamic";

/**
 * GET /api/stats → index totals, refresh state and the list of supported tool
 * ids (handy for agents discovering the API, and used by `agentboard server
 * status` as the health probe). Does not trigger a scan itself.
 */
export function GET() {
  const engine = getEngine();
  return NextResponse.json({
    counts: engine.counts(),
    lastScan: engine.lastScanAt() ?? null,
    scanning: engine.scanning,
    autoScanSeconds: autoScanIntervalMs() / 1000,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    tools: TOOL_IDS,
    endpoints: ["/api/sessions", "/api/sessions/{key}", "/api/projects", "/api/tools", "/api/days", "/api/heatmap", "/api/sources", "/api/summary", "/api/scan", "/api/stats"],
  });
}
