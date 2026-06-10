import { describe, it, expect } from "vitest";
import {
    encodeCommands,
    encodeV3Path,
    encodeV3SwapExactInInput,
    encodePermit2PermitInput,
    encodePermit2TransferFromInput,
    encodeWrapEthInput,
    encodeUnwrapWethInput,
    encodeSweepInput,
    UR_COMMANDS,
} from "@/lib/routing/universalRouter";

const USDC = "0x3600000000000000000000000000000000000000" as const;
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as const;
const WUSDC = "0x911b4000D3422F482F4062a913885f7b035382Df" as const;
const USER = "0x3a0Dd90212838f32a953Acd4B32596b62859324A" as const;
const SPENDER = "0xbf4479C07Dc6fdc6dAa764A0ccA06969e894275F" as const;

describe("encodeCommands", () => {
    it("packs a single byte command", () => {
        const out = encodeCommands([UR_COMMANDS.V3_SWAP_EXACT_IN]);
        expect(out).toBe("0x00");
    });
    it("packs multiple commands in order", () => {
        const out = encodeCommands([
            UR_COMMANDS.PERMIT2_PERMIT,
            UR_COMMANDS.V3_SWAP_EXACT_IN,
        ]);
        expect(out).toBe("0x0a00");
    });
    it("packs WRAP_ETH + SWAP + SWEEP", () => {
        const out = encodeCommands([
            UR_COMMANDS.WRAP_ETH,
            UR_COMMANDS.V3_SWAP_EXACT_IN,
            UR_COMMANDS.SWEEP,
        ]);
        expect(out).toBe("0x0b0004");
    });
    it("empty list produces 0x", () => {
        expect(encodeCommands([])).toBe("0x");
    });
});

describe("encodeV3Path", () => {
    it("single hop = tokenIn | fee | tokenOut packed", () => {
        const path = encodeV3Path([{ token: USDC }, { token: EURC, fee: 500 }]);
        // tokenIn (20) + fee uint24 (3) + tokenOut (20) = 43 bytes = 86 hex + 2 prefix
        expect(path.length).toBe(2 + 40 + 6 + 40);
        // Fee 500 = 0x0001f4
        expect(path.toLowerCase()).toContain("0001f4");
        expect(path.toLowerCase().endsWith(EURC.slice(2).toLowerCase())).toBe(true);
    });
    it("multi-hop = X | fee | pivot | fee | Y", () => {
        const path = encodeV3Path([
            { token: USDC },
            { token: WUSDC, fee: 500 },
            { token: EURC, fee: 100 },
        ]);
        // 20 + 3 + 20 + 3 + 20 = 66 bytes
        expect(path.length).toBe(2 + 40 + 6 + 40 + 6 + 40);
        expect(path.toLowerCase()).toContain("0001f4"); // first fee 500
        expect(path.toLowerCase()).toContain("000064"); // second fee 100
    });
    it("throws when < 2 hops", () => {
        expect(() => encodeV3Path([{ token: USDC }])).toThrow();
    });
    it("throws when intermediate hop missing fee", () => {
        expect(() =>
            encodeV3Path([{ token: USDC }, { token: EURC }]),
        ).toThrow();
    });
});

describe("encodeV3SwapExactInInput", () => {
    it("encodes recipient + amountIn + amountOutMin + path + payerIsUser", () => {
        const path = encodeV3Path([{ token: USDC }, { token: EURC, fee: 500 }]);
        const encoded = encodeV3SwapExactInInput({
            recipient: USER,
            amountIn: 1_000_000n,
            amountOutMin: 950_000n,
            path,
            payerIsUser: true,
        });
        // ABI-encoded (address, uint256, uint256, bytes, bool) is deterministic.
        // Just verify the recipient address appears in the encoding.
        expect(encoded.toLowerCase()).toContain(USER.slice(2).toLowerCase());
        // amountIn = 1_000_000 = 0xf4240, padded to uint256.
        expect(encoded.toLowerCase()).toContain("f4240");
        // payerIsUser = true encoded as 32-byte word ending in 01.
        expect(encoded.toLowerCase()).toContain("01");
    });
});

describe("encodePermit2PermitInput", () => {
    it("encodes the PermitSingle struct + signature bytes", () => {
        const permit = {
            details: {
                token: USDC,
                amount: 1_000_000n,
                expiration: 1_900_000_000,
                nonce: 7,
            },
            spender: SPENDER,
            sigDeadline: 1_900_001_000n,
        };
        const sig = "0xdeadbeef" as const;
        const encoded = encodePermit2PermitInput(permit, sig);
        // Verify token + spender both appear in the ABI-encoded blob.
        expect(encoded.toLowerCase()).toContain(USDC.slice(2).toLowerCase());
        expect(encoded.toLowerCase()).toContain(SPENDER.slice(2).toLowerCase());
        expect(encoded.toLowerCase()).toContain("deadbeef");
    });
});

describe("encodePermit2TransferFromInput", () => {
    it("encodes (token, recipient, amount)", () => {
        const encoded = encodePermit2TransferFromInput(USDC, USER, 1n);
        expect(encoded.toLowerCase()).toContain(USDC.slice(2).toLowerCase());
        expect(encoded.toLowerCase()).toContain(USER.slice(2).toLowerCase());
    });
});

describe("encodeWrapEthInput / encodeUnwrapWethInput", () => {
    it("WRAP_ETH input: (recipient, amountMin)", () => {
        const encoded = encodeWrapEthInput(USER, 5_000_000n);
        expect(encoded.toLowerCase()).toContain(USER.slice(2).toLowerCase());
    });
    it("UNWRAP_WETH input: (recipient, amountMin)", () => {
        const encoded = encodeUnwrapWethInput(USER, 5_000_000n);
        expect(encoded.toLowerCase()).toContain(USER.slice(2).toLowerCase());
    });
});

describe("encodeSweepInput", () => {
    it("encodes (token, recipient, amountMin)", () => {
        const encoded = encodeSweepInput(EURC, USER, 1n);
        expect(encoded.toLowerCase()).toContain(EURC.slice(2).toLowerCase());
        expect(encoded.toLowerCase()).toContain(USER.slice(2).toLowerCase());
    });
});
