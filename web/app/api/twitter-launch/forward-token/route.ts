import { NextRequest, NextResponse } from "next/server";
import { isAddress, parseEventLogs, parseAbiItem, type Address, type Hex } from "viem";

import { ADDRESSES } from "@/lib/constants";
import { serverPublicClient } from "@/lib/serverRpc";
import { forwardTokenSide, previewTokenSideOwed } from "@/lib/twitterTokenForward";

/**
 * Forward the launch-token side of a claimant's creator fees (see
 * twitterTokenForward.ts). No cron secret: the PROOF is the on-chain Claimed
 * event. The caller passes the escrow claim tx; we verify a Claimed(positionId,
 * slotIndex, recipient) fired in it (only the OAuth-verified recipient could have
 * produced it), then transfer the operator-held token side to that recipient.
 * Tokens always go to the event's `recipient`, so even an arbitrary caller can
 * only push funds to the legitimate claimant. Idempotent (DB cursor).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The token-side scan pages eth_getLogs across the hook's full block range
// (10k-block windows); allow headroom over the default 30s.
export const maxDuration = 60;

const HOOK_POOLID_ABI = [
    {
        type: "function",
        name: "poolIdOf",
        stateMutability: "view",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "bytes32" }],
    },
] as const;

const CLAIMED_EVENT = parseAbiItem(
    "event Claimed(uint256 indexed positionId, uint256 indexed slotIndex, address indexed recipient, address token, uint256 amount)",
);

/**
 * Read-only preview of the launch-token amount still owed to (token, slotIndex).
 * No proof needed (nothing is moved); the claim page uses it to show "+ N TICKER"
 * before the user claims. GET ?token=0x..&slot=0|1 -> { owedRaw: string }.
 */
export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    const slotParam = url.searchParams.get("slot");
    const slotIndex = slotParam === "1" ? 1 : 0;
    if (!token || !isAddress(token)) {
        return NextResponse.json({ error: "invalid token" }, { status: 400 });
    }

    const client = serverPublicClient();
    let poolIdHex: string;
    try {
        poolIdHex = (await client.readContract({
            address: ADDRESSES.arcadeHook as Address,
            abi: HOOK_POOLID_ABI,
            functionName: "poolIdOf",
            args: [token as Address],
        })) as string;
    } catch {
        return NextResponse.json({ owedRaw: "0" });
    }
    if (!poolIdHex || /^0x0*$/.test(poolIdHex)) {
        return NextResponse.json({ owedRaw: "0" });
    }

    const owedRaw = await previewTokenSideOwed(poolIdHex, slotIndex, token as Address);
    return NextResponse.json({ owedRaw });
}

export async function POST(req: NextRequest) {
    let body: { token?: string; slotIndex?: number; recipient?: string; claimTxHash?: string };
    try {
        body = (await req.json()) as typeof body;
    } catch {
        return NextResponse.json({ error: "bad body" }, { status: 400 });
    }
    const token = body.token;
    const slotIndex = body.slotIndex;
    const recipient = body.recipient;
    const claimTxHash = body.claimTxHash;
    if (!token || !isAddress(token) || !recipient || !isAddress(recipient)) {
        return NextResponse.json({ error: "invalid token/recipient" }, { status: 400 });
    }
    if (slotIndex !== 0 && slotIndex !== 1) {
        return NextResponse.json({ error: "invalid slot" }, { status: 400 });
    }
    if (!claimTxHash || !/^0x[0-9a-fA-F]{64}$/.test(claimTxHash)) {
        return NextResponse.json({ error: "invalid claimTxHash" }, { status: 400 });
    }

    const client = serverPublicClient();
    const escrow = ADDRESSES.twitterEscrow as Address;

    // Resolve the pool + verify the Claimed proof.
    let poolIdHex: string;
    try {
        poolIdHex = (await client.readContract({
            address: ADDRESSES.arcadeHook as Address,
            abi: HOOK_POOLID_ABI,
            functionName: "poolIdOf",
            args: [token as Address],
        })) as string;
    } catch {
        return NextResponse.json({ error: "poolId read failed" }, { status: 502 });
    }
    if (!poolIdHex || /^0x0*$/.test(poolIdHex)) {
        return NextResponse.json({ error: "not a hook token" }, { status: 400 });
    }
    const positionId = BigInt(poolIdHex);

    let proven = false;
    try {
        const receipt = await client.getTransactionReceipt({ hash: claimTxHash as Hex });
        const events = parseEventLogs({ abi: [CLAIMED_EVENT], logs: receipt.logs });
        proven = events.some(
            (e) =>
                (e.address as string).toLowerCase() === escrow.toLowerCase() &&
                e.args.positionId === positionId &&
                e.args.slotIndex === BigInt(slotIndex) &&
                (e.args.recipient as string).toLowerCase() === recipient.toLowerCase(),
        );
    } catch {
        return NextResponse.json({ error: "claim tx read failed" }, { status: 502 });
    }
    if (!proven) {
        return NextResponse.json({ error: "no matching Claimed event (unproven)" }, { status: 403 });
    }

    const result = await forwardTokenSide(poolIdHex, slotIndex, recipient as Address, token as Address);
    return NextResponse.json({ ok: true, result });
}
