import {
    bytesToHex,
    getAddress,
    hashTypedData,
    hexToBytes,
    keccak256,
    recoverAddress,
    serializeSignature,
    type Address,
    type Hex,
    type HashTypedDataParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Backend claim signer with two interchangeable backends:
 *
 *  - **AWS KMS** (production / mainnet): the private key never leaves KMS. The
 *    escrow's `trustedSigner` is the Ethereum address DERIVED from the KMS
 *    public key. Enabled by setting `ARCADE_KMS_KEY_ID` (+ AWS creds/region).
 *  - **Local key** (testnet / dev): `ARCADE_BACKEND_PRIVATE_KEY`, the current
 *    behaviour. Used whenever KMS is not configured.
 *
 * Both produce a byte-identical EIP-712 signature: the escrow verifies it with
 * OpenZeppelin `ECDSA.recover`, which REQUIRES low-s (EIP-2) and v in {27,28}.
 * The KMS path normalises s to the lower half and recovers v by matching the
 * signer address, so a KMS signature is accepted by the exact same on-chain
 * `digest.recover(sig) == trustedSigner` check as a local one.
 *
 * KMS key requirements: asymmetric, key spec ECC_SECG_P256K1, usage SIGN_VERIFY.
 */

// secp256k1 group order (n) and n/2 for the EIP-2 low-s normalisation.
const SECP256K1_N =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

// ---------------------------------------------------------------------------
// AWS KMS SDK, loaded LAZILY via a variable specifier so the project builds +
// typechecks WITHOUT `@aws-sdk/client-kms` installed (the local-key path is
// unaffected). Install the SDK only when you actually enable KMS.
// ---------------------------------------------------------------------------
type KmsClientLike = {
    send: (cmd: unknown) => Promise<{ Signature?: Uint8Array; PublicKey?: Uint8Array }>;
};
let kmsPromise: Promise<{
    client: KmsClientLike;
    SignCommand: new (input: unknown) => unknown;
    GetPublicKeyCommand: new (input: unknown) => unknown;
}> | null = null;

function getKms() {
    if (!kmsPromise) {
        const modName = "@aws-sdk/client-kms";
        kmsPromise = (async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mod: any = await import(/* webpackIgnore: true */ modName);
            const region =
                process.env.ARCADE_KMS_REGION ?? process.env.AWS_REGION ?? "us-east-1";
            const client = new mod.KMSClient({ region }) as KmsClientLike;
            return {
                client,
                SignCommand: mod.SignCommand,
                GetPublicKeyCommand: mod.GetPublicKeyCommand,
            };
        })();
    }
    return kmsPromise;
}

function requireKmsKeyId(): string {
    const id = process.env.ARCADE_KMS_KEY_ID;
    if (!id) throw new Error("ARCADE_KMS_KEY_ID is not set");
    return id;
}

function bytesToBigInt(b: Uint8Array): bigint {
    let x = 0n;
    for (const byte of b) x = (x << 8n) | BigInt(byte);
    return x;
}

function toHex32(x: bigint): Hex {
    return `0x${x.toString(16).padStart(64, "0")}` as Hex;
}

/** Parse a DER-encoded ECDSA signature: SEQUENCE { INTEGER r, INTEGER s }. */
function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
    let o = 0;
    if (der[o++] !== 0x30) throw new Error("KMS sig: expected DER SEQUENCE");
    // Length byte(s). KMS ECDSA sigs are ~70-72 bytes so length fits in one byte.
    if (der[o] > 0x80) o += der[o] - 0x80 + 1;
    else o += 1;
    if (der[o++] !== 0x02) throw new Error("KMS sig: expected INTEGER r");
    const rLen = der[o++];
    const r = bytesToBigInt(der.slice(o, o + rLen));
    o += rLen;
    if (der[o++] !== 0x02) throw new Error("KMS sig: expected INTEGER s");
    const sLen = der[o++];
    const s = bytesToBigInt(der.slice(o, o + sLen));
    return { r, s };
}

let cachedKmsAddress: Address | null = null;

/** Ethereum address derived from the KMS public key (the escrow trustedSigner). */
export async function getKmsSignerAddress(): Promise<Address> {
    if (cachedKmsAddress) return cachedKmsAddress;
    const keyId = requireKmsKeyId();
    const { client, GetPublicKeyCommand } = await getKms();
    const out = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
    const der = out.PublicKey;
    if (!der) throw new Error("KMS: GetPublicKey returned no key");
    // A secp256k1 SPKI DER ends with the 65-byte uncompressed point 0x04||X||Y.
    const raw = der.slice(-65);
    if (raw[0] !== 0x04) throw new Error("KMS pubkey: unexpected encoding (want 0x04)");
    // Ethereum address = last 20 bytes of keccak256(pubkey without the 0x04 tag).
    const hash = keccak256(bytesToHex(raw.slice(1)));
    const address = getAddress(`0x${hash.slice(-40)}`);
    cachedKmsAddress = address;
    return address;
}

/** Sign a 32-byte EIP-712 digest with KMS -> a 65-byte low-s, v in {27,28} sig. */
async function signDigestWithKms(digest: Hex): Promise<Hex> {
    const keyId = requireKmsKeyId();
    const { client, SignCommand } = await getKms();
    const out = await client.send(
        new SignCommand({
            KeyId: keyId,
            Message: hexToBytes(digest),
            MessageType: "DIGEST",
            SigningAlgorithm: "ECDSA_SHA_256",
        }),
    );
    if (!out.Signature) throw new Error("KMS: Sign returned no signature");
    const { r, s: sRaw } = parseDerSignature(out.Signature);
    // EIP-2 low-s: OZ ECDSA.recover reverts on high-s (signature malleability).
    const s = sRaw > SECP256K1_HALF_N ? SECP256K1_N - sRaw : sRaw;
    const rHex = toHex32(r);
    const sHex = toHex32(s);
    // Recover v by trying both parities against the known signer address.
    const signer = await getKmsSignerAddress();
    for (const yParity of [0, 1] as const) {
        const signature = serializeSignature({ r: rHex, s: sHex, yParity });
        const recovered = await recoverAddress({ hash: digest, signature });
        if (recovered.toLowerCase() === signer.toLowerCase()) return signature;
    }
    throw new Error("KMS sig: could not recover v (signer mismatch)");
}

type SignTypedDataParams = HashTypedDataParameters;

export interface BackendClaimSigner {
    address: Address;
    signTypedData: (params: SignTypedDataParams) => Promise<Hex>;
}

function kmsConfigured(): boolean {
    return !!process.env.ARCADE_KMS_KEY_ID;
}

function localKey(): Hex | null {
    const k = process.env.ARCADE_BACKEND_PRIVATE_KEY;
    return k && /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : null;
}

/** True when EITHER backend (KMS or local key) is configured. */
export function backendSignerConfigured(): boolean {
    return kmsConfigured() || localKey() !== null;
}

/**
 * Resolve the active backend claim signer. Prefers KMS when `ARCADE_KMS_KEY_ID`
 * is set, else falls back to the local `ARCADE_BACKEND_PRIVATE_KEY`. Returns null
 * when neither is configured (caller should treat as server-misconfigured).
 */
export async function getBackendClaimSigner(): Promise<BackendClaimSigner | null> {
    if (kmsConfigured()) {
        const address = await getKmsSignerAddress();
        return {
            address,
            signTypedData: async (params) => signDigestWithKms(hashTypedData(params)),
        };
    }
    const key = localKey();
    if (key) {
        const account = privateKeyToAccount(key);
        return {
            address: account.address,
            signTypedData: (params) => account.signTypedData(params),
        };
    }
    return null;
}
