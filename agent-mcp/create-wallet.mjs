#!/usr/bin/env node
/**
 * One-time helper: provision an ARC-TESTNET developer-controlled Circle Wallet
 * for the agent demo, and print the wallet id + address to use as
 * CIRCLE_WALLET_ID in circle-execute.mjs.
 *
 * Prereqs (one-time, in the Circle console https://console.circle.com):
 *   - Create an API key.
 *   - Register an entity secret (32-byte hex) and keep it. The console shows a
 *     "register entity secret" step; do it once.
 *
 * Env:
 *   CIRCLE_API_KEY        - your API key
 *   CIRCLE_ENTITY_SECRET  - your registered 32-byte hex entity secret
 *
 * Run (from agent-mcp/, after `npm install`):
 *   node create-wallet.mjs
 *
 * Then fund the printed address with a few testnet USDC (it is also the gas
 * token on Arc) and set:
 *   export CIRCLE_WALLET_ID=<printed id>
 */

import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const { CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET } = process.env;
if (!CIRCLE_API_KEY || !CIRCLE_ENTITY_SECRET) {
    console.error("Set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET first.");
    process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({
    apiKey: CIRCLE_API_KEY,
    entitySecret: CIRCLE_ENTITY_SECRET,
});

async function main() {
    // 1) A wallet set groups wallets under one entity-secret-controlled key.
    const setRes = await client.createWalletSet({ name: "arcade-agent-demo" });
    const walletSetId = setRes.data?.walletSet?.id;
    if (!walletSetId) throw new Error("no walletSetId returned");

    // 2) An EOA wallet on Arc testnet. EOA (not SCA) so it pays USDC gas
    //    directly, which is the whole point on Arc.
    const wRes = await client.createWallets({
        walletSetId,
        blockchains: ["ARC-TESTNET"],
        accountType: "EOA",
        count: 1,
        idempotencyKey: randomUUID(),
    });
    const wallet = wRes.data?.wallets?.[0];
    if (!wallet) throw new Error("no wallet returned");

    console.log("\nArc testnet Circle wallet provisioned:\n");
    console.log("  walletSetId : " + walletSetId);
    console.log("  walletId    : " + wallet.id + "   <- use as CIRCLE_WALLET_ID");
    console.log("  address     : " + wallet.address);
    console.log("\nNext: fund the address with a few testnet USDC, then");
    console.log("export CIRCLE_WALLET_ID=" + wallet.id);
}

main().catch((e) => {
    console.error("create-wallet failed:", e?.message ?? e);
    process.exit(1);
});
