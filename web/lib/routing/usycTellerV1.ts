import { ADDRESSES } from "@/lib/constants";
import {
  USYC_ADDRESS,
  USYC_TELLER_ABI,
  USYC_TELLER_ADDRESS,
} from "@/lib/abis/usyc";
import { PROVIDER_META, RouteProvider, RouteQuote } from "./types";

/**
 * USYC Teller provider.
 *
 * USYC (Hashnote tokenized T-Bills) is a transfer-restricted RWA token: only
 * entitled (whitelisted) addresses can hold it, so there is NO AMM pool for it
 * (a pool contract cannot receive USYC). The only way to move between USDC and
 * USYC is the Hashnote ERC-4626 Teller:
 *   - USDC -> USYC = deposit(assets, receiver)  (subscribe; yield on)
 *   - USYC -> USDC = redeem(shares, receiver, owner)  (redeem; yield off)
 *
 * We expose that as a synthetic single-venue swap route so the swap UI can
 * treat "convert USDC to USYC" like any other swap. The exchange rate comes
 * from the Teller's own previewDeposit / previewRedeem (exact, oracle-priced),
 * so the quote matches execution to the wei. The caller must be entitled or the
 * Teller reverts (surfaced as a normal swap failure).
 */
const lc = (a: string) => a.toLowerCase();

export const usycTellerV1Provider: RouteProvider = {
  meta: PROVIDER_META["usyc-teller"],

  async quote(req, publicClient) {
    if (req.amountIn === 0n) return null;
    const usdc = lc(ADDRESSES.usdc);
    const usyc = lc(USYC_ADDRESS);
    const tin = lc(req.tokenIn);
    const tout = lc(req.tokenOut);

    const isDeposit = tin === usdc && tout === usyc;
    const isRedeem = tin === usyc && tout === usdc;
    if (!isDeposit && !isRedeem) return null;

    let amountOut = 0n;
    try {
      amountOut = (await publicClient.readContract({
        address: USYC_TELLER_ADDRESS,
        abi: USYC_TELLER_ABI,
        functionName: isDeposit ? "previewDeposit" : "previewRedeem",
        args: [req.amountIn],
      })) as bigint;
    } catch {
      return null;
    }
    if (amountOut === 0n) return null;

    const executor: RouteQuote["executor"] = isDeposit
      ? {
          router: USYC_TELLER_ADDRESS,
          abi: USYC_TELLER_ABI,
          functionName: "deposit",
          args: [req.amountIn, req.recipient],
        }
      : {
          router: USYC_TELLER_ADDRESS,
          abi: USYC_TELLER_ABI,
          functionName: "redeem",
          args: [req.amountIn, req.recipient, req.recipient],
        };

    return {
      provider: "usyc-teller",
      amountOut,
      pathLabel: isDeposit ? "subscribe Circle" : "redeem Circle",
      approval: {
        token: req.tokenIn,
        spender: USYC_TELLER_ADDRESS,
        // Redeem burns the caller's own shares (owner == caller), so no USYC
        // approval is needed; deposit needs USDC approved to the Teller.
        amount: isDeposit ? req.amountIn : 0n,
      },
      executor,
    };
  },
};
