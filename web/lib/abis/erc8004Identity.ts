/**
 * Arc Identity Registry (ERC-8004) on Arc Testnet.
 *
 * Address: 0x8004A818BFB912233c491871b3d84c89A494BD9e
 *
 * ERC-8004 is Arc's native agent-identity standard: mint an
 * ERC-721 whose tokenURI points to a metadata JSON describing the
 * agent (or in our case the creator). The standard is intentionally
 * minimal — it's a thin convention around ownership + URI — so we
 * keep the ABI surface to the fields we actually consume (mint,
 * tokenURI, balanceOf, idsForOwner if exposed).
 *
 * For Arcade we use it to let Diamond-tier creators (10+ bonded
 * launches) mint a "Diamond Creator" Identity NFT. The NFT becomes
 * a portable, cross-app reputation marker on Arc: other dapps can
 * read this contract to gate VIP features, leaderboards, etc.
 */

export const ERC_8004_IDENTITY_ADDRESS =
    "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;

export const ERC_8004_IDENTITY_ABI = [
    {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "owner", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "function",
        name: "ownerOf",
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        name: "tokenURI",
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "", type: "string" }],
    },
    {
        type: "function",
        name: "tokenOfOwnerByIndex",
        stateMutability: "view",
        inputs: [
            { name: "owner", type: "address" },
            { name: "index", type: "uint256" },
        ],
        outputs: [{ name: "", type: "uint256" }],
    },
    // Registration surface. The live Arc registry gates `mint(address,
    // string)` to an internal authorized minter (reverts for both EOAs
    // and our Issuer — verified on-chain 2026-06-21), so that path never
    // worked. The standard's permissionless self-registration is
    // `register(string uri)`, which mints to msg.sender and returns the
    // agentId — verified working on-chain from a fresh EOA. This is the
    // function the UI must call (directly from the creator's wallet; a
    // third party can't register on someone's behalf).
    {
        type: "function",
        name: "register",
        stateMutability: "nonpayable",
        inputs: [{ name: "uri", type: "string" }],
        outputs: [{ name: "agentId", type: "uint256" }],
    },
    // Legacy gated mint — kept for ABI completeness / reads, but the UI
    // no longer calls it (it reverts on the live registry).
    {
        type: "function",
        name: "mint",
        stateMutability: "nonpayable",
        inputs: [
            { name: "to", type: "address" },
            { name: "uri", type: "string" },
        ],
        outputs: [{ name: "tokenId", type: "uint256" }],
    },
    // Audit 2026-06-18 H-10: burn surface for the tier-upgrade flow.
    // The previous mint path locked the metadata URI on-chain
    // forever, so a creator who hit Silver, minted, then graduated to
    // Gold would have a permanent Silver NFT in their wallet. Burn +
    // re-mint refreshes the metadata to match current tier. Standard
    // ERC-721 burn signature; the Arc Identity Registry exposes it.
    {
        type: "function",
        name: "burn",
        stateMutability: "nonpayable",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [],
    },
    {
        type: "event",
        name: "Transfer",
        inputs: [
            { name: "from", type: "address", indexed: true },
            { name: "to", type: "address", indexed: true },
            { name: "tokenId", type: "uint256", indexed: true },
        ],
    },
] as const;
