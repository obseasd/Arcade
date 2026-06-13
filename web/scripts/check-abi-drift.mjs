#!/usr/bin/env node
// Audit I4 fix: ABI drift CI check.
//
// web/lib/abis/autoCompounder.ts is a manually transcribed copy of the
// out-v3/ArcadeAutoCompounder.sol/ArcadeAutoCompounder.json artifact's
// `abi` field. The comment in the TS file promises 1:1 parity with the
// artifact, but nothing in CI verifies it. A subtle drift — adding a
// new function on chain without updating the TS literal, or vice
// versa — breaks every wagmi read silently with no diagnostic.
//
// This script:
//   1. Loads the v3-profile compiled JSON artifact.
//   2. Loads the TS ABI by parsing the AUTO_COMPOUNDER_ABI export.
//   3. Compares the function + event signatures on both sides.
//   4. Exits non-zero with a precise diff when they drift.
//
// The TS ABI is intentionally NARROWER than the JSON (the frontend
// only needs a subset of the contract's surface), so the check
// asserts that the TS surface is a STRICT SUBSET of the JSON surface
// and fails when the TS file references a function/event the
// contract no longer exposes. Adding new methods to the contract
// without adding them to the TS file is allowed (the frontend just
// doesn't use them).
//
// Usage:
//   node web/scripts/check-abi-drift.mjs
//
// Wire-up: add `node web/scripts/check-abi-drift.mjs` to the web-ci
// workflow's typecheck job so any drift fails the PR.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const ARTIFACT = path.join(
    repoRoot,
    "contracts",
    "out-v3",
    "ArcadeAutoCompounder.sol",
    "ArcadeAutoCompounder.json",
);
const TS_ABI_FILE = path.join(
    repoRoot,
    "web",
    "lib",
    "abis",
    "autoCompounder.ts",
);

function loadArtifactAbi() {
    if (!fs.existsSync(ARTIFACT)) {
        console.error(
            `[abi-drift] Artifact not found at ${ARTIFACT}. Run \`FOUNDRY_PROFILE=v3 forge build\` first.`,
        );
        process.exit(2);
    }
    const json = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
    return json.abi;
}

function loadTsAbi() {
    if (!fs.existsSync(TS_ABI_FILE)) {
        console.error(`[abi-drift] TS ABI not found at ${TS_ABI_FILE}`);
        process.exit(2);
    }
    // Strip the `as const` literal and parse the array body. We do
    // this by isolating the bracketed array between
    // `AUTO_COMPOUNDER_ABI = [` and `] as const;`. Robust enough for
    // this single file; for a more general solution we'd run the
    // TypeScript compiler API but that's overkill here.
    const src = fs.readFileSync(TS_ABI_FILE, "utf8");
    const start = src.indexOf("AUTO_COMPOUNDER_ABI = [");
    const end = src.indexOf("] as const;");
    if (start < 0 || end < 0) {
        console.error(
            "[abi-drift] Could not locate the AUTO_COMPOUNDER_ABI literal in the TS file. Did the export name change?",
        );
        process.exit(2);
    }
    // Reconstruct as a parseable expression: [ ... ]
    const arrayBody = src.substring(
        src.indexOf("[", start),
        end + 1,
    );
    // The body is TypeScript-flavoured (trailing commas, no quotes
    // around keys) but every object inside is JSON-shaped. The Node
    // VM's `eval` would work; using JSON.parse after a tiny
    // normalisation pass is safer (no arbitrary code execution).
    const jsonish = arrayBody
        // Add quotes around unquoted keys.
        .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
        // Drop trailing commas before } or ].
        .replace(/,(\s*[}\]])/g, "$1");
    try {
        return JSON.parse(jsonish);
    } catch (err) {
        console.error(
            `[abi-drift] Failed to parse TS ABI literal as JSON: ${err.message}`,
        );
        console.error("Reconstructed source:\n" + jsonish.slice(0, 400) + "...");
        process.exit(2);
    }
}

function signature(item) {
    if (item.type !== "function" && item.type !== "event") return null;
    // Selector-style signature: types only, no parameter names. This
    // matches the canonical Solidity 4-byte selector preimage, which
    // is what wagmi / viem use to dispatch calls.
    const inputs = (item.inputs || []).map((i) => i.type).join(",");
    return `${item.type} ${item.name}(${inputs})`;
}

function buildSignatureSet(abi) {
    const out = new Set();
    for (const item of abi) {
        const sig = signature(item);
        if (sig) out.add(sig);
    }
    return out;
}

const artifactAbi = loadArtifactAbi();
const tsAbi = loadTsAbi();

const artifactSigs = buildSignatureSet(artifactAbi);
const tsSigs = buildSignatureSet(tsAbi);

const missingOnChain = [];
for (const sig of tsSigs) {
    if (!artifactSigs.has(sig)) missingOnChain.push(sig);
}

if (missingOnChain.length > 0) {
    console.error(
        "[abi-drift] TS ABI references signatures the on-chain contract does not expose:",
    );
    for (const sig of missingOnChain) console.error("  -", sig);
    console.error(
        "\nEither update web/lib/abis/autoCompounder.ts to match out-v3/ArcadeAutoCompounder.sol/ArcadeAutoCompounder.json,",
    );
    console.error(
        "or rebuild the contract via `FOUNDRY_PROFILE=v3 forge build` if the artifact is stale.",
    );
    process.exit(1);
}

console.log(
    `[abi-drift] OK — ${tsSigs.size} TS signatures all present in the on-chain ABI (${artifactSigs.size} total).`,
);
