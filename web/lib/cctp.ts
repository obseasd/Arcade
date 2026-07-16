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

/** 'mainnet' iff NEXT_PUBLIC_CCTP_NETWORK is explicitly 'mainnet'; else
 *  'testnet'. Single source of truth so the Iris host, the CCTP V2 contract
 *  addresses, and the source-chain list all switch together. Defaults to
 *  testnet so existing deployments keep working without a config flip. */
export function cctpNetwork(): "mainnet" | "testnet" {
  return (process.env.NEXT_PUBLIC_CCTP_NETWORK ?? "").toLowerCase() === "mainnet"
    ? "mainnet"
    : "testnet";
}

// CCTP V2 TokenMessenger / MessageTransmitter are DETERMINISTIC (same address
// on every domain of a given environment), but they DIFFER between Circle's
// testnet and mainnet deployments. Selected by network so a mainnet flip does
// not silently keep burning through the testnet contracts.
// VERIFY the mainnet pair against https://developers.circle.com/cctp before the
// Arc mainnet cutover; they are unused until NEXT_PUBLIC_CCTP_NETWORK=mainnet.
const CCTP_V2_CONTRACTS = {
  testnet: {
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Address,
    messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as Address,
  },
  mainnet: {
    // VERIFY: Circle CCTP V2 mainnet deterministic addresses.
    tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as Address,
    messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" as Address,
  },
} as const;

export const CCTP_V2_TOKEN_MESSENGER: Address =
  CCTP_V2_CONTRACTS[cctpNetwork()].tokenMessenger;
export const CCTP_V2_MESSAGE_TRANSMITTER: Address =
  CCTP_V2_CONTRACTS[cctpNetwork()].messageTransmitter;

/**
 * Circle Iris attestation service hosts. The path
 * `/v2/messages/{srcDomain}?transactionHash=...` is identical on both
 * environments; only the host differs.
 *
 * Audit C-01 (2026-06-18): previously this was a single `IRIS_BASE_TESTNET`
 * constant pointed at the sandbox host with NO production switch. Every
 * mainnet bridge would have stalled at "Waiting for Circle attestation"
 * forever because sandbox never sees mainnet burns. Now env-gated via
 * `NEXT_PUBLIC_CCTP_NETWORK` (defaults to testnet so existing testnet
 * deployments keep working without a config flip).
 */
const IRIS_HOSTS = {
  testnet: "https://iris-api-sandbox.circle.com",
  mainnet: "https://iris-api.circle.com",
} as const;

function irisBase(): string {
  return cctpNetwork() === "mainnet" ? IRIS_HOSTS.mainnet : IRIS_HOSTS.testnet;
}

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
export const CCTP_CHAINS_TESTNET: CctpChainConfig[] = [
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

/**
 * Mainnet CCTP source/destination chains (Milestone 2 matrix). Arc is the
 * canonical destination. USDC addresses and CCTP V2 domains below are the
 * stable, well-known mainnet values; the ARC MAINNET entry is a PLACEHOLDER
 * pending Arc mainnet launch (Circle-assigned domain + the mainnet USDC +
 * RPC + explorer are TBD). Unused until NEXT_PUBLIC_CCTP_NETWORK=mainnet.
 *
 * VERIFY every row against https://developers.circle.com/cctp (domains + USDC)
 * and the Arc mainnet docs (the ARC entry) before the cutover.
 */
export const CCTP_CHAINS_MAINNET: CctpChainConfig[] = [
  {
    id: 1,
    name: "Ethereum",
    cctpDomain: 0,
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    rpc: "https://eth.llamarpc.com",
    explorer: "https://etherscan.io",
    confirmations: 12,
  },
  {
    id: 8453,
    name: "Base",
    cctpDomain: 6,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    confirmations: 5,
  },
  {
    id: 42_161,
    name: "Arbitrum One",
    cctpDomain: 3,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    rpc: "https://arb1.arbitrum.io/rpc",
    explorer: "https://arbiscan.io",
    confirmations: 5,
  },
  {
    id: 10,
    name: "Optimism",
    cctpDomain: 2,
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    rpc: "https://mainnet.optimism.io",
    explorer: "https://optimistic.etherscan.io",
    confirmations: 5,
  },
  {
    id: 137,
    name: "Polygon",
    cctpDomain: 7,
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    rpc: "https://polygon-rpc.com",
    explorer: "https://polygonscan.com",
    confirmations: 12,
  },
  {
    id: 43_114,
    name: "Avalanche",
    cctpDomain: 1,
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    explorer: "https://snowtrace.io",
    confirmations: 3,
  },
  {
    // PLACEHOLDER — Arc mainnet not live. VERIFY chainId, cctpDomain (Circle-
    // assigned), usdc, rpc, explorer against the Arc mainnet docs before use.
    id: 0,
    name: "Arc",
    cctpDomain: -1,
    usdc: "0x0000000000000000000000000000000000000000",
    rpc: "",
    explorer: "",
    confirmations: 3,
  },
];

/**
 * The active source/destination chain list, selected by NEXT_PUBLIC_CCTP_NETWORK
 * (testnet default). Every caller that iterates chains or looks one up by id
 * uses this, so the whole bridge UI flips network in one place.
 */
export const CCTP_CHAINS: CctpChainConfig[] =
  cctpNetwork() === "mainnet" ? CCTP_CHAINS_MAINNET : CCTP_CHAINS_TESTNET;

/**
 * Sentinel "chain id" for the Solana bridge family (non-EVM). It is
 * deliberately NOT in CCTP_CHAINS, so every EVM iteration / getCctpChain
 * lookup ignores it. The BridgeCard adds it to the chain picker and, when
 * a side equals this id, branches to the Circle App Kit Solana flow
 * instead of the EVM CCTP burn/mint path. Solana only bridges with Arc.
 */
export const SOLANA_BRIDGE_ID = 9_999_990_005;

export function isSolanaBridgeId(id: number): boolean {
  return id === SOLANA_BRIDGE_ID;
}

/**
 * Display-only pseudo-config so the BridgeCard chain boxes can render
 * Solana without `getCctpChain` returning undefined. The EVM fields are
 * dummies and must never drive an EVM op — the BridgeCard gates all EVM
 * reads/writes on `!solanaMode`.
 */
export const SOLANA_PSEUDO_CHAIN: CctpChainConfig = {
  id: SOLANA_BRIDGE_ID,
  name: "Solana Devnet",
  cctpDomain: 5,
  usdc: "0x0000000000000000000000000000000000000000",
  rpc: "",
  explorer: "https://explorer.solana.com",
  confirmations: 0,
};

export function getCctpChain(chainId: number): CctpChainConfig | undefined {
  return CCTP_CHAINS.find((c) => c.id === chainId);
}

/**
 * True iff a chain config is fully filled for a real burn/mint. Guards against a
 * PLACEHOLDER row (e.g. the Arc mainnet entry before its Circle-assigned domain
 * and mainnet USDC are known: cctpDomain -1, usdc 0x0). A -1 domain would throw
 * in viem's uint32 encoding at burn time anyway, but this lets the UI refuse
 * BEFORE granting the infinite USDC approval to the TokenMessenger.
 */
export function isBridgeableChain(chain: CctpChainConfig): boolean {
  return (
    chain.cctpDomain >= 0 &&
    chain.usdc !== "0x0000000000000000000000000000000000000000" &&
    chain.usdc.length === 42
  );
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
    type: "function",
    name: "depositForBurnWithHook",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
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

/** ArcadeCctpBuyReceiver on Arc: redeem an attested transfer and buy the
 *  committed token in one tx (see contracts/src/cctp/ArcadeCctpBuyReceiver.sol). */
export const CCTP_BUY_RECEIVER_ABI = [
  {
    type: "function",
    name: "receiveAndBuy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [],
  },
  {
    // Plain bridge (no buy): skims the fast-transfer fee and forwards the
    // remainder to the beneficiary encoded in the 32-byte hookData.
    type: "function",
    name: "receiveAndForward",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

// ============ Helpers ============

/** Pad an Ethereum address (20 bytes) to a 32-byte mintRecipient. */
export function addressToBytes32(addr: Address): `0x${string}` {
  return ("0x" + "00".repeat(12) + addr.slice(2).toLowerCase()) as `0x${string}`;
}

/**
 * Extract the mintRecipient address from a CCTP V2 message. It sits at byte
 * 184 (MessageV2 body @148 + BurnMessageV2 mintRecipient @36), left-padded in
 * a 32-byte word. Used at claim time to detect a "bridge and buy" transfer
 * (mintRecipient == ArcadeCctpBuyReceiver) so we route the claim through
 * receiveAndBuy instead of a plain receiveMessage — derived from the attested
 * message itself, so it survives a page refresh with no extra state. Returns
 * null on a malformed/short message.
 */
export function mintRecipientFromMessage(
  message: `0x${string}`,
): Address | null {
  const hex = message.slice(2);
  if (hex.length < (184 + 32) * 2) return null;
  const word = hex.slice(184 * 2, (184 + 32) * 2); // the 32-byte word
  return ("0x" + word.slice(24)) as Address; // low 20 bytes = the address
}

/**
 * Audit Bridge C-2: parse the fixed-layout header of a CCTP V2 message
 * blob. The on-chain MessageTransmitterV2 verifies Circle's signature on
 * the message, so a forged blob can never mint — BUT a MITM that swaps a
 * real Circle-signed message for a DIFFERENT burn (e.g. the attacker's
 * own earlier burn for the same domain pair) would still satisfy the
 * signature check, and the victim's wallet would pay gas to mint USDC
 * into the attacker's recipient.
 *
 * Defense: before passing the blob to receiveMessage(), parse the header
 * and assert sourceDomain / destinationDomain / mintRecipient match what
 * the user actually signed. Layout per Circle's CCTP V2 spec (NOT V1):
 *
 *   bytes 0-3   : version (uint32)
 *   bytes 4-7   : sourceDomain (uint32)
 *   bytes 8-11  : destinationDomain (uint32)
 *   bytes 12-43 : nonce (bytes32)    <- V2 widened nonce from uint64 to bytes32
 *   bytes 44-75 : sender (bytes32)
 *   bytes 76-107: recipient (bytes32)
 *   bytes 108-139: destinationCaller (bytes32)
 *   bytes 140-143: minFinalityThreshold (uint32)
 *   bytes 144-147: finalityThresholdExecuted (uint32)
 *   bytes 148+  : messageBody (TokenMessenger burn payload)
 *
 * The burn-message body for a V2 depositForBurn carries:
 *   body bytes 0-3   : body version (uint32)
 *   body bytes 4-35  : burnToken (bytes32)
 *   body bytes 36-67 : mintRecipient (bytes32)
 *   body bytes 68+   : amount, sender, fees, expiration, hookData
 *
 * BUG fix 2026-06-11: the previous header offset constants used CCTP V1's
 * 124-byte header (which assumed uint64 nonce). On V2 the header is 148
 * bytes, so the V1 offsets sliced 24 bytes too early -- mintRecipient
 * came out as part of burnToken + leading body bytes, never matched the
 * user's address, and BridgeCard's poll silently dropped every
 * attestation. Every CCTP V2 bridge was therefore stuck on "Waiting for
 * Circle attestation" forever even though Iris had `status: complete`.
 */
export interface ParsedCctpMessage {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: bigint;
  /**
   * Full bytes32 nonce as a 0x-prefixed hex string. Used as the
   * key into MessageTransmitter.usedNonces() for client-side
   * already-minted prechecks (audit 2026-06-18 M-06). The `nonce`
   * bigint above exposes only the low 8 bytes for legacy telemetry
   * and is NOT suitable as a usedNonces key on V2.
   */
  nonceHash: `0x${string}`;
  mintRecipient: `0x${string}`;
}

// CCTP V2 header is 148 bytes (V1 was 124 - nonce widened from uint64
// to bytes32). Body offset to mintRecipient is 36 (4 version + 32
// burnToken). Total minimum message length = 148 + 36 + 32 = 216 bytes
// = 432 hex chars.
const CCTP_V2_HEADER_BYTES = 148;
const CCTP_V2_BODY_MINT_RECIPIENT_OFFSET = 36;
const CCTP_V2_MIN_MESSAGE_HEX = (CCTP_V2_HEADER_BYTES + CCTP_V2_BODY_MINT_RECIPIENT_OFFSET + 32) * 2;

export function parseCctpV2Message(message: `0x${string}`): ParsedCctpMessage | null {
  if (!message.startsWith("0x")) return null;
  const hex = message.slice(2);
  if (hex.length < CCTP_V2_MIN_MESSAGE_HEX) return null;
  // Defensive: the mintRecipient slice must be EXACTLY 64 hex chars
  // (bytes32). A truncated message could produce a shorter mintRecipient
  // string whose `.toLowerCase()` then can't match the 64-char bytes32
  // we compare against.
  const mrStart = (CCTP_V2_HEADER_BYTES + CCTP_V2_BODY_MINT_RECIPIENT_OFFSET) * 2;
  const mrEnd = mrStart + 64;
  const mintRecipientHex = hex.slice(mrStart, mrEnd);
  if (mintRecipientHex.length !== 64) return null;
  const u32 = (offset: number) =>
    Number.parseInt(hex.slice(offset * 2, (offset + 4) * 2), 16);
  // V2 nonce is bytes32; we expose its low 8 bytes as a bigint for
  // backwards-compat with the existing ParsedCctpMessage.nonce field
  // (used in telemetry / debug logging only - the on-chain receiveMessage
  // never sees this parsed value, it gets the raw blob).
  const nonceBytes32 = (offset: number) =>
    BigInt("0x" + hex.slice((offset + 24) * 2, (offset + 32) * 2));
  try {
    const version = u32(0);
    const sourceDomain = u32(4);
    const destinationDomain = u32(8);
    const nonce = nonceBytes32(12);
    if (!Number.isFinite(version) || !Number.isFinite(sourceDomain) || !Number.isFinite(destinationDomain)) {
      return null;
    }
    const mintRecipient = ("0x" + mintRecipientHex) as `0x${string}`;
    // Full bytes32 nonce slice (bytes 12..43 of the message body).
    const nonceHash = ("0x" + hex.slice(12 * 2, 44 * 2)) as `0x${string}`;
    if (nonceHash.length !== 66) return null;
    return { version, sourceDomain, destinationDomain, nonce, nonceHash, mintRecipient };
  } catch {
    return null;
  }
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

/**
 * Audit Bridge M-1: distinguish "Iris service degraded" from "burn not
 * indexed yet" so the UI can surface a clear failure state after N
 * consecutive transient errors instead of leaving the user staring at
 * the spinner. Callers use `kind` to branch:
 *   - "complete" / "pending" : payload is valid (existing semantics)
 *   - "transient"            : 5xx, network error, parse failure -
 *                              keep polling but bump a retry counter
 *   - "missing"              : 404 / empty messages - burn not yet
 *                              indexed; keep polling silently
 */
export type IrisResult =
  | { kind: "complete"; payload: IrisAttestation }
  | { kind: "pending"; payload: IrisAttestation }
  | { kind: "transient"; reason: string }
  | { kind: "missing" };

export async function fetchAttestationDetailed(
  srcDomain: number,
  txHash: string,
): Promise<IrisResult> {
  const url = `${irisBase()}/v2/messages/${srcDomain}?transactionHash=${txHash}`;
  try {
    const res = await fetch(url);
    if (res.status === 404) return { kind: "missing" };
    if (res.status >= 500) return { kind: "transient", reason: `HTTP ${res.status}` };
    if (!res.ok) return { kind: "transient", reason: `HTTP ${res.status}` };
    const json = (await res.json()) as { messages?: unknown };
    const messages = Array.isArray(json?.messages) ? json.messages : null;
    if (!messages || messages.length === 0) return { kind: "missing" };
    const m = messages[0] as Record<string, unknown> | null;
    if (!m || typeof m !== "object") return { kind: "transient", reason: "bad-shape" };
    const status = m.status;
    if (status !== "pending_confirmations" && status !== "complete") {
      return { kind: "transient", reason: "bad-status" };
    }
    const payload: IrisAttestation = {
      attestation: isHexBlob(m.attestation) ? m.attestation : ("0x" as `0x${string}`),
      message: isHexBlob(m.message) ? m.message : ("0x" as `0x${string}`),
      status,
      eventNonce: typeof m.eventNonce === "string" ? m.eventNonce : undefined,
    };
    if (status === "complete") {
      if (!isHexBlob(m.attestation) || !isHexBlob(m.message)) {
        return { kind: "transient", reason: "bad-hex" };
      }
      return { kind: "complete", payload };
    }
    return { kind: "pending", payload };
  } catch (e) {
    return { kind: "transient", reason: e instanceof Error ? e.message : "network" };
  }
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
  const url = `${irisBase()}/v2/messages/${srcDomain}?transactionHash=${txHash}`;
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
