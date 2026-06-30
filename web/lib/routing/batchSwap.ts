import { Address } from "viem";

/**
 * Arc batch-swap helper (Multicall3From) - DISABLED.
 *
 * Multicall3From (0x522fAf9A…) routed every subcall through Arc's
 * `callFrom` precompile (0x18..03) so the target saw the original EOA as
 * `msg.sender`, which let us fold a one-time ERC20 `approve` and the swap
 * into a SINGLE user signature. That precompile is now DEAD on the current
 * Arc testnet (codesize 1; every call reverts with EvmError
 * StackUnderflow), so every `aggregate3` through Multicall3From reverts
 * on-chain.
 *
 * All former callers now execute the same operations as SEQUENTIAL DIRECT
 * transactions from the user's wallet via `runSequential` (see
 * ./runSequential.ts). Signing each tx directly preserves `msg.sender ==
 * user` for free with no precompile involved, so approve+swap,
 * decrease+collect, multi-collect, etc. all work as N sequential txs at
 * the cost of N wallet confirmations.
 *
 * The old `buildApproveAndCall` / `buildAggregate3` /
 * `buildBatchedApproveAndSwap` Multicall3From builders were removed once
 * every caller migrated. Re-introduce a batched single-signature path only
 * once a working sender-preserving multicall ships on Arc. The call-shape
 * type below is still used by SwapCard to describe a swap leg.
 */

/** A single contract call descriptor (wagmi writeContract shape). */
export interface BatchSwapCall {
    address: Address;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    abi: any;
    functionName: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: readonly any[];
}
