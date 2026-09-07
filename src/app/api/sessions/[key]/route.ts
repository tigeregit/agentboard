import { NextResponse, type NextRequest } from "next/server";
import { getEngine } from "@/engine/engine";
import type { SessionDetail } from "@/engine/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/<tool>:<nativeId> → transcript (loaded from the source on demand).
 *   ?transcript=0  metadata only
 *   ?view=parts    typed parts instead of the flat message list
 *   ?view=outline  per-turn outline (from the part index)
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const engine = getEngine();
  await engine.ensureFresh();
  const decoded = decodeURIComponent(key);
  const summary = engine.getSummary(decoded);
  if (!summary) return NextResponse.json({ error: "not found", key: decoded }, { status: 404 });
  const wantDetail = req.nextUrl.searchParams.get("transcript") !== "0";
  const view = req.nextUrl.searchParams.get("view") ?? "messages";
  const children = engine.children(decoded);
  if (!wantDetail) return NextResponse.json({ session: summary, children });
  if (view === "outline") {
    const outline = await engine.outline(summary.key);
    return NextResponse.json({ session: summary, children, outline, fidelity: engine.store.parts.meta(summary.key)?.fidelity });
  }
  try {
    const detail = await engine.getDetail(decoded);
    const empty = { ...summary, messages: [], parts: [] };
    const session = detail ? (view === "parts" ? withoutMessages(detail) : withoutParts(detail)) : empty;
    return NextResponse.json({ session, children, transcriptAvailable: !!detail });
  } catch (err) {
    return NextResponse.json({ session: { ...summary, messages: [], parts: [] }, children, transcriptAvailable: false, error: (err as Error).message });
  }
}

function withoutParts(d: SessionDetail) {
  const { parts: _p, richParts: _r, ...rest } = d;
  void _p;
  void _r;
  return { ...rest, parts: [] };
}

function withoutMessages(d: SessionDetail) {
  const { messages: _m, ...rest } = d;
  void _m;
  return { ...rest, messages: [] };
}
