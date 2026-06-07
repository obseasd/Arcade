import { Address } from "viem";

/**
 * Circle Cross-Chain Transfer Protocol (CCTP V2) configuration.
 *
 * All CCTP V2 EVM contracts share the same addresses across every supported
 * testnet - Circle deploys them deterministically. The only per-chain values
 * are the chain ID, the USDC ERC20 address, and the CCTP "domain" (an
 * integer that uniquely identifies the chain inside CCTP messages).
 *
 * Flow:
 *   1. user → `TokenMessengerV2.depositForBurn(amount, dstDomain, mintRecipient32, burnToken)`
 *      on the source chain → burns USDC, emits a Message event
 *   2. Circle's Iris attestation service signs the message after some
 *      confirmations. We poll `IRIS_BASE/v2/messages/{srcDomain}?transactionHash={hash}`
 *   3. user → `MessageTransmitterV2.receiveMessage(message, attestation)` on
 *      the destination chain → mints USDC to the recipient
 */

export const CCTP_V2_TOKEN_MESSENGER: Address = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
export const CCTP_V2_MESSAGE_TRANSMITTER: Address = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";

const IRIS_BASE_TESTNET = "https://iris-api-sandbox.circle.com";

export interface CctpChainConfig {
  /** EVM chain ID */
  id: number;
  name: string;
  /** CCTP V2 domain identifier */
  cctpDomain: number;
  /** Native USDC ERC20 address on this chain */
  usdc: Address;
  rpc: string;
  explorer: string;
  /** Block confirmations Circle waits before attesting (used for UI ETA only). */
  confirmations: number;
}

/**
 * Testnet CCTP source/destination chains. Arc testnet is the *destination* for
 * Arcade, but it can also be a source (e.g. to send USDC back out).
 */
export const CCTP_CHAINS: CctpChainConfig[] = [
  {
    id: 11_155_111,
    name: "Ethereum Sepolia",
    cctpDomain: 0,
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    rpc: "https://sepolia.drpc.org",
    explorer: "https://sepolia.etherscan.io",
    confirmations: 12,
  },
  {
    id: 84_532,
    name: "Base Sepolia",
    cctpDomain: 6,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    confirmations: 5,
  },
  {
    id: 421_614,
    name: "Arbitrum Sepolia",
    cctpDomain: 3,
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    rpc: "https://sepolia-rollup.arbitrum.io/rpc",
    explorer: "https://sepolia.arbiscan.io",
    confirmations: 5,
  },
  {
    id: 11_155_420,
    name: "OP Sepolia",
    cctpDomain: 2,
    usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
    rpc: "https://sepolia.optimism.io",
    explorer: "https://sepolia-optimism.etherscan.io",
    confirmations: 5,
  },
  {
    id: 43_113,
    name: "Avalanche Fuji",
    cctpDomain: 1,
    usdc: "0x5425890298aed601595a70AB815c96711a31Bc65",
    rpc: "https://api.avax-test.network/ext/bc/C/rpc",
    explorer: "https://testnet.snowtrace.io",
    confirmations: 3,
  },
  {
    id: 5_042_002,
    name: "Arc Testnet",
    cctpDomain: 26,
    usdc: "0x3600000000000000000000000000000000000000",
    rpc: "https://5042002.rpc.thirdweb.com",
    explorer: "https://testnet.arcscan.app",
    confirmations: 3,
  },
];

export function getCctpChain(chainId: number): CctpChainConfig | undefined {
  return CCTP_CHAINS.find((c) => c.id === chainId);
}

// ============ ABIs ============

export const TOKEN_MESSENGER_V2_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "DepositForBurn",
    inputs: [
      { name: "burnToken", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "depositor", type: "address", indexed: true },
      { name: "mintRecipient", type: "bytes32", indexed: false },
      { name: "destinationDomain", type: "uint32", indexed: false },
      { name: "destinationTokenMessenger", type: "bytes32", indexed: false },
      { name: "destinationCaller", type: "bytes32", indexed: false },
    ],
  },
] as const;

export const MESSAGE_TRANSMITTER_V2_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "usedNonces",
    stateMutability: "view",
    inputs: [{ name: "nonceHash", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// ============ Helpers ============

/** Pad an Ethereum address (20 bytes) to a 32-byte mintRecipient. */
export function addressToBytes32(addr: Address): `0x${string}` {
  return ("0x" + "00".repeat(12) + addr.slice(2).toLowerCase()) as `0x${string}`;
}

/** Poll Circle's attestation service. Returns the signed attestation + message bytes. */
export interface IrisAttestation {
  attestation: `0x${string}`;
  message: `0x${string}`;
  status: "pending_confirmations" | "complete";
  eventNonce?: string;
}

/** True iff `v` looks like a hex blob `0x[0-9a-f]+` with no garbage. */
function isHexBlob(v: unknown): v is `0x${string}` {
  return typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) && v.length >= 4;
}

export async function fetchAttestation(
  srcDomain: number,
  txHash: string,
): Promise<IrisAttestation | null> {
  // BRIDGE-IRIS-NO-RESPONSE-VALIDATION: validate every field before
  // forwarding to receiveMessage(). Without these checks an unexpected
  // Iris payload (DNS poison, MITM, Circle API regression returning
  // null fields with status: "complete") would land the user in the
  // 'minting' state with `null` hex blobs, the wallet rejection on
  // signing would be the only signal it ever went wrong.
  const url = `${IRIS_BASE_TESTNET}/v2/messages/${srcDomain}?transactionHash=${txHash}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { messages?: unknown };
    const messages = Array.isArray(json?.messages) ? json.messages : null;
    if (!messages || messages.length === 0) return null;
    const m = messages[0] as Record<string, unknown> | null;
    if (!m || typeof m !== "object") return null;

    const status = m.status;
    if (status !== "pending_confirmations" && status !== "complete") {
      return null;
    }
    // Pending: fields may still be absent/null. Surface the status so
    // the caller knows to keep polling.
    if (status === "pending_confirmations") {
      return {
        attestation: "0x" as `0x${string}`,
        message: "0x" as `0x${string}`,
        status,
        eventNonce: typeof m.eventNonce === "string" ? m.eventNonce : undefined,
      };
    }
    // Complete: both blobs must be syntactically valid hex.
    if (!isHexBlob(m.attestation) || !isHexBlob(m.message)) return null;
    return {
      attestation: m.attestation,
      message: m.message,
      status,
      eventNonce: typeof m.eventNonce === "string" ? m.eventNonce : undefined,
    };
  } catch {
    return null;
  }
}
