#!/usr/bin/env node
/**
 * Circle execution bridge for the Arcade agent demo.
 *
 * The Arcade agent API / MCP is NON-CUSTODIAL: it returns ready-to-sign
 * contract-call descriptors { contractAddress, abiFunctionSignature,
 * abiParameters }. This script is the piece that turns a descriptor into an
 * on-chain transaction, by signing + broadcasting it with an agent's OWN
 * Circle developer-controlled wallet on ARC-TESTNET. Arcade never sees the
 * keys; only Circle does.
 *
 * Use it in the demo so the agent can execute autonomously: it fetches a
 * descriptor from the MCP / REST API, then calls this to settle on Arc.
 *
 * Env (from your Circle console, https://console.circle.com):
 *   CIRCLE_API_KEY        - your API key
 *   CIRCLE_ENTITY_SECRET  - the 32-byte hex entity secret you registered
 *   CIRCLE_WALLET_ID      - the ARC-TESTNET developer-controlled wallet id
 *
 * Install (in agent-mcp/):
 *   npm install @circle-fin/developer-controlled-wallets
 *
 * Run:
 *   node circle-execute.mjs '{"contractAddress":"0x..","abiFunctionSignature":"approve(address,uint256)","abiParameters":["0x..","1000000"]}'
 *
 * Or pipe a whole calls[] array (runs them in order, e.g. approve then swap):
 *   node circle-execute.mjs '[{...approve...},{...swap...}]'
 */

import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const { CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID } = process.env;

function requireEnv() {
    const missing = [];
    if (!CIRCLE_API_KEY) missing.push("CIRCLE_API_KEY");
    if (!CIRCLE_ENTITY_SECRET) missing.push("CIRCLE_ENTITY_SECRET");
    if (!CIRCLE_WALLET_ID) missing.push("CIRCLE_WALLET_ID");
    if (missing.length) {
        console.error("Missing env: " + missing.join(", "));
        process.exit(1);
    }
}

const client = () =>
    initiateDeveloperControlledWalletsClient({
        apiKey: CIRCLE_API_KEY,
        entitySecret: CIRCLE_ENTITY_SECRET,
    });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Execute one descriptor and poll until the tx hash is known. */
async function executeOne(c, d) {
    if (!d || !d.contractAddress || !d.abiFunctionSignature) {
        throw new Error("descriptor needs contractAddress + abiFunctionSignature");
    }
    const created = await c.createContractExecutionTransaction({
        walletId: CIRCLE_WALLET_ID,
        contractAddress: d.contractAddress,
        abiFunctionSignature: d.abiFunctionSignature,
        abiParameters: d.abiParameters ?? [],
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const id = created.data?.id;
    if (!id) throw new Error("no transaction id returned");
    // Poll for the on-chain hash / final state.
    for (let i = 0; i < 40; i++) {
        const tx = (await c.getTransaction({ id })).data?.transaction;
        const state = tx?.state;
        if (tx?.txHash) return { id, state, txHash: tx.txHash };
        if (state === "FAILED" || state === "CANCELLED") {
            throw new Error(`tx ${id} ${state}: ${tx?.errorReason ?? ""}`);
        }
        await sleep(1500);
    }
    return { id, state: "PENDING", txHash: null };
}

async function main() {
    requireEnv();
    const arg = process.argv[2];
    if (!arg) {
        console.error("Pass a descriptor (or a calls[] array) as JSON.");
        process.exit(1);
    }
    let parsed;
    try {
        parsed = JSON.parse(arg);
    } catch {
        console.error("Argument is not valid JSON.");
        process.exit(1);
    }
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    const c = client();
    const results = [];
    for (const d of calls) {
        // Sequential: approve must confirm before the swap that spends it.
        const r = await executeOne(c, d);
        results.push({ fn: d.abiFunctionSignature, ...r });
        console.error(`[executed] ${d.abiFunctionSignature} -> ${r.txHash ?? r.state}`);
    }
    // Machine-readable result on stdout so an agent can read it back.
    console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((e) => {
    console.error("execute failed:", e?.message ?? e);
    process.exit(1);
});
