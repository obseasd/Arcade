// Finds the deploy block of a contract via binary search on eth_getCode, so
// START_BLOCK can be set to the launchpad's first block for full history.
//
//   node scripts/find-start-block.mjs [address] [rpcUrl]
//   node scripts/find-start-block.mjs 0xB6c9bD47... https://rpc.testnet.arc.network

const address = (process.argv[2] ?? process.env.LAUNCHPAD_ADDRESS ?? "").toLowerCase();
const rpc = process.argv[3] ?? process.env.PONDER_RPC_URL_5042002 ?? "https://rpc.testnet.arc.network";

if (!/^0x[0-9a-f]{40}$/.test(address)) {
    console.error("usage: node find-start-block.mjs <address> [rpcUrl]");
    process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcCall(method, params, attempt = 0) {
    const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await res.json();
    if (j.error) {
        // Public Arc RPC rate-limits (-32011). Back off and retry a few times;
        // a dedicated provider avoids this entirely.
        const msg = JSON.stringify(j.error);
        if ((msg.includes("32011") || msg.includes("limit")) && attempt < 6) {
            await sleep(1000 * (attempt + 1));
            return rpcCall(method, params, attempt + 1);
        }
        throw new Error(`${method}: ${msg}`);
    }
    return j.result;
}

async function hasCode(block) {
    const code = await rpcCall("eth_getCode", [address, "0x" + block.toString(16)]);
    return code && code !== "0x";
}

const latestHex = await rpcCall("eth_blockNumber", []);
let hi = parseInt(latestHex, 16);
let lo = 0;

if (!(await hasCode(hi))) {
    console.error("no code at the latest block -- wrong address or chain?");
    process.exit(1);
}

// Invariant: code exists at hi, does not at lo. Converge on the first block
// where code appears.
while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await hasCode(mid)) hi = mid;
    else lo = mid;
}

console.log(`deploy block for ${address}: ${hi}`);
console.log(`set START_BLOCK=${hi}`);
