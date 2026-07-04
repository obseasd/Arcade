/**
 * USYC (Hashnote tokenized US T-Bills) on Arc Testnet.
 *
 * Address: 0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C
 * Symbol: USYC, decimals: 6 (same as USDC for easy 1:1 mental model).
 *
 * USYC is yield-bearing - ~4-5% APR sourced from Hashnote's US T-Bill
 * basket. Mint/redeem flows through a Teller contract and are gated by
 * Hashnote's entitlements list (= KYC). Holding USYC requires KYC; the
 * underlying ERC20 reads (balanceOf, totalSupply, symbol, decimals)
 * are fully public, which is what this minimal ABI covers.
 *
 * Mint/redeem is wired through the Hashnote Teller below (the wallet must be
 * entitled/whitelisted by Hashnote; a non-entitled wallet reverts).
 */

export const USYC_ADDRESS =
    "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C" as const;

/**
 * Hashnote Teller on Arc Testnet: the mint/redeem contract (separate from the
 * USYC ERC20). Addresses from the Hashnote USYC docs
 * (usyc.docs.hashnote.com/overview/smart-contracts), verified on-chain:
 * Teller.asset() == USDC and Teller.oracle() == USYC_ORACLE_ADDRESS.
 *
 * The Teller is an ERC-4626 vault (USDC = asset, USYC = share), verified by
 * decoding a real mint tx from the Hashnote dashboard:
 *   deposit(uint256 assets, address receiver) -> pull `assets` USDC (6dp),
 *       mint USYC shares to `receiver`. Selector 0x6e553f65.
 *   redeem(uint256 shares, address receiver, address owner) -> burn `shares`
 *       USYC from `owner`, send USDC to `receiver`. When owner == caller no
 *       USYC approval is needed.
 * Approve USDC to the Teller before deposit. USYC accrues yield, so the
 * exchange rate is ~1.13 USDC per USYC (read previewDeposit/previewRedeem for
 * the exact quote). Verified on-chain: deposit(1 USDC) minted ~0.884 USYC.
 */
export const USYC_TELLER_ADDRESS =
    "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A" as const;

export const USYC_ORACLE_ADDRESS =
    "0x52b56c7642E71dc54714d879127d97cd0B3D4581" as const;

export const USYC_TELLER_ABI = [
    {
        type: "function",
        name: "deposit",
        stateMutability: "nonpayable",
        inputs: [
            { name: "assets", type: "uint256" },
            { name: "receiver", type: "address" },
        ],
        outputs: [{ name: "shares", type: "uint256" }],
    },
    {
        type: "function",
        name: "redeem",
        stateMutability: "nonpayable",
        inputs: [
            { name: "shares", type: "uint256" },
            { name: "receiver", type: "address" },
            { name: "owner", type: "address" },
        ],
        outputs: [{ name: "assets", type: "uint256" }],
    },
    {
        type: "function",
        name: "previewDeposit",
        stateMutability: "view",
        inputs: [{ name: "assets", type: "uint256" }],
        outputs: [{ name: "shares", type: "uint256" }],
    },
    {
        type: "function",
        name: "previewRedeem",
        stateMutability: "view",
        inputs: [{ name: "shares", type: "uint256" }],
        outputs: [{ name: "assets", type: "uint256" }],
    },
    {
        type: "function",
        name: "asset",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
] as const;

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
