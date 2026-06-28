import { NextRequest } from "next/server";
import { getPortfolio } from "@/lib/agent/arcade";
import { ok, bad, preflight, addr } from "@/lib/agent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** GET /api/agent/portfolio?wallet=0x... — known-token balances for a wallet. */
export async function GET(req: NextRequest) {
    const wallet = addr(req.nextUrl.searchParams.get("wallet"));
    if (!wallet) return bad("wallet must be an address");
    return ok(await getPortfolio(wallet));
}
