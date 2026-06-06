/**
 * Shared chunked-getLogs walker. Replaces ~6 inline copies that lived
 * across web/lib/hooks/ before the 2026-06-06 cleanup pass.
 *
 * The walk runs BACKWARDS from `latest` toward `latest - maxBack`, pulling
 * `chunk` blocks at a time. Stops on: head-reached (block 0), early-exit
 * count, hard maxBack budget, or repeated RPC failures.
 *
 * Why a shared module: every hook had slightly different error handling
 * (some swallowed all errors, some bailed after 3, some narrowed the chunk
 * on first failure). The cumulative behaviour was inconsistent under RPC
 * stress. One implementation, one set of failure modes.
 */

import { Address } from "viem";

/** Per-call block window for the official Arc RPC. Small + safe. */
export const CHUNK_SMALL = 1_000n;
/** Mid-window for holders / candles where we walk wider history. */
export const CHUNK_MEDIUM = 5_000n;
/** Largest window we attempt. Use only on the thirdweb proxy. */
export const CHUNK_LARGE = 10_000n;

/** Default cap on how far back we walk total. ~5-7 days on a 1s-block chain. */
export const MAX_BACK_BLOCKS = 500_000n;
/** Tighter cap for trade history that's chart-rendered. */
export const MAX_BACK_TRADES = 200_000n;
/** Even tighter for short-window candles. */
export const MAX_BACK_CANDLES = 100_000n;

export interface ScanOptions {
    /** Block window per RPC call. Default CHUNK_SMALL. */
    chunk?: bigint;
    /** Maximum blocks to walk total. Default MAX_BACK_BLOCKS. */
    maxBack?: bigint;
    /** Stop early once collected logs reach this count. Default no limit. */
    earlyExit?: number;
    /** Hard stop after this many consecutive getLogs failures. Default 3. */
    maxErrors?: number;
    /** Log label surfaced in console.warn on terminal failure. */
    label?: string;
}

/**
 * Walk getLogs in `chunk`-sized backwards windows, returning every matching
 * log up to `maxBack` blocks or `earlyExit` count.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function scanLogsChunked<T = any>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    params: {
        address: Address;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        event: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args?: Record<string, any>;
    },
    latest: bigint,
    options: ScanOptions = {},
): Promise<T[]> {
    const chunk = options.chunk ?? CHUNK_SMALL;
    const maxBack = options.maxBack ?? MAX_BACK_BLOCKS;
    const earlyExit = options.earlyExit;
    const maxErrors = options.maxErrors ?? 3;
    const label = options.label;

    const out: T[] = [];
    let end = latest;
    let walked = 0n;
    let errors = 0;

    while (walked < maxBack) {
        const start = end > chunk - 1n ? end - (chunk - 1n) : 0n;
        try {
            const logs = await publicClient.getLogs({
                ...params,
                fromBlock: start,
                toBlock: end,
            });
            out.push(...logs);
            errors = 0;
        } catch (err) {
            errors += 1;
            if (errors > maxErrors) {
                if (label) {
                    // eslint-disable-next-line no-console
                    console.warn(
                        `[eventScan] ${label} getLogs failed (${errors} times), stopping. last err:`,
                        err,
                    );
                }
                break;
            }
        }
        if (start === 0n) break;
        if (earlyExit !== undefined && out.length >= earlyExit) break;
        walked += end - start + 1n;
        end = start - 1n;
    }
    return out;
}
