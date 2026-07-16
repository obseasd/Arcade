import { describe, it, expect } from "vitest";
import {
    decodeAbiParameters,
    decodeFunctionData,
    parseAbiParameters,
    type Address,
} from "viem";
import { ROUTER_ABI } from "@/lib/abis/dex";
import { buildOrbsBid, clearsFloor } from "@/lib/keeper/orbsRoute";

const USDC = "0x3600000000000000000000000000000000000000" as Address;
const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const EXCHANGE = "0x2222222222222222222222222222222222222222" as Address;
const ROUTER = "0x3333333333333333333333333333333333333333" as Address;

describe("clearsFloor", () => {
    it("passes when quote after slippage+fee still clears the floor", () => {
        // quote 1000, 1% slippage -> 990, fee 0 -> 990 >= floor 980
        expect(
            clearsFloor({
                quotedOut: 1000n,
                chunkFloor: 980n,
                slippagePercent: 1_000, // 1%
                dstFee: 0n,
            }),
        ).toBe(true);
    });

    it("fails when the slippage-adjusted quote drops below the floor", () => {
        // quote 1000, 1% -> 990 < floor 995 => limit not met
        expect(
            clearsFloor({
                quotedOut: 1000n,
                chunkFloor: 995n,
                slippagePercent: 1_000,
                dstFee: 0n,
            }),
        ).toBe(false);
    });

    it("accounts for the taker fee taken out of the output", () => {
        // quote 1000, 0% slippage, fee 30 -> 970 < floor 980 => fails
        expect(
            clearsFloor({
                quotedOut: 1000n,
                chunkFloor: 980n,
                slippagePercent: 0,
                dstFee: 30n,
            }),
        ).toBe(false);
        // same but floor 970 => passes exactly at the boundary
        expect(
            clearsFloor({
                quotedOut: 1000n,
                chunkFloor: 970n,
                slippagePercent: 0,
                dstFee: 30n,
            }),
        ).toBe(true);
    });
});

describe("buildOrbsBid", () => {
    const base = {
        path: [USDC, TOKEN] as Address[],
        chunkIn: 100_000_000n, // 100 USDC (6dp)
        quotedOut: 5_000_000_000_000_000_000n, // 5 TOKEN (18dp)
        chunkFloor: 4_800_000_000_000_000_000n, // floor 4.8 TOKEN
        exchange: EXCHANGE,
        router: ROUTER,
        slippagePercent: 1_000,
        dstFee: 0n,
        deadline: 9_999_999_999n,
    };

    it("produces bidData decodable as (uint256 amountOut, bytes swapData)", () => {
        const plan = buildOrbsBid(base);
        const [amountOut, swapData] = decodeAbiParameters(
            parseAbiParameters("uint256 amountOut, bytes swapData"),
            plan.bidData,
        );
        // The committed output equals the live quote (truthful; a padded
        // amount would just revert at fill against the real balance).
        expect(amountOut).toBe(base.quotedOut);
        expect(plan.committedOut).toBe(base.quotedOut);

        // swapData is a real swapExactTokensForTokens call the ExchangeV2
        // adapter forwards to the V2 router.
        const decoded = decodeFunctionData({ abi: ROUTER_ABI, data: swapData });
        expect(decoded.functionName).toBe("swapExactTokensForTokens");
    });

    it("encodes the swap with recipient = the ExchangeV2 adapter, not the maker", () => {
        // This is the load-bearing invariant: ExchangeV2 forwards
        // dst.balanceOf(address(this)) to TWAP, so the router MUST deliver
        // the output back to the adapter. A wrong recipient would silently
        // send the maker's tokens elsewhere and the fill would revert.
        const plan = buildOrbsBid(base);
        const [, swapData] = decodeAbiParameters(
            parseAbiParameters("uint256 amountOut, bytes swapData"),
            plan.bidData,
        );
        const decoded = decodeFunctionData({ abi: ROUTER_ABI, data: swapData });
        // args: [amountIn, amountOutMin, path, to, deadline]
        const args = decoded.args as readonly unknown[];
        expect(args[0]).toBe(base.chunkIn); // amountIn = chunk
        expect(args[1]).toBe(base.chunkFloor); // amountOutMin = maker floor
        expect((args[2] as Address[]).map((a) => a.toLowerCase())).toEqual([
            USDC.toLowerCase(),
            TOKEN.toLowerCase(),
        ]);
        expect((args[3] as Address).toLowerCase()).toBe(EXCHANGE.toLowerCase());
        expect(args[4]).toBe(base.deadline);
    });

    it("refuses to build a bid that does not clear the maker floor", () => {
        expect(() =>
            buildOrbsBid({ ...base, quotedOut: base.chunkFloor - 1n, chunkFloor: base.chunkFloor }),
        ).toThrow(/floor/i);
    });

    it("refuses a degenerate single-hop path", () => {
        expect(() => buildOrbsBid({ ...base, path: [USDC] as Address[] })).toThrow(/hop/i);
    });
});
