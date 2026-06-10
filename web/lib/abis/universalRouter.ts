// Uniswap V2 UniversalRouter execute() ABI. Both Synthra
// (0xbf4479...) and UnitFlow (0xEaF3...) ship vanilla forks of this
// contract on Arc testnet — same selector, same command set, same
// input shapes — so a single encoder can drive both.
//
// Commands we use (others exist; this is the working set):
//   0x00 V3_SWAP_EXACT_IN     — V3 exact-in along a path
//   0x02 PERMIT2_TRANSFER_FROM — pull tokens via Permit2's stored allowance
//   0x04 SWEEP                — send the router's balance of token to recipient
//   0x0a PERMIT2_PERMIT        — submit a Permit2.permitSingle signature
//   0x0b WRAP_ETH              — wrap msg.value (native USDC on Arc) into WUSDC
//   0x0c UNWRAP_WETH           — unwrap WUSDC back to native USDC

export const UNIVERSAL_ROUTER_ABI = [
    {
        type: "function",
        name: "execute",
        stateMutability: "payable",
        inputs: [
            { name: "commands", type: "bytes" },
            { name: "inputs", type: "bytes[]" },
            { name: "deadline", type: "uint256" },
        ],
        outputs: [],
    },
] as const;

/** Universal Router command opcodes. */
export const UR_COMMANDS = {
    V3_SWAP_EXACT_IN: 0x00,
    PERMIT2_TRANSFER_FROM: 0x02,
    SWEEP: 0x04,
    PERMIT2_PERMIT: 0x0a,
    WRAP_ETH: 0x0b,
    UNWRAP_WETH: 0x0c,
} as const;

/** Sentinel addresses recognised by Universal Router as recipients. */
export const UR_CONSTANTS = {
    /** Use the router's own balance of the input token (after a previous
     *  WRAP_ETH / TRANSFER_FROM populated it). Saves one Permit2 sig. */
    MSG_SENDER: "0x0000000000000000000000000000000000000001" as const,
    ROUTER_AS_RECIPIENT: "0x0000000000000000000000000000000000000002" as const,
    /** "Use the router's full balance of this token" as the amountIn. */
    CONTRACT_BALANCE: BigInt("0x8000000000000000000000000000000000000000000000000000000000000000"),
} as const;
