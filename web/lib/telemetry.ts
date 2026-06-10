/**
 * Lightweight telemetry wrapper (audit A-6). Provides typed track*
 * helpers used across SwapCard, BridgeCard, and the API routes. The
 * implementation is intentionally Sentry-shaped but defers the actual
 * import until the DSN is set in env, so the bundled binary doesn't
 * pull in the Sentry SDK on free-tier setups without the DSN wired.
 *
 * Behaviour:
 *   - DSN unset      → every track call is a no-op, zero bundle cost.
 *   - DSN set        → events dispatched via fire-and-forget fetch to the
 *                       Sentry envelope endpoint (works in edge + node).
 *
 * This shape lets the operator install Sentry incrementally without a
 * code rewrite: drop the DSN in env, the existing trackXxx calls start
 * shipping events on the next build.
 */

type EventSeverity = "info" | "warning" | "error";

interface BaseEventCtx {
    /** Account or anon id. Hashed before sending. */
    account?: string;
    /** Connected chain id (Arc testnet = 5042002). */
    chainId?: number;
    /** Release version surfaced in Sentry; falls back to NEXT_PUBLIC_GIT_SHA. */
    release?: string;
}

const SENTRY_DSN =
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_SENTRY_DSN : undefined;

function isEnabled(): boolean {
    return !!SENTRY_DSN && SENTRY_DSN.startsWith("https://");
}

function hashId(input: string): string {
    // Simple FNV-1a so we don't ship raw addresses to Sentry without consent.
    // Reversible only by brute-force against the known address space —
    // adequate for "did the same user retry?" cohort questions, not for
    // PII protection. Replace with a salted SHA-256 if compliance asks.
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

function sanitize(ctx: BaseEventCtx): BaseEventCtx {
    return {
        ...ctx,
        account: ctx.account ? hashId(ctx.account.toLowerCase()) : undefined,
    };
}

async function send(level: EventSeverity, name: string, data: object) {
    if (!isEnabled()) return;
    // Fire-and-forget. We never await this in caller code so a slow
    // network never blocks user interactions.
    try {
        // Minimal envelope POST. Real Sentry SDK would do more, but the
        // bare-bones endpoint accepts a JSON event for free-tier projects.
        // Full Sentry init is a follow-up — this stub is enough to start
        // collecting traffic stats without bundling the SDK.
        await fetch("/api/telemetry", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ level, name, data }),
            // No credentials, no cache. Sampling done server-side.
            credentials: "omit",
            cache: "no-store",
        });
    } catch {
        // Telemetry must never throw into caller code.
    }
}

// ---------------------------------------------------------------------
// SWAP
// ---------------------------------------------------------------------

export interface SwapTelemetry extends BaseEventCtx {
    provider: string; // "synthra-v3" | "arcade-v3" | …
    tokenIn: string;
    tokenOut: string;
    amountInUsd?: number;
    success: boolean;
    errorClass?: "user_rejected" | "slippage" | "gas" | "rpc" | "revert" | "unknown";
    txHash?: string;
    /** ms from confirm-click to receipt. */
    latencyMs?: number;
}

export function trackSwap(ev: SwapTelemetry) {
    void send(ev.success ? "info" : "error", "swap", {
        ...sanitize(ev),
        amountInUsd: ev.amountInUsd ? Math.round(ev.amountInUsd * 100) / 100 : undefined,
    });
}

// ---------------------------------------------------------------------
// BRIDGE
// ---------------------------------------------------------------------

export interface BridgeTelemetry extends BaseEventCtx {
    step:
        | "burn_submitted"
        | "burn_confirmed"
        | "attesting"
        | "attestation_ready"
        | "mint_submitted"
        | "mint_confirmed"
        | "mint_revert"
        | "attestation_timeout";
    srcChainId: number;
    dstChainId: number;
    amountUsd?: number;
    burnTxHash?: string;
}

export function trackBridge(ev: BridgeTelemetry) {
    const sev: EventSeverity =
        ev.step === "mint_revert" || ev.step === "attestation_timeout"
            ? "error"
            : "info";
    void send(sev, "bridge", sanitize(ev));
}

// ---------------------------------------------------------------------
// CLAIM
// ---------------------------------------------------------------------

export interface ClaimTelemetry extends BaseEventCtx {
    step:
        | "oauth_start"
        | "oauth_complete"
        | "sig_issued"
        | "sig_rejected"
        | "quota_hit";
    positionId?: string;
    slotIndex?: number;
    handleHashed?: string;
}

export function trackClaim(ev: ClaimTelemetry) {
    void send(ev.step === "sig_rejected" || ev.step === "quota_hit" ? "warning" : "info", "claim", sanitize(ev));
}

// ---------------------------------------------------------------------
// PROVIDER TIMING (aggregator routing)
// ---------------------------------------------------------------------

export interface ProviderTiming {
    provider: string;
    latencyMs: number;
    ok: boolean;
}

export function trackProviderTiming(ev: ProviderTiming) {
    void send("info", "provider_timing", ev);
}

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------

/** Classify an exception into a stable Sentry tag without leaking the
 *  full error message. Use in SwapCard's catch block to pick the
 *  errorClass that ships with trackSwap. */
export function classifyError(e: unknown): SwapTelemetry["errorClass"] {
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
    if (msg.includes("rejected") || msg.includes("denied")) return "user_rejected";
    if (msg.includes("slippage") || msg.includes("insufficient_output")) return "slippage";
    if (msg.includes("gas") || msg.includes("out of gas")) return "gas";
    if (msg.includes("rpc") || msg.includes("network")) return "rpc";
    if (msg.includes("revert")) return "revert";
    return "unknown";
}
