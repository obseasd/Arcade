#!/usr/bin/env node
/**
 * Show an agent wallet's holdings on Arc testnet in the terminal: the native
 * USDC balance plus balanceOf for the reference tokens and any extra token
 * addresses you pass (e.g. a launchpad token you just bought, which the
 * /portfolio endpoint does NOT list).
 *
 * Usage (from agent-mcp/):
 *   node holdings.mjs <walletAddress> [extraTokenAddr ...]
 *
 * Example (wallet + the JDFJ launchpad token):
 *   node holdings.mjs 0x67fd714c87b95ac6d2ae5a3d59308f0e9873e610 0xBd821f9160882305448EcBBF77ADc23Df7D5993B
 */

import { createPublicClient, http, formatUnits, erc20Abi } from "viem";

const RPC = process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.testnet.arc.network";

// Reference tokens (symbol, address, decimals). USYC added so you can also see
// yield holdings on an entitled wallet.
const REF = [
    ["USDC", "0x3600000000000000000000000000000000000000", 6],
    ["WUSDC", "0x911b4000D3422F482F4062a913885f7b035382Df", 18],
    ["USDT", "0x175CdB1D338945f0D851A741ccF787D343E57952", 18],
    ["EURC", "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", 6],
    ["cirBTC", "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF", 8],
    ["WETH", "0x9570EBA9eE39Aa4933f64d6add280faAB289a847", 18],
    ["USYC", "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C", 6],
];

const c = createPublicClient({ transport: http(RPC, { timeout: 12000 }) });

async function readToken(addr, wallet) {
    try {
        const [bal, dec, sym] = await Promise.all([
            c.readContract({ address: addr, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
            c.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
            c.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
        ]);
        return { sym, bal, dec: Number(dec) };
    } catch {
        return null;
    }
}

async function main() {
    const wallet = process.argv[2];
    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
        console.error("Usage: node holdings.mjs <walletAddress> [extraTokenAddr ...]");
        process.exit(1);
    }
    const extras = process.argv.slice(3);

    console.log(`\nHoldings for ${wallet} (Arc testnet)\n`);
    const native = await c.getBalance({ address: wallet });
    console.log(`  USDC (native gas) : ${formatUnits(native, 18)}`);

    for (const [sym, addr, dec] of REF) {
        const b = await c.readContract({ address: addr, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
        if (b > 0n) console.log(`  ${sym.padEnd(17)} : ${formatUnits(b, dec)}`);
    }
    for (const addr of extras) {
        const r = await readToken(addr, wallet);
        if (r) console.log(`  ${(r.sym + " (" + addr.slice(0, 8) + "..)").padEnd(17)} : ${formatUnits(r.bal, r.dec)}`);
    }
    console.log(`\n  Explorer: https://testnet.arcscan.app/address/${wallet}\n`);
}

main().catch((e) => {
    console.error("holdings failed:", e?.message ?? e);
    process.exit(1);
});
