// Generate curve-vectors.json from the production ArcadeLaunchpad math.
//
// The V4 ArcadeHook implementation MUST produce identical outputs for every
// case in the generated JSON. The fixtures lock down the protocol's economic
// invariants across the V2 -> V4 migration: same K constant, same virtual
// reserves, same rounding direction, same graduation threshold.
//
// Usage:
//   node contracts/test/fixtures/generate.mjs
//
// Output:
//   contracts/test/fixtures/curve-vectors.json
//
// Cross-check (post-V4 dev):
//   forge test --match-test test_CurveFixtures -vvv
//   should read curve-vectors.json and assert bit-identical outputs from
//   the V4 ArcadeHook curve path.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Constants ported verbatim from contracts/src/launchpad/ArcadeLaunchpad.sol
const VIRTUAL_USDC_RESERVE = 5_000n * 10n ** 6n; // 5_000_000_000
const VIRTUAL_TOKEN_RESERVE = 1_000_000_000n * 10n ** 18n; // 1e27
const CURVE_SUPPLY = 800_000_000n * 10n ** 18n; // 8e26
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n; // 1e27
const MIGRATION_LP_TOKENS = TOTAL_SUPPLY - CURVE_SUPPLY; // 2e26
const K_CONSTANT = VIRTUAL_USDC_RESERVE * VIRTUAL_TOKEN_RESERVE; // 5e36
const TRADE_FEE_BPS = 100n; // 1%
const FEE_DENOMINATOR = 10_000n;
const MIGRATION_FEE = 2_500n * 10n ** 6n; // 2_500_000_000

// _computeBuy port. Returns { tokensOut, actualGross, refund, tokensSoldAfter, realUsdcReserveAfter }.
// Math must stay bit-identical to ArcadeLaunchpad._computeBuy (line 576 of the
// source). The only difference: we accept (tokensSold, realUsdcReserve, grossIn)
// as flat inputs, the production contract reads them from the TokenState struct.
function computeBuy({ tokensSold, realUsdcReserve, grossIn }) {
    const fee = (grossIn * TRADE_FEE_BPS) / FEE_DENOMINATOR; // floor
    const netIn = grossIn - fee;

    const currentUsdc = VIRTUAL_USDC_RESERVE + realUsdcReserve;
    const currentTokens = VIRTUAL_TOKEN_RESERVE - tokensSold;

    const newUsdcReserve = currentUsdc + netIn;
    const newTokenReserve = K_CONSTANT / newUsdcReserve; // floor
    const desiredOut = currentTokens - newTokenReserve;

    const maxOut = CURVE_SUPPLY - tokensSold;

    let tokensOut, actualGross, refund;
    if (desiredOut <= maxOut) {
        tokensOut = desiredOut;
        actualGross = netIn + fee;
        refund = 0n;
    } else {
        // Cap path: user buys exactly maxOut tokens at the curve cap.
        tokensOut = maxOut;
        const capTokenReserve = currentTokens - maxOut;
        let capUsdcReserve = K_CONSTANT / capTokenReserve; // floor
        if (K_CONSTANT % capTokenReserve !== 0n) capUsdcReserve += 1n; // ceil
        const actualNet = capUsdcReserve - currentUsdc;
        // ceil(actualNet * FEE_DENOMINATOR / (FEE_DENOMINATOR - TRADE_FEE_BPS))
        actualGross =
            (actualNet * FEE_DENOMINATOR + (FEE_DENOMINATOR - TRADE_FEE_BPS) - 1n) /
            (FEE_DENOMINATOR - TRADE_FEE_BPS);
        const gross = netIn + fee;
        if (actualGross > gross) actualGross = gross;
        refund = gross - actualGross;
    }

    const actualNetIn = actualGross - (actualGross * TRADE_FEE_BPS) / FEE_DENOMINATOR;
    const tokensSoldAfter = tokensSold + tokensOut;
    const realUsdcReserveAfter = realUsdcReserve + actualNetIn;

    return {
        tokensOut,
        actualGross,
        refund,
        tokensSoldAfter,
        realUsdcReserveAfter,
    };
}

// _sell port. Returns { usdcOut, fee, tokensSoldAfter, realUsdcReserveAfter }.
function computeSell({ tokensSold, realUsdcReserve, tokensIn }) {
    const currentUsdc = VIRTUAL_USDC_RESERVE + realUsdcReserve;
    const currentTokens = VIRTUAL_TOKEN_RESERVE - tokensSold;
    const newTokenReserve = currentTokens + tokensIn;
    const newUsdcReserve = K_CONSTANT / newTokenReserve; // floor
    let grossOut = currentUsdc - newUsdcReserve;
    if (grossOut > realUsdcReserve) grossOut = realUsdcReserve;

    const fee = (grossOut * TRADE_FEE_BPS) / FEE_DENOMINATOR;
    const usdcOut = grossOut - fee;
    const tokensSoldAfter = tokensSold - tokensIn;
    const realUsdcReserveAfter = realUsdcReserve - grossOut;

    return { usdcOut, fee, grossOut, tokensSoldAfter, realUsdcReserveAfter };
}

// Test cases sweep the curve state space the V4 hook must replicate:
// empty curve, mid-curve, near graduation, post-graduation cap-hit, dust
// amounts (rounding sensitivity), and round-trip invariants.
const BUY_CASES = [
    { name: "tiny-buy-empty-curve", tokensSold: 0n, realUsdcReserve: 0n, grossIn: 1_000_000n }, // 1 USDC
    { name: "small-buy-empty-curve", tokensSold: 0n, realUsdcReserve: 0n, grossIn: 100_000_000n }, // 100 USDC
    { name: "large-buy-empty-curve", tokensSold: 0n, realUsdcReserve: 0n, grossIn: 5_000_000_000n }, // 5000 USDC
    { name: "mid-curve-buy", tokensSold: 200_000_000n * 10n ** 18n, realUsdcReserve: 1_250_000_000n, grossIn: 100_000_000n }, // 100 USDC after 200M sold
    { name: "near-graduation-buy", tokensSold: 700_000_000n * 10n ** 18n, realUsdcReserve: 16_666_666_666n, grossIn: 100_000_000n }, // 100 USDC near grad
    { name: "exact-graduation-buy", tokensSold: 750_000_000n * 10n ** 18n, realUsdcReserve: 18_750_000_000n, grossIn: 5_000_000_000n }, // 5000 USDC pushing past grad
    { name: "cap-hit-massive-buy", tokensSold: 0n, realUsdcReserve: 0n, grossIn: 30_000_000_000n }, // 30000 USDC, caps at graduation
    { name: "dust-rounding-sensitivity", tokensSold: 0n, realUsdcReserve: 0n, grossIn: 1n }, // 1 microUSDC
];

const SELL_CASES = [
    { name: "tiny-sell", tokensSold: 1_000_000n * 10n ** 18n, realUsdcReserve: 5_000_000n, tokensIn: 1n * 10n ** 18n }, // 1 token after 1M sold
    { name: "normal-sell-early-curve", tokensSold: 100_000_000n * 10n ** 18n, realUsdcReserve: 555_555_555n, tokensIn: 10_000_000n * 10n ** 18n }, // 10M tokens after 100M sold
    { name: "sell-near-graduation", tokensSold: 700_000_000n * 10n ** 18n, realUsdcReserve: 16_666_666_666n, tokensIn: 50_000_000n * 10n ** 18n }, // 50M tokens near grad
    { name: "dust-sell", tokensSold: 1n * 10n ** 18n, realUsdcReserve: 5n, tokensIn: 1n }, // 1 wei token, dust path
];

// Round-trip invariant samples: buy then sell same amount, confirm USDC strictly
// decreases for the user (curve always wins on round-trips). V4 hook curve math
// must preserve this anti-MEV property.
const ROUND_TRIPS = [
    { name: "small-round-trip", buyIn: 100_000_000n }, // 100 USDC round trip
    { name: "medium-round-trip", buyIn: 1_000_000_000n }, // 1000 USDC round trip
];

const buyVectors = BUY_CASES.map((c) => {
    const out = computeBuy(c);
    return {
        name: c.name,
        input: {
            tokensSold: c.tokensSold.toString(),
            realUsdcReserve: c.realUsdcReserve.toString(),
            grossUsdcIn: c.grossIn.toString(),
        },
        output: {
            tokensOut: out.tokensOut.toString(),
            actualGross: out.actualGross.toString(),
            refund: out.refund.toString(),
            tokensSoldAfter: out.tokensSoldAfter.toString(),
            realUsdcReserveAfter: out.realUsdcReserveAfter.toString(),
        },
    };
});

const sellVectors = SELL_CASES.map((c) => {
    const out = computeSell(c);
    return {
        name: c.name,
        input: {
            tokensSold: c.tokensSold.toString(),
            realUsdcReserve: c.realUsdcReserve.toString(),
            tokensIn: c.tokensIn.toString(),
        },
        output: {
            usdcOut: out.usdcOut.toString(),
            grossOut: out.grossOut.toString(),
            fee: out.fee.toString(),
            tokensSoldAfter: out.tokensSoldAfter.toString(),
            realUsdcReserveAfter: out.realUsdcReserveAfter.toString(),
        },
    };
});

const roundTripVectors = ROUND_TRIPS.map((c) => {
    const buy = computeBuy({ tokensSold: 0n, realUsdcReserve: 0n, grossIn: c.buyIn });
    const sell = computeSell({
        tokensSold: buy.tokensSoldAfter,
        realUsdcReserve: buy.realUsdcReserveAfter,
        tokensIn: buy.tokensOut,
    });
    return {
        name: c.name,
        buy: {
            grossIn: c.buyIn.toString(),
            tokensOut: buy.tokensOut.toString(),
            actualGross: buy.actualGross.toString(),
        },
        sell: {
            tokensIn: buy.tokensOut.toString(),
            usdcOut: sell.usdcOut.toString(),
            grossOut: sell.grossOut.toString(),
        },
        invariant: {
            description: "user pays buyIn, receives usdcOut. usdcOut MUST be strictly less than buyIn (curve always wins).",
            userPaid: c.buyIn.toString(),
            userReceived: sell.usdcOut.toString(),
            curveProfit: (c.buyIn - sell.usdcOut).toString(),
            holdsInvariant: c.buyIn > sell.usdcOut,
        },
    };
});

const fixtures = {
    version: 1,
    generatedBy: "contracts/test/fixtures/generate.mjs",
    source: "contracts/src/launchpad/ArcadeLaunchpad.sol _computeBuy / sell",
    constants: {
        VIRTUAL_USDC_RESERVE: VIRTUAL_USDC_RESERVE.toString(),
        VIRTUAL_TOKEN_RESERVE: VIRTUAL_TOKEN_RESERVE.toString(),
        CURVE_SUPPLY: CURVE_SUPPLY.toString(),
        TOTAL_SUPPLY: TOTAL_SUPPLY.toString(),
        MIGRATION_LP_TOKENS: MIGRATION_LP_TOKENS.toString(),
        K_CONSTANT: K_CONSTANT.toString(),
        TRADE_FEE_BPS: Number(TRADE_FEE_BPS),
        FEE_DENOMINATOR: Number(FEE_DENOMINATOR),
        MIGRATION_FEE: MIGRATION_FEE.toString(),
    },
    buyVectors,
    sellVectors,
    roundTripVectors,
    invariants: [
        "VIRTUAL_USDC_RESERVE * VIRTUAL_TOKEN_RESERVE == K_CONSTANT (5e36)",
        "tokensSold + tokensInLP <= TOTAL_SUPPLY at all times",
        "tokensSold <= CURVE_SUPPLY at all times (graduation hard cap)",
        "Round-trip invariant: user_received_USDC < user_paid_USDC always",
        "Buy rounding: tokensOut = floor((K * netIn) / (currentUsdc * (currentUsdc + netIn)))",
        "Sell rounding: usdcOut = floor((currentUsdc * tokensIn) / (currentTokens + tokensIn)) minus 1% fee",
        "Graduation trigger: realUsdcReserve reaches 20_000 USDC exactly (modulo cap-path rounding)",
        "MIGRATION_FEE (2500 USDC) taken off the top at graduation, remainder (17500 USDC) + MIGRATION_LP_TOKENS (200M) seeds the AMM pool",
    ],
};

mkdirSync(HERE, { recursive: true });
const outPath = `${HERE}/curve-vectors.json`;
writeFileSync(outPath, JSON.stringify(fixtures, null, 2) + "\n");
console.log(`Wrote ${buyVectors.length} buy vectors, ${sellVectors.length} sell vectors, ${roundTripVectors.length} round-trip checks to ${outPath}`);
