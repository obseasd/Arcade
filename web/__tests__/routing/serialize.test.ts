import { describe, it, expect } from "vitest";
import { encodeBigints, decodeBigints } from "@/lib/routing/serialize";

/**
 * A RouteQuote crosses the wire between /api/routes/quote and the swap panel.
 * It is riddled with bigints at arbitrary depth (executor.args holds structs,
 * tuples and arrays straight out of a provider), so the transport has to be
 * lossless in BOTH directions. The dangerous failure is silent: a numeric-looking
 * STRING arg revived as a bigint would change the calldata the user signs.
 */
describe("routing/serialize", () => {
    const round = <T>(v: T) => decodeBigints(JSON.parse(JSON.stringify(encodeBigints(v))));

    it("round-trips bigints at the top level", () => {
        expect(round(123n)).toBe(123n);
        expect(round(0n)).toBe(0n);
    });

    it("round-trips bigints beyond Number.MAX_SAFE_INTEGER without precision loss", () => {
        const huge = 2n ** 200n + 7n;
        expect(round(huge)).toBe(huge);
        // uint256 max, the value an infinite approval carries
        const max = 2n ** 256n - 1n;
        expect(round(max)).toBe(max);
    });

    it("round-trips bigints nested in arrays, objects and tuples", () => {
        const quote = {
            amountOut: 1_000_000n,
            approval: { token: "0xabc", spender: "0xdef", amount: 5n },
            executor: {
                router: "0x123",
                args: [
                    "0xrecipient",
                    [10n, [20n, { nested: 30n }]],
                    { struct: { deep: [40n, 50n] } },
                ],
                value: 0n,
            },
        };
        expect(round(quote)).toEqual(quote);
    });

    it("leaves numeric-looking STRINGS as strings", () => {
        // The whole reason for tagging: a naive reviver would turn these into
        // bigints and corrupt the calldata.
        const v = { a: "123", b: "0", c: "0x1f", d: "1e18", path: "USDC -> WETH" };
        expect(round(v)).toEqual(v);
        expect(typeof (round(v) as Record<string, unknown>).a).toBe("string");
    });

    it("preserves numbers, booleans, null and undefined-free shapes", () => {
        const v = { fee: 3000, ok: true, off: false, none: null, list: [1, 2, 3] };
        expect(round(v)).toEqual(v);
        expect(typeof (round(v) as Record<string, unknown>).fee).toBe("number");
    });

    it("does not revive an object that merely has extra keys alongside the tag", () => {
        // Only a lone tag key means "this was a bigint".
        const v = { $bigint__: "5", andSomethingElse: 1 };
        expect(decodeBigints(v)).toEqual(v);
    });

    it("survives an ABI object unchanged", () => {
        const abi = [
            {
                type: "function",
                name: "swapExactTokensForTokens",
                stateMutability: "nonpayable",
                inputs: [{ name: "amountIn", type: "uint256" }],
                outputs: [{ name: "amounts", type: "uint256[]" }],
            },
        ];
        expect(round(abi)).toEqual(abi);
    });
});
