import { PROVIDER_META, RouteProvider } from "./types";

/**
 * UnitFlow V3 provider — TEMPORARILY DISABLED.
 *
 * UnitFlow's V3 pools are exclusively WUSDC-keyed (no native USDC pools),
 * which means every useful pair on Arc requires either (a) a WRAP_ETH
 * step in a Universal Router command stream, or (b) a multi-hop bytes
 * path going through WUSDC. Both are partially scaffolded in the
 * `lib/routing/universalRouter.ts` encoder, but neither has been
 * verified against the live UnitFlow contracts on Arc testnet (audit
 * CRIT-1: WUSDC wrap ratio unconfirmed; audit R-2: bytes-path
 * multi-hop never implemented).
 *
 * Shipping a half-working provider would mean every UnitFlow route
 * reverts at swap time, eating user gas. Until the wrap ratio and
 * multi-hop quoter are end-to-end tested, the provider returns null
 * unconditionally so it drops out of the aggregator panel cleanly.
 * Re-enable when:
 *   1. A small test wrap shows `WUSDC.deposit{value:x}()` mints the
 *      expected amount of WUSDC (likely 1:1 in base units → use
 *      `req.amountIn` directly, not `req.amountIn * 1e12`).
 *   2. The multi-hop path encoder + `quoteExactInput(bytes,uint256)`
 *      flow is wired so X↔Y pairs route via WUSDC.
 *   3. Permit2 + Universal Router commands are smoke-tested on a
 *      $1 USDC → EURC swap that lands successfully on-chain.
 */
export const unitflowV3Provider: RouteProvider = {
    meta: PROVIDER_META["unitflow-v3"],
    async quote() {
        return null;
    },
};
