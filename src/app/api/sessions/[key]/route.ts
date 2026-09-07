import { NextResponse, type NextRequest } from "next/server";
import { getEngine } from "@/engine/engine";

export const dynamic = "force-dynamic";

/** GET /api/sessions/<tool>:<nativeId> → full transcript (loaded from the source on demand). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const engine = getEngine();
  const decoded = decodeURIComponent(key);
  const summary = engine.getSummary(decoded);
  if (!summary) return NextResponse.json({ error: "not found", key: decoded }, { status: 404 });
  const wantDetail = req.nextUrl.searchParams.get("transcript") !== "0";
  const children = engine.children(decoded);
  if (!wantDetail) return NextResponse.json({ session: summary, children });
  try {
    const detail = await engine.getDetail(decoded);
    return NextResponse.json({ session: detail ?? { ...summary, messages: [] }, children, transcriptAvailable: !!detail });
  } catch (err) {
    return NextResponse.json({ session: { ...summary, messages: [] }, children, transcriptAvailable: false, error: (err as Error).message });
  }
}
