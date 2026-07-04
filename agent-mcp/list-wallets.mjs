#!/usr/bin/env node
/**
 * Recover the developer-controlled Circle Wallet(s) already provisioned for the
 * agent demo, without creating a new one. Prints each wallet's id + address +
 * blockchain so you can pick the funded ARC-TESTNET one for CIRCLE_WALLET_ID.
 *
 * Reads the entity secret from the local (gitignored) .circle-entity-secret
 * file so you never have to paste it. API key comes from the env.
 *
 * Run (from agent-mcp/, after `npm install`):
 *   export CIRCLE_API_KEY=<your key>
 *   node list-wallets.mjs
 */

import { readFileSync } from "node:fs";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
if (!apiKey) {
    console.error("Set CIRCLE_API_KEY first (export CIRCLE_API_KEY=...).");
    process.exit(1);
}

let entitySecret = process.env.CIRCLE_ENTITY_SECRET;
if (!entitySecret) {
    try {
        entitySecret = readFileSync(".circle-entity-secret", "utf8").trim();
    } catch {
        console.error(
            "No CIRCLE_ENTITY_SECRET env and no .circle-entity-secret file found in this dir. Run from agent-mcp/.",
        );
        process.exit(1);
    }
}

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

async function main() {
    const res = await client.listWallets({});
    const wallets = res?.data?.wallets ?? [];
    if (!wallets.length) {
        console.log("No wallets found for this entity. Run setup-circle.mjs or create-wallet.mjs.");
        return;
    }
    console.log(`\n${wallets.length} wallet(s):\n`);
    for (const w of wallets) {
        console.log(`  address   : ${w.address}`);
        console.log(`  walletId  : ${w.id}   <- CIRCLE_WALLET_ID`);
        console.log(`  blockchain: ${w.blockchain}   state: ${w.state}`);
        console.log("");
    }
    console.log("Pick the ARC-TESTNET one you funded, then:");
    console.log("  export CIRCLE_WALLET_ID=<its walletId>");
}

main().catch((e) => {
    console.error("list-wallets failed:", e?.message ?? e);
    process.exit(1);
});
