import {
    encodeAbiParameters,
    encodeFunctionData,
    parseAbiParameters,
    type Address,
    type Hex,
} from "viem";
import { ROUTER_ABI } from "../abis/dex";
import { V3_ROUTER_ABI } from "../abis/v3";

/**
 * The venue a single Orbs fill routes through. Each maps to a deployed
 * ExchangeV2 adapter (one per router). The keeper picks the best-quoting venue
 * per fill (Ask.exchange = 0 lets it), which is Phase 1 of "limit via aggregator"
 * (B): V2-style and V3-SwapRouter venues that are approve-to-router so the plain
 * ExchangeV2 (`approve(router); functionCall(router, swapData)`) fits. Permit2
 * venues (Synthra/UnitFlow UniversalRouter) and V4 need a Permit2/V4-aware
 * adapter -- later phases.
 *
 *  - v2:  swapExactTokensForTokens(path, recipient=adapter). Arcade V2, XyloNet.
 *  - v3:  exactInputSingle(tokenIn,tokenOut,fee, recipient=adapter). Arcade V3.
 */
export type OrbsVenue =
    | { kind: "v2"; router: Address; path: readonly Address[] }
    | {
          kind: "v3";
          router: Address;
          tokenIn: Address;
          tokenOut: Address;
          fee: number;
      };

/**
 * Build the router calldata (swapData) for a venue. The output recipient MUST be
 * the ExchangeV2 adapter (it checks the delivered balance >= floor, then forwards
 * to TWAP); a recipient of the maker would let the adapter's balance check see 0
 * and revert. amountOutMinimum = the maker floor: the router enforces it too, a
 * belt to the adapter's suspenders.
 */
export function buildVenueSwapData(
    venue: OrbsVenue,
    chunkIn: bigint,
    chunkFloor: bigint,
    adapter: Address,
    deadline: bigint,
): Hex {
    if (venue.kind === "v2") {
        if (venue.path.length < 2) throw new Error("v2 path must have >= 2 hops");
        return encodeFunctionData({
            abi: ROUTER_ABI,
            functionName: "swapExactTokensForTokens",
            args: [chunkIn, chunkFloor, venue.path, adapter, deadline],
        });
    }
    return encodeFunctionData({
        abi: V3_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [
            venue.tokenIn,
            venue.tokenOut,
            venue.fee,
            adapter,
            chunkIn,
            chunkFloor,
            deadline,
        ],
    });
}

/**
 * Route encoding for the Orbs TWAP keeper (leg A of the unified keeper).
 *
 * The keeper is an Orbs "taker". To settle a chunk it must submit a bid
 * whose `data` (bidData) is what the ExchangeV2 adapter decodes:
 *
 *   bidData = abi.encode(uint256 amountOut, bytes swapData)
 *
 * where:
 *   - amountOut : the output the taker COMMITS to. TWAP.verifyBid reads
 *                 it back via ExchangeV2.getAmountOut, subtracts the
 *                 declared slippage + dstFee, and requires the result to
 *                 clear the maker's per-chunk floor (dstMinAmountNext).
 *                 It must be truthful: at fill time ExchangeV2 re-checks
 *                 the ACTUAL swap output against the committed floor, so
 *                 an over-stated amountOut just makes the fill revert.
 *   - swapData  : the raw calldata ExchangeV2 forwards to the V2 router.
 *                 ExchangeV2 pulls the chunk from TWAP, approves the
 *                 router, functionCall(router, swapData), then requires
 *                 its own dst balance >= the floor and forwards it. So
 *                 the swap's recipient MUST be the ExchangeV2 contract,
 *                 not the maker or the keeper.
 *
 * This module is PURE (no chain reads) so it is unit-testable in
 * isolation; the cron supplies the live quote + reserves it read.
 */

/** ExchangeV2 decodes bidData as (uint256, bytes). */
const BID_DATA_PARAMS = parseAbiParameters("uint256 amountOut, bytes swapData");

export interface OrbsBidPlan {
    /** abi.encoded (amountOut, swapData) blob to pass as bid `data`. */
    bidData: Hex;
    /** Slippage in Orbs PERCENT_BASE units (100000 = 100%). */
    slippagePercent: number;
    /** Taker fee in dstToken, taken from the chunk output. */
    dstFee: bigint;
    /** The committed expected output (for logging / DB). */
    committedOut: bigint;
    /** The per-chunk floor the swap enforces (for logging / DB). */
    chunkFloor: bigint;
}

export interface BuildOrbsBidArgs {
    /** The venue this fill routes through (v2 path or v3 single-hop). Its
     *  `router` is what the chosen ExchangeV2 adapter wraps. */
    venue: OrbsVenue;
    /** Chunk input size = srcBidAmountNext, in srcToken base units. */
    chunkIn: bigint;
    /** Live quote for chunkIn on `venue` (the venue's own quoter). */
    quotedOut: bigint;
    /** Per-chunk maker floor = dstMinAmountNext, in dstToken base units. */
    chunkFloor: bigint;
    /** The ExchangeV2 adapter address (the swap recipient) for this venue. */
    exchange: Address;
    /**
     * Slippage in PERCENT_BASE units the keeper tolerates between the bid
     * quote and the fill-time reserves. 1000 = 1%. Absorbs the price
     * drift over the bidDelay window so an honest chunk still fills.
     */
    slippagePercent: number;
    /** Taker fee in dstToken (0 on testnet: the keeper subsidises gas). */
    dstFee: bigint;
    /** Router deadline for the swap; must survive until the fill tick. */
    deadline: bigint;
}

/**
 * True iff the order is fillable at the quoted price: the committed
 * output, after the declared slippage and taker fee, still clears the
 * maker's per-chunk floor. For a LIMIT order this is the trigger (the
 * floor is the limit price); for a DCA order the floor is loose so this
 * is almost always true. The keeper must NOT bid when this is false
 * (TWAP.verifyBid would revert "min out" and waste gas).
 */
export function clearsFloor(args: {
    quotedOut: bigint;
    chunkFloor: bigint;
    slippagePercent: number;
    dstFee: bigint;
}): boolean {
    const PERCENT_BASE = 100_000n;
    const afterSlip =
        args.quotedOut -
        (args.quotedOut * BigInt(args.slippagePercent)) / PERCENT_BASE;
    if (afterSlip <= args.dstFee) return false;
    return afterSlip - args.dstFee >= args.chunkFloor;
}

/**
 * Build the bid plan for one chunk. The swap's amountOutMin is set to the
 * maker floor (chunkFloor) so the router itself rejects a fill below the
 * maker's minimum; ExchangeV2 then re-asserts against the committed
 * output. Reverts (throws) if the path is not a simple src->dst hop or
 * the quote does not clear the floor -- the caller must skip such orders.
 */
export function buildOrbsBid(args: BuildOrbsBidArgs): OrbsBidPlan {
    if (
        !clearsFloor({
            quotedOut: args.quotedOut,
            chunkFloor: args.chunkFloor,
            slippagePercent: args.slippagePercent,
            dstFee: args.dstFee,
        })
    ) {
        throw new Error("quote does not clear the maker floor");
    }

    // Router calldata for the chosen venue. Output recipient = the adapter (it
    // checks the delivered balance >= floor, then forwards to TWAP).
    const swapData = buildVenueSwapData(
        args.venue,
        args.chunkIn,
        args.chunkFloor,
        args.exchange,
        args.deadline,
    );

    const bidData = encodeAbiParameters(BID_DATA_PARAMS, [
        args.quotedOut,
        swapData,
    ]);

    return {
        bidData,
        slippagePercent: args.slippagePercent,
        dstFee: args.dstFee,
        committedOut: args.quotedOut,
        chunkFloor: args.chunkFloor,
    };
}
