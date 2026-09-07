import { NextResponse, type NextRequest } from "next/server";
import { getEngine } from "@/engine/engine";
import { parseTools } from "@/lib/query";

export const dynamic = "force-dynamic";

let inflight: Promise<unknown> | null = null;

/**
 * POST /api/scan  { tools?: string[] | "a,b", full?: boolean }
 * Re-indexes local agent stores. Concurrent calls share one run.
 */
export async function POST(req: NextRequest) {
  let body: { tools?: string[] | string; full?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // empty body is fine
  }
  const tools = parseTools(Array.isArray(body.tools) ? body.tools.join(",") : body.tools);
  if (!inflight) {
    inflight = getEngine()
      .scan({ tools, full: !!body.full })
      .finally(() => {
        inflight = null;
      });
  }
  const reports = await inflight;
  return NextResponse.json({ reports, counts: getEngine().counts() });
}
