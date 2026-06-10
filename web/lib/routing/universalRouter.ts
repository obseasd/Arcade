import { Address, concat, encodeAbiParameters, encodePacked, Hex, toHex } from "viem";
import { UR_COMMANDS, UR_CONSTANTS } from "@/lib/abis/universalRouter";

/**
 * Helpers for building Uniswap Universal Router execute(commands, inputs,
 * deadline) calldata. `commands` is a packed byte string (one byte per
 * command), `inputs[i]` is ABI-encoded for command i's input shape.
 *
 * We only implement the subset the swap aggregator needs:
 *   - V3_SWAP_EXACT_IN (Synthra / UnitFlow exact-in swaps)
 *   - WRAP_ETH (wrap native USDC -> WUSDC for UnitFlow USDC pairs)
 *   - PERMIT2_PERMIT + PERMIT2_TRANSFER_FROM (Permit2-based pulls)
 *   - SWEEP (collect router-held token balance and forward to recipient)
 *
 * The V3 path encoder is the canonical 20+3+20+... packed form used by all
 * V3 forks: token0 (20 bytes) | fee (3 bytes, uint24) | token1 (20 bytes) | ...
 */

export interface V3PathHop {
    token: Address;
    /** Fee of the pool BEFORE this token (encoded between the previous
     *  token and this one). Ignored for hop[0]. */
    fee?: number;
}

/** Encode a list of V3 hops into a packed bytes path. */
export function encodeV3Path(hops: V3PathHop[]): Hex {
    if (hops.length < 2) throw new Error("V3 path needs at least 2 hops");
    let out: Hex = hops[0].token;
    for (let i = 1; i < hops.length; i++) {
        const hop = hops[i];
        if (hop.fee === undefined) throw new Error("hop fee missing");
        // 3-byte fee (uint24) then 20-byte token. encodePacked gives us
        // the tight byte layout V3 routers parse.
        const fee3 = toHex(hop.fee, { size: 3 });
        out = concat([out, fee3, hop.token]) as Hex;
    }
    return out;
}

/** Permit2 PermitSingle shape used by PERMIT2_PERMIT. */
export interface Permit2PermitSingle {
    details: {
        token: Address;
        amount: bigint;
        /** uint48 absolute timestamp. */
        expiration: number;
        /** uint48 from Permit2.allowance(user, token, spender).nonce. */
        nonce: number;
    };
    spender: Address;
    /** uint256 sig deadline. Used by Permit2 to refuse stale sigs. */
    sigDeadline: bigint;
}

/** Encode a PERMIT2_PERMIT input. */
export function encodePermit2PermitInput(permit: Permit2PermitSingle, signature: Hex): Hex {
    return encodeAbiParameters(
        [
            {
                type: "tuple",
                components: [
                    {
                        type: "tuple",
                        name: "details",
                        components: [
                            { name: "token", type: "address" },
                            { name: "amount", type: "uint160" },
                            { name: "expiration", type: "uint48" },
                            { name: "nonce", type: "uint48" },
                        ],
                    },
                    { name: "spender", type: "address" },
                    { name: "sigDeadline", type: "uint256" },
                ],
            },
            { type: "bytes" },
        ],
        [permit, signature],
    );
}

/** Encode a PERMIT2_TRANSFER_FROM input (token, recipient, amount). */
export function encodePermit2TransferFromInput(
    token: Address,
    recipient: Address,
    amount: bigint,
): Hex {
    return encodeAbiParameters(
        [
            { type: "address" },
            { type: "address" },
            { type: "uint160" },
        ],
        [token, recipient, amount],
    );
}

/** Encode a V3_SWAP_EXACT_IN input. */
export function encodeV3SwapExactInInput(args: {
    recipient: Address;
    amountIn: bigint;
    amountOutMin: bigint;
    path: Hex;
    payerIsUser: boolean;
}): Hex {
    return encodeAbiParameters(
        [
            { type: "address" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "bytes" },
            { type: "bool" },
        ],
        [args.recipient, args.amountIn, args.amountOutMin, args.path, args.payerIsUser],
    );
}

/** Encode a WRAP_ETH input (recipient, amountMin). The amount comes from
 *  msg.value sent with execute(); amountMin is the slippage floor on the
 *  resulting wrapped balance — for our use cases we set it equal to
 *  amountIn so a partial wrap reverts. */
export function encodeWrapEthInput(recipient: Address, amountMin: bigint): Hex {
    return encodeAbiParameters(
        [
            { type: "address" },
            { type: "uint256" },
        ],
        [recipient, amountMin],
    );
}

/** Encode an UNWRAP_WETH input (recipient, amountMin). */
export function encodeUnwrapWethInput(recipient: Address, amountMin: bigint): Hex {
    return encodeAbiParameters(
        [
            { type: "address" },
            { type: "uint256" },
        ],
        [recipient, amountMin],
    );
}

/** Encode a SWEEP input (token, recipient, amountMin). */
export function encodeSweepInput(
    token: Address,
    recipient: Address,
    amountMin: bigint,
): Hex {
    return encodeAbiParameters(
        [
            { type: "address" },
            { type: "address" },
            { type: "uint256" },
        ],
        [token, recipient, amountMin],
    );
}

/** Pack a list of command bytes into the bytes string Universal Router expects. */
export function encodeCommands(commands: number[]): Hex {
    if (commands.length === 0) return "0x";
    // encodePacked(uint8[]) writes each byte directly with no padding.
    const types = commands.map(() => "uint8" as const);
    return encodePacked(types, commands);
}

// Re-exports for callers that want the constants alongside the encoders.
export { UR_COMMANDS, UR_CONSTANTS };
