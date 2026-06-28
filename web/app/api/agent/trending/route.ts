import { NextRequest } from "next/server";
import { listTrending } from "@/lib/agent/arcade";
import { ok, preflight } from "@/lib/agent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** GET /api/agent/trending?limit=15 — launchpad tokens by market cap (USDC). */
export async function GET(req: NextRequest) {
    const raw = Number(req.nextUrl.searchParams.get("limit") ?? 15);
    const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 15, 1), 30);
    return ok({ chain: "ARC-TESTNET", tokens: await listTrending(limit) });
}
