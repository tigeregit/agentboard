import { NextResponse, type NextRequest } from "next/server";
import { getEngine } from "@/engine/engine";
import { parseTools } from "@/lib/query";

export const dynamic = "force-dynamic";

/**
 * POST /api/scan  { tools?: string[] | "a,b", full?: boolean }
 * Forces a re-index now. The dashboard already refreshes itself (see
 * Engine.ensureFresh), so this is for full rescans and external automation.
 * Concurrent calls share one run.
 */
export async function POST(req: NextRequest) {
  let body: { tools?: string[] | string; full?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // empty body is fine
  }
  const tools = parseTools(Array.isArray(body.tools) ? body.tools.join(",") : body.tools);
  const engine = getEngine();
  const reports = await engine.scan({ tools, full: !!body.full });
  return NextResponse.json({ reports, counts: engine.counts(), lastScan: engine.lastScanAt() ?? null });
}
