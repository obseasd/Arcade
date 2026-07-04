#!/usr/bin/env node
/**
 * One-shot Circle setup for the agent demo:
 *   1. generate + register an entity secret (one-time per Circle entity),
 *   2. create a wallet set + an ARC-TESTNET EOA wallet.
 *
 * Secrets are written to local files (gitignored) and NEVER printed, so they
 * stay on your machine. Only the non-secret wallet id + address are printed.
 *
 * Prereq: an API key in the Circle console. Run from agent-mcp/ after
 * `npm install`:
 *   export CIRCLE_API_KEY=...
 *   node setup-circle.mjs
 *
 * If an entity secret is ALREADY registered for this key, this exits with a
 * note: set CIRCLE_ENTITY_SECRET yourself and run create-wallet.mjs instead.
 */

import { writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import {
    registerEntitySecretCiphertext,
    initiateDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
if (!apiKey) {
    console.error("Set CIRCLE_API_KEY first.");
    process.exit(1);
}

async function main() {
    // 1) Entity secret: generate a 32-byte hex locally (silently, so it is
    //    never printed), register the ciphertext with Circle.
    const entitySecret = randomBytes(32).toString("hex");
    let recoveryFile;
    try {
        const reg = await registerEntitySecretCiphertext({ apiKey, entitySecret });
        recoveryFile = reg?.data?.recoveryFile;
    } catch (e) {
        console.error(
            "Entity secret registration failed (an entity secret may already be registered for this key):",
            e?.message ?? e,
        );
        console.error(
            "If you already have one, set CIRCLE_ENTITY_SECRET yourself and run create-wallet.mjs instead.",
        );
        process.exit(1);
    }
    writeFileSync(".circle-entity-secret", entitySecret, { mode: 0o600 });
    if (recoveryFile) writeFileSync(".circle-recovery.dat", recoveryFile, { mode: 0o600 });

    // 2) Wallet set + ARC-TESTNET EOA wallet (EOA so it pays USDC gas directly).
    const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
    const set = await client.createWalletSet({ name: "arcade-agent-demo" });
    const walletSetId = set?.data?.walletSet?.id;
    if (!walletSetId) throw new Error("no walletSetId returned");
    const w = await client.createWallets({
        walletSetId,
        blockchains: ["ARC-TESTNET"],
        accountType: "EOA",
        count: 1,
        idempotencyKey: randomUUID(),
    });
    const wallet = w?.data?.wallets?.[0];
    if (!wallet) throw new Error("no wallet returned");

    console.log("\nSetup complete.\n");
    console.log("  entity secret : saved to agent-mcp/.circle-entity-secret (KEEP IT; gitignored)");
    console.log("  recovery file : saved to agent-mcp/.circle-recovery.dat (KEEP IT)");
    console.log("  walletSetId   : " + walletSetId);
    console.log("  walletId      : " + wallet.id);
    console.log("  address       : " + wallet.address);
    console.log("\nFund the address with a few testnet USDC, then export:");
    console.log("  export CIRCLE_API_KEY=<your key>");
    console.log('  export CIRCLE_ENTITY_SECRET="$(cat .circle-entity-secret)"');
    console.log("  export CIRCLE_WALLET_ID=" + wallet.id);
}

main().catch((e) => {
    console.error("setup failed:", e?.message ?? e);
    process.exit(1);
});
