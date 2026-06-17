/**
 * USYC (Hashnote tokenized US T-Bills) on Arc Testnet.
 *
 * Address: 0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C
 * Symbol: USYC, decimals: 6 (same as USDC for easy 1:1 mental model).
 *
 * USYC is yield-bearing — ~4-5% APR sourced from Hashnote's US T-Bill
 * basket. Mint/redeem flows through a Teller contract and are gated by
 * Hashnote's entitlements list (= KYC). Holding USYC requires KYC; the
 * underlying ERC20 reads (balanceOf, totalSupply, symbol, decimals)
 * are fully public, which is what this minimal ABI covers.
 *
 * Future work: wire the Teller contract + entitlements UI when we have
 * a KYC-applied treasury wallet or a per-user KYC flow.
 */

export const USYC_ADDRESS =
    "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C" as const;

export const USYC_HASHNOTE_PRODUCT_URL =
    "https://www.hashnote.com/products/usyc";

export const USYC_ABI = [
    {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "totalSupply",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "decimals",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint8" }],
    },
    {
        type: "function",
        name: "symbol",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "string" }],
    },
] as const;
