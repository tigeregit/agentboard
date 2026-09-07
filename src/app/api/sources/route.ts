import { NextResponse } from "next/server";
import { getEngine } from "@/engine/engine";

export const dynamic = "force-dynamic";

/** GET /api/sources → every adapter with detection result, strategies and last scan. */
export async function GET() {
  return NextResponse.json({ items: await getEngine().sources() });
}
