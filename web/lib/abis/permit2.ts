// Permit2 ABI — the subset our integration uses.
// Canonical deployment on Arc testnet: 0x000000000022D473030F116dDEE9F6B43aC78BA3
//
// AllowanceTransfer mode (what UniversalRouter uses):
//   1. User does `IERC20(token).approve(PERMIT2, type(uint256).max)` ONE TIME.
//   2. For each swap the dapp signs a `PermitSingle` EIP-712 message authorising
//      a specific `spender` (the UniversalRouter) for `amount` until `expiration`.
//   3. The dapp puts the signed permit into a `PERMIT2_PERMIT` Universal Router
//      command, then a `PERMIT2_TRANSFER_FROM` pulls the tokens from the user.
//
// allowance() lets us read the (amount, expiration, nonce) triple so we can
// (a) skip prompting if a valid in-date allowance already exists,
// (b) supply the right nonce in the next signature.

export const PERMIT2_ABI = [
    {
        type: "function",
        name: "allowance",
        stateMutability: "view",
        inputs: [
            { name: "user", type: "address" },
            { name: "token", type: "address" },
            { name: "spender", type: "address" },
        ],
        outputs: [
            { name: "amount", type: "uint160" },
            { name: "expiration", type: "uint48" },
            { name: "nonce", type: "uint48" },
        ],
    },
    // approve(token, spender, amount, expiration) for direct AllowanceTransfer use.
    // The Universal Router PERMIT2_PERMIT command runs the signed-permit code path
    // server-side; we only need approve() if we ever want the dapp to set the
    // allowance directly without a sig (debug + scripted tests).
    {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
            { name: "token", type: "address" },
            { name: "spender", type: "address" },
            { name: "amount", type: "uint160" },
            { name: "expiration", type: "uint48" },
        ],
        outputs: [],
    },
] as const;

/** Canonical Permit2 deployment address — same on every chain that has it. */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/** Default expiration window for a signed permit (1 hour). The on-chain
 *  uint48 means the absolute timestamp must fit in 48 bits; 1 h from now
 *  on any reasonable EVM clock fits comfortably. */
export const PERMIT2_DEFAULT_EXPIRATION_SECONDS = 60 * 60;
