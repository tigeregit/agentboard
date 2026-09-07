import { NextResponse, type NextRequest } from "next/server";
import { getEngine } from "@/engine/engine";
import { summaryToMarkdown, type Period } from "@/engine/summary";
import { parseTools } from "@/lib/query";

export const dynamic = "force-dynamic";

/**
 * GET /api/summary?period=day|week|month&anchor=2026-09-01&tool=...&project=...&format=json|md
 * Period report for automation (daily / weekly digests). Mirrors `agentboard summary`.
 */
export function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const periodRaw = sp.get("period") ?? "day";
  if (!["day", "week", "month"].includes(periodRaw)) return NextResponse.json({ error: "period must be day|week|month" }, { status: 400 });
  const anchorRaw = sp.get("anchor");
  const anchor = anchorRaw ? new Date(anchorRaw) : new Date();
  if (Number.isNaN(anchor.getTime())) return NextResponse.json({ error: "invalid anchor date" }, { status: 400 });
  const summary = getEngine().periodSummary(periodRaw as Period, anchor, {
    tools: parseTools(sp.get("tool") ?? undefined),
    project: sp.get("project") ?? undefined,
  });
  if (sp.get("format") === "md") {
    return new NextResponse(summaryToMarkdown(summary, { includePrompts: sp.get("prompts") === "1" }), { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }
  return NextResponse.json(summary);
}
