#!/usr/bin/env node
/**
 * One-command agent demo: fetch a build-plan from the Arcade agent API, then
 * settle every returned descriptor on-chain with the agent's OWN Circle
 * developer-controlled wallet. This is the full non-custodial loop in a single
 * command, ideal for the demo video:
 *
 *   agent asks Arcade "how do I swap 1 USDC to cirBTC?"  (Arcade = read-only brain)
 *   Arcade returns ordered contract-call descriptors     (no keys involved)
 *   the agent signs + broadcasts them with its Circle Wallet
 *
 * Usage (from agent-mcp/):
 *   node run-agent.mjs <endpoint> '<jsonBody>'
 *
 * Examples:
 *   node run-agent.mjs quote     '{"tokenIn":"USDC","tokenOut":"cirBTC","amountIn":"1000000"}'
 *   node run-agent.mjs swap      '{"tokenIn":"USDC","tokenOut":"cirBTC","amountIn":"1000000","recipient":"'$CIRCLE_WALLET_ADDRESS'"}'
 *   node run-agent.mjs launchpad '{"action":"buy","token":"0x..","amountUsdcIn":"1000000"}'
 *   node run-agent.mjs usyc      '{"action":"deposit","amountIn":"1000000","recipient":"'$CIRCLE_WALLET_ADDRESS'"}'
 *
 * quote is read-only (prints the quote, executes nothing). swap / launchpad /
 * multiswap / usyc build calls[] and execute them in order.
 *
 * Env:
 *   ARCADE_BASE           - default https://www.arcade.trading/api/agent
 *                           (set http://localhost:3000/api/agent to test local)
 *   CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID - to execute.
 *                           Not needed for read-only endpoints (quote/markets/...).
 */

import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const BASE = process.env.ARCADE_BASE || "https://www.arcade.trading/api/agent";
const READ_ONLY = new Set(["quote", "markets", "trending", "portfolio"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function executeOne(c, walletId, d) {
    if (!d?.contractAddress || !d?.abiFunctionSignature)
        throw new Error("descriptor needs contractAddress + abiFunctionSignature");
    const created = await c.createContractExecutionTransaction({
        walletId,
        contractAddress: d.contractAddress,
        abiFunctionSignature: d.abiFunctionSignature,
        abiParameters: d.abiParameters ?? [],
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const id = created.data?.id;
    if (!id) throw new Error("no transaction id returned");
    for (let i = 0; i < 40; i++) {
        const tx = (await c.getTransaction({ id })).data?.transaction;
        if (tx?.txHash) return { id, state: tx.state, txHash: tx.txHash };
        if (tx?.state === "FAILED" || tx?.state === "CANCELLED")
            throw new Error(`tx ${id} ${tx.state}: ${tx?.errorReason ?? ""}`);
        await sleep(1500);
    }
    return { id, state: "PENDING", txHash: null };
}

async function main() {
    const endpoint = process.argv[2];
    const bodyArg = process.argv[3];
    if (!endpoint) {
        console.error("Usage: node run-agent.mjs <endpoint> '<jsonBody>'");
        process.exit(1);
    }
    const isRead = READ_ONLY.has(endpoint);
    const url = `${BASE}/${endpoint}`;

    // 1) Ask Arcade for the plan (read) or descriptors (build).
    let res;
    if (isRead && !bodyArg) {
        res = await fetch(url);
    } else {
        res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: bodyArg ?? "{}",
        });
    }
    const plan = await res.json();
    console.error(`\n[arcade ${endpoint}] ->`);
    console.error(JSON.stringify(plan, null, 2));

    if (isRead) {
        console.log(JSON.stringify(plan, null, 2));
        return;
    }
    if (plan.ok === false) {
        console.error(`\nArcade refused: ${plan.error ?? plan.reason ?? "unknown"}`);
        process.exit(1);
    }

    // 2) Wallet needed from here on.
    const { CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID } = process.env;
    const missing = ["CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET", "CIRCLE_WALLET_ID"].filter(
        (k) => !process.env[k],
    );
    if (missing.length) {
        console.error(`\nMissing env to execute: ${missing.join(", ")}`);
        process.exit(1);
    }
    const c = initiateDeveloperControlledWalletsClient({
        apiKey: CIRCLE_API_KEY,
        entitySecret: CIRCLE_ENTITY_SECRET,
    });

    let calls = plan.calls ?? [];
    const results = [];

    // 2a) Permit2 venues (Synthra/UnitFlow): the /swap plan is not directly
    // executable. Run the 3-step flow: approve Permit2 -> sign the PermitSingle
    // typedData with Circle -> POST /swap/finalize to get the execute() call.
    if (plan.requiresPermit2Signature && plan.permit2) {
        const body = JSON.parse(bodyArg ?? "{}");
        const p2 = plan.permit2;
        // Step 1: one-time approve of the Permit2 contract (idempotent; a
        // standing max allowance means this is a no-op refresh).
        console.error("[permit2] approving Permit2 contract...");
        const ar = await executeOne(c, CIRCLE_WALLET_ID, p2.approve);
        results.push({ fn: "approve->Permit2", ...ar });
        console.error(`[executed] approve->Permit2 -> ${ar.txHash ?? ar.state}`);
        // Step 2: sign the PermitSingle typedData. Circle wants the whole
        // typed-data object (incl. EIP712Domain) as a JSON string.
        console.error("[permit2] signing PermitSingle typedData with Circle...");
        const signed = await c.signTypedData({
            walletId: CIRCLE_WALLET_ID,
            data: JSON.stringify(p2.typedData),
        });
        const signature = signed?.data?.signature;
        if (!signature) throw new Error("Circle signTypedData returned no signature");
        // Step 3: finalize -> execute() descriptor.
        console.error("[permit2] finalizing to get execute() call...");
        const finRes = await fetch(`${BASE}/swap/finalize`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                tokenIn: body.tokenIn,
                tokenOut: body.tokenOut,
                amountIn: body.amountIn,
                recipient: body.recipient,
                slippageBps: body.slippageBps,
                permit: p2.permit,
                signature,
            }),
        });
        const finPlan = await finRes.json();
        if (finPlan.ok === false) {
            console.error(`\nfinalize refused: ${finPlan.error ?? finPlan.reason ?? "unknown"}`);
            process.exit(1);
        }
        calls = finPlan.calls ?? [];
    }

    if (!calls.length) {
        console.error("\nNo calls[] to execute (nothing to sign).");
        console.log(JSON.stringify({ ok: true, endpoint, results }, null, 2));
        return;
    }

    // 2b) Execute the (possibly finalized) descriptors in order.
    for (const d of calls) {
        const r = await executeOne(c, CIRCLE_WALLET_ID, d);
        results.push({ fn: d.abiFunctionSignature, ...r });
        console.error(`[executed] ${d.abiFunctionSignature} -> ${r.txHash ?? r.state}`);
    }
    console.log(JSON.stringify({ ok: true, endpoint, results }, null, 2));
}

main().catch((e) => {
    console.error("run-agent failed:", e?.message ?? e);
    process.exit(1);
});
