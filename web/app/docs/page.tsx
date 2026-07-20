import Link from "next/link";

export const metadata = {
  title: "Docs",
  description:
    "How Arcade works: the swap aggregator, one-signature batching, the CCTP + Solana bridge, concentrated-liquidity pools, the auto-compounder, on-chain limit orders, and the fair-launch token engine — all USDC-native on Arc.",
};

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold sm:text-4xl">
        Arcade{" "}
        <span className="bg-gradient-to-r from-arc-cta-hover to-arc-primary-hover bg-clip-text text-transparent">
          Documentation
        </span>
      </h1>
      <p className="mt-2 text-sm text-arc-text-muted">
        A USDC-native DeFi suite on Arc, Circle&apos;s EVM L1: a multi-DEX swap
        aggregator with one-signature trades, a CCTP + Solana bridge,
        concentrated-liquidity pools with gasless auto-compounding, on-chain
        limit orders, and a fair-launch token engine.
      </p>

      <nav className="mt-8 grid gap-4 rounded-2xl border border-arc-border bg-arc-bg-elevated p-4 text-sm sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-arc-text-faint">Trade</div>
          <a href="#overview" className="block text-arc-primary hover:underline">1. Overview</a>
          <a href="#swap" className="block text-arc-primary hover:underline">2. Swap &amp; route aggregator</a>
          <a href="#one-sig" className="block text-arc-primary hover:underline">3. One-signature swaps</a>
          <a href="#multiswap" className="block text-arc-primary hover:underline">4. Multi-token swap</a>
          <a href="#limit" className="block text-arc-primary hover:underline">5. Limit orders</a>
          <a href="#bridge" className="block text-arc-primary hover:underline">6. Bridge (CCTP + Solana)</a>
        </div>
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-arc-text-faint">Earn &amp; build</div>
          <a href="#liquidity" className="block text-arc-primary hover:underline">7. Liquidity &amp; positions</a>
          <a href="#compounder" className="block text-arc-primary hover:underline">8. Auto-compounder</a>
          <a href="#launch" className="block text-arc-primary hover:underline">9. Launchpad &amp; fees</a>
          <a href="#twitter" className="block text-arc-primary hover:underline">10. Twitter attribution &amp; gasless claims</a>
          <a href="#identity" className="block text-arc-primary hover:underline">11. Creator identity</a>
          <a href="#arc" className="block text-arc-primary hover:underline">12. Arc primitives</a>
          <a href="#contracts" className="block text-arc-primary hover:underline">13. Contracts &amp; security</a>
          <a href="#faq" className="block text-arc-primary hover:underline">14. FAQ</a>
        </div>
      </nav>

      <Callout>
        Testnet only. Tokens have no monetary value. A few features are wired
        for mainnet but inert on testnet (flagged <b>Mainnet</b> below).
      </Callout>

      {/* ---------------------------------------------------------------- */}
      <Section id="overview" title="1. Overview">
        <p>
          Arcade runs on <b>Arc</b>, Circle&apos;s EVM L1, where the native gas
          token is <b>USDC</b> — no ETH round-trip before you can transact. Gas,
          swaps, liquidity, and launch fees all denominate in USDC. Wallets are
          standard Ethereum (secp256k1); chainId is <code>5042002</code>.
        </p>
        <p>What you can do:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li><b>Swap</b> across every DEX on Arc through one aggregated quote, often in a single signature.</li>
          <li><b>Bridge</b> USDC in/out via Circle CCTP (EVM chains) and Circle App Kit (Solana).</li>
          <li><b>Provide liquidity</b> in concentrated V3 pools and <b>auto-compound</b> fees gaslessly.</li>
          <li><b>Place limit orders</b> that live fully on-chain.</li>
          <li><b>Launch a token</b> via a USDC bonding curve or a locked single-sided pool, and earn fees forever.</li>
        </ul>
      </Section>

      {/* ============================ TRADE ============================= */}
      <Section id="swap" title="2. Swap & route aggregator">
        <p>
          The Swap card fans one quote request out to every DEX on Arc in
          parallel, sorts the results, and auto-picks the best route. You never
          choose a venue — Arcade compares them for you and shows the top
          routes with the price gap.
        </p>
        <Table
          headers={["Route", "What it is"]}
          rows={[
            ["Arcade V3", "Arcade's Uniswap V3 fork — CLANKER_V3 launch pools"],
            ["Arcade V2", "Arcade's Uniswap V2 fork — launchpad-migrated pairs"],
            ["Synthra V3", "3rd-party V3 fork (via UniversalRouter + Permit2)"],
            ["XyloNet", "StableSwap (Curve invariant) — optimised for stables"],
          ]}
        />
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>A provider that has no pool (or reverts) is dropped — one DEX&apos;s outage never blocks the others.</li>
          <li>The auto-pick is <b>impact-aware</b>: it probes depth at 1% of your size and prefers the highest-output route with price impact ≤ 30%, not blind max-output.</li>
          <li><b>Slippage</b> presets 0.1% / 0.5% / 1% (default 0.1%), custom up to 50%. A minimum-received amount is always enforced on-chain.</li>
          <li><b>Anti-sniper tax</b> on fresh launches is read into the quote, so the number you see is what the router actually executes (a banner shows the active tax %).</li>
          <li><b>Partial fill</b>: if your amount would exhaust a pool&apos;s active liquidity, Arcade quotes the largest swappable amount instead of failing, and tells you the difference.</li>
        </ul>
      </Section>

      <Section id="one-sig" title="3. One-signature swaps">
        <p>
          On Arc, Arcade folds the ERC-20 <code>approve</code> and the swap into
          a <b>single signature</b> using Arc&apos;s native batch primitive
          (<code>Multicall3From</code>), which preserves your wallet as the
          sender via the <code>callFrom</code> precompile. The first swap of a
          new token = one popup instead of two; later swaps of that token go
          direct.
        </p>
        <p className="text-arc-text-faint">
          Applies to Arcade&apos;s own routes (V2 / V3 / migrated). Permit2
          routes (Synthra) already settle in one transaction with an off-chain
          signature, so they don&apos;t need it.
        </p>
      </Section>

      <Section id="multiswap" title="4. Multi-token swap">
        <p>
          The <b>Multi Token Swap</b> tab consolidates up to <b>5 input tokens
          into one output token in a single transaction</b> — handy for sweeping
          dust or several positions into USDC. Every needed approval plus the
          swap settle in one signature via the same batch primitive.
        </p>
        <p className="text-arc-text-faint">
          Each leg is routed individually; a token with no liquidity pool on Arc
          can&apos;t be routed and the swap will revert — pick tokens that have a
          pool.
        </p>
      </Section>

      <Section id="limit" title="5. Limit orders">
        <p>
          The <b>Limit</b> tab places a fully <b>on-chain</b> order through the
          Orbs TWAP/dLIMIT contracts — no backend, no off-chain order book. Pick
          a pair, an amount, and a trigger price; the order sits on-chain until
          it fills or you cancel. <b>0% Arcade fees, no hidden spread, cancel
          anytime.</b> Expiry presets 1 day / 1 week (default) / 1 month, hard
          cap 90 days.
        </p>
        <Callout tone="warn">
          <b>Mainnet.</b> Orders are placed correctly on-chain, but{" "}
          <b>no keeper bot runs on testnet</b>, so nothing fills them yet — they
          stay <i>Open</i> until expiry. A self-keeper ships with mainnet.
        </Callout>
      </Section>

      <Section id="bridge" title="6. Bridge (CCTP + Solana)">
        <h3 className="mt-4 font-semibold text-arc-text">EVM ⇄ Arc — Circle CCTP V2</h3>
        <p>
          Native USDC is <b>burned</b> on the source chain and <b>minted</b> on
          the destination — no wrapped tokens. The flow is{" "}
          <b>Send → Attestation → Claim</b>: you sign the burn, Arcade polls
          Circle&apos;s attestation service, then you sign the mint on the
          destination. Supported source chains:
        </p>
        <Table
          headers={["Chain", "Typical time"]}
          rows={[
            ["Ethereum Sepolia", "~15-20 min (waits for finality)"],
            ["Base / Arbitrum / OP Sepolia", "~1-3 min"],
            ["Avalanche Fuji", "~30-60s"],
            ["Arc Testnet (default destination, also a source)", "~30-60s"],
          ]}
        />
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li><b>Standard</b> transfer is free (waits for full finality). <b>Fast Transfer</b> settles in ~10-30s with a tiny Circle fee; minimum 0.5 USDC.</li>
          <li>Fee: 0.05% Arcade all-in on Fast only (Standard is free). <span className="text-arc-text-faint">All-in means Circle&apos;s own fee counts toward the 0.05% — the receiver tops up only the difference, so you never pay more. Charged on-chain by the bridge receiver; avoidable only by bridging without using this UI.</span></li>
          <li>Bridge to a different recipient address, resume an interrupted bridge after refresh, and retry failed ones from history.</li>
        </ul>

        <h3 className="mt-5 font-semibold text-arc-text">Solana ⇄ Arc — Circle App Kit</h3>
        <p>
          Select <b>Solana Devnet</b> in the chain picker (it forces Arc on the
          other side) to bridge USDC to/from Solana via Circle&apos;s App Kit,
          using a <b>Phantom</b> wallet for the Solana side. The audited EVM/CCTP
          path is untouched.
        </p>
        <Callout tone="warn">
          <b>Beta.</b> Requires a Circle Kit Key + Phantom. Works end-to-end in
          testing but is newer than the EVM bridge.
        </Callout>
      </Section>

      {/* ========================= EARN & BUILD ======================== */}
      <Section id="liquidity" title="7. Liquidity & positions">
        <p>
          Provide concentrated (Uniswap V3) liquidity from <b>/positions</b>,
          which lists both wallet-owned and auto-managed positions in one grid
          with live in/out-of-range status and unclaimed fees.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li><b>Add</b> with two tokens, or use the <b>Single-Asset Zap</b> (deposit one token, Arcade swaps half and mints a max-range position). Range presets Max / Passive / Wide / Narrow / Aggressive.</li>
          <li><b>Remove</b> (decrease → collect → burn) in one flow.</li>
          <li><b>Claim all fees</b>: select several positions and collect them in a <b>single signature</b> (batched via Multicall3From).</li>
        </ul>
        <p className="mt-2 text-arc-text-faint">
          APR / 24h volume / TVL are live from the ArcLens indexer; fees are also
          computed exactly on-chain.
        </p>
      </Section>

      <Section id="compounder" title="8. Auto-compounder">
        <p>
          Deposit a V3 LP position into the <b>Auto-Compounder</b> and a keeper
          maintains it for you — <b>you never pay gas after the deposit</b>.
          Two active modes:
        </p>
        <Table
          headers={["Mode", "What the keeper does"]}
          rows={[
            ["Auto-compound", "Collects accrued fees and reinvests them into the same position"],
            ["Auto-receive", "Collects accrued fees and sends them straight to your wallet"],
          ]}
        />
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>A scheduled keeper runs <b>every 5 minutes</b> (off-chain operator pays the gas) and acts once a position clears its fee threshold + 5-min cooldown.</li>
          <li>The keeper bundles all due positions into <b>one transaction</b> (Multicall3 batching) — one base fee instead of N.</li>
          <li>Protocol fee on collected fees: <b>1%</b> (hard-capped on-chain at 5%). Your position card shows a live <b>Total earned</b> (lifetime claimed + currently pending).</li>
          <li>Change mode or withdraw your NFT anytime — both are user-signed and take effect on the next keeper tick.</li>
        </ul>
        <p className="mt-2 text-arc-text-faint">
          The same gasless-keeper model powers <b>Twitter escrow auto-claim</b>{" "}
          (see §10): the operator delivers your USDC + tokens without you paying
          claim gas, also batched.
        </p>
      </Section>

      <Section id="launch" title="9. Launchpad & fees">
        <p>
          Anyone can issue a token. Three launch flavors live under one
          launchpad contract:
        </p>
        <Table
          headers={["Mode", "Behavior"]}
          rows={[
            ["Pump", "USDC bonding curve. 0.5% creator / 0.5% platform trade fee. Auto-migrates to a V2 pool at $20k raised, LP burned."],
            ["Arcade", "USDC bonding curve. 0.3% creator / 0.7% platform trade fee. Same $20k migration, LP burned."],
            ["Clanker", "No curve — full supply locked single-sided in a V3 fork, tradeable from launch. 80% of LP fees to creator slots, 20% to platform, forever."],
          ]}
        />
        <h3 className="mt-5 font-semibold text-arc-text">Clanker pool types</h3>
        <p>Chosen at launch — sets starting market cap and how supply is split across V3 ranges.</p>
        <Table
          headers={["Name", "Paired", "Starting mcap", "Positions"]}
          rows={[
            ["Standard", "USDC", "$35k", "3 (40/35/25 split)"],
            ["Legacy", "USDC", "Custom $1–$1M", "1 (single range)"],
            ["Deep", "USDC", "$50k", "3"],
            ["WETH", "WETH", "10 ETH", "3"],
          ]}
        />
        <h3 className="mt-5 font-semibold text-arc-text">Trading, migration &amp; anti-sniper</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li><b>Curve → AMM:</b> Pump/Arcade trades route through the launchpad while on the curve. At 20,000 USDC raised the contract takes a 2,500 USDC migration fee, seeds a fresh V2 pair with the rest (17,500 USDC + 200M tokens), and burns the LP to the dead address.</li>
          <li><b>Clanker:</b> trades go through the V3 router against the locked position; fees accrue forever and are claimable by anyone calling <code>collectFees</code>, distributed per the creator&apos;s recipient bps.</li>
          <li><b>Anti-sniper tax:</b> a Clanker creator can set a starting tax (max 50%) that decays linearly to 0. It&apos;s skimmed at the router on buys during the window and sent to the treasury. The creator&apos;s own opening buy is not taxed.</li>
          <li><b>Team vault:</b> carve up to 90% of supply into a vault with a lockup + linear vesting; vaulted supply is excluded from the LP.</li>
        </ul>
        <h3 className="mt-5 font-semibold text-arc-text">Creator earnings</h3>
        <p>
          Clanker creators see and claim their LP-fee share from{" "}
          <b>/my-tokens</b> (all-time claimed + pending) and per token. Claiming
          calls <code>collectFees</code> on the locker — user-signed. Fee split
          is 80% creator / 20% platform on Clanker V3 (and on the migrated V2
          slot); Pump curve fees are 0.5%/0.5% with LP burned at migration.
        </p>
      </Section>

      <Section id="twitter" title="10. Twitter attribution & gasless claims">
        <p>
          A Clanker fee slot can be attributed to a Twitter <b>@handle</b>
          instead of an address — perfect for launching on behalf of a creator
          who isn&apos;t on Arcade yet. Fees for that slot accumulate in an
          escrow contract until the handle owner claims them.
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>At launch, toggle Twitter on a recipient row and type the @handle; the slot pays into <code>ArcadeTwitterEscrow</code>.</li>
          <li>The handle owner lands on the token page, connects any wallet (no gas needed), and clicks Claim → Twitter OAuth verifies they own the handle.</li>
          <li>The backend signs an EIP-712 authorization (30-min deadline). After a 1-hour veto timelock, the claim sweeps the full balance and redirects future fees to their wallet.</li>
          <li><b>Gasless delivery:</b> once authorized, a keeper fires the claim for them — they never pay claim gas. The escrow can only ever pay the registered recipient.</li>
        </ol>
      </Section>

      <Section id="identity" title="11. Creator identity">
        <p>
          Creators can mint a portable <b>ERC-8004</b> reputation NFT on Arc&apos;s
          native identity registry, gated by how many of their launches have{" "}
          <b>graduated</b> (crossed the bonding curve into a real pool):
        </p>
        <Table
          headers={["Tier", "Graduated launches"]}
          rows={[
            ["Silver", "3+"],
            ["Gold", "5+"],
            ["Diamond", "10+"],
          ]}
        />
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>Only curve-graduated (Pump/Arcade) and V4-hook graduations count — CLANKER_V3 launches are excluded (they skip the curve and pay only the 3 USDC creation fee, so they can&apos;t farm a free tier).</li>
          <li>Metadata is written on-chain at mint. When you climb a tier, a <b>burn + re-mint</b> refresh updates the badge.</li>
          <li>Other Arc dapps can read the NFT to gate leaderboards / VIP features.</li>
        </ul>
      </Section>

      {/* ========================== PLATFORM =========================== */}
      <Section id="arc" title="12. Arc primitives">
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li><b>USDC is gas.</b> It&apos;s the native token (6-dec for transfers/display) so every action — gas, swaps, launch fees — is in USDC. <code>0x3600…0000</code>.</li>
          <li><b>One-signature batching.</b> Arc&apos;s <code>Multicall3From</code> bundles calls into one tx while keeping your wallet as the sender — what powers single-signature swaps, claim-all-fees, and managed position removal.</li>
          <li><b>Keeper batching.</b> The gasless keepers bundle many positions/claims into one Multicall3 transaction, so cost barely grows with scale.</li>
          <li>Standard Multicall3, Permit2, and a canonical RPC stack (dedicated provider → public Arc RPC → thirdweb fallback) are all wired.</li>
        </ul>
      </Section>

      <Section id="contracts" title="13. Contracts & security">
        <p>Live Arc-testnet addresses are in <Link href="/deployments.json" className="text-arc-primary hover:underline">/deployments.json</Link>. Core contracts:</p>
        <Table
          headers={["Contract", "Role"]}
          rows={[
            ["ArcadeLaunchpad", "Curve trades, migration, Clanker bootstrap"],
            ["ArcadeV3Locker", "Custodies Clanker LP forever, distributes fees per recipient bps"],
            ["ArcadeTwitterEscrow", "Holds Twitter-attributed fees until OAuth claim"],
            ["ArcadeV3Router / Quoter", "V3 swaps with anti-sniper skim"],
            ["ArcadeV2Factory / Router", "V2 AMM for migrated tokens"],
            ["ArcadeAutoCompounder", "Custodies LP NFTs, auto-compounds / auto-receives fees"],
            ["ArcadeTokenVault", "Team-vault vesting"],
            ["ArcadeIdentityIssuer", "On-chain tier-gated ERC-8004 identity mint"],
          ]}
        />
        <h3 className="mt-5 font-semibold text-arc-text">Trust model</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Locker principal is unwithdrawable — only fee collection is possible. Recipient bps are immutable post-launch.</li>
          <li>Curve migration burns LP to the dead address; the migration fee + an anti-donation skim block initial-price warping.</li>
          <li>Keepers are <b>convenience, not custody</b>: they can only call permissionless functions (compound, claim-after-authorize). Your funds always go to you.</li>
          <li>The Twitter escrow uses a single backend signer today; mainnet migrates it to a multisig + a 1-hour veto timelock (already enforced on-chain).</li>
        </ul>
        <h3 className="mt-5 font-semibold text-arc-text">Security</h3>
        <p>
          The V2/V3 stack went through multiple internal multi-agent audit
          passes; HIGH/MEDIUM findings were fixed pre-mainnet, with the
          remainder scoped to the multisig migration and V4 rollout. An external
          audit and the multisig migration are scheduled before mainnet. Past
          on-chain history (Arc explorer) and the immutable contracts are the
          source of truth.
        </p>
      </Section>

      <Section id="faq" title="14. FAQ">
        <h3 className="mt-4 font-semibold text-arc-text">Why is USDC the gas token?</h3>
        <p>Arc is Circle&apos;s EVM L1, built so the only asset you need is USDC. Gas, swaps, and launch fees all denominate in USDC — no ETH bridging first.</p>

        <h3 className="mt-4 font-semibold text-arc-text">Why was my swap one signature instead of two?</h3>
        <p>Arc&apos;s batch primitive lets Arcade fold the token approval and the swap into a single transaction. The first swap of a token batches; later ones go direct.</p>

        <h3 className="mt-4 font-semibold text-arc-text">My limit order isn&apos;t filling.</h3>
        <p>On testnet no keeper bot runs, so on-chain orders sit Open until expiry. Filling ships with mainnet.</p>

        <h3 className="mt-4 font-semibold text-arc-text">Do I pay gas for auto-compounding or a Twitter claim?</h3>
        <p>No — those are keeper-driven. An off-chain operator pays the gas; you only sign the initial deposit (compounder) or authorization (Twitter claim).</p>

        <h3 className="mt-4 font-semibold text-arc-text">What&apos;s a Clanker?</h3>
        <p>A launch mode where the full supply is locked in a single-sided V3 position at creation — no curve, tradeable immediately, with 80% of perpetual LP fees routing to the creator&apos;s slots forever. The principal can never be withdrawn.</p>

        <h3 className="mt-4 font-semibold text-arc-text">Why does migration trigger at $20k?</h3>
        <p>The curve uses virtual reserves (5,000 USDC + 1B token) so the math fills exactly at 20,000 USDC raised. 2,500 USDC goes to treasury, the rest seeds a V2 pool, and the LP is burned.</p>

        <h3 className="mt-4 font-semibold text-arc-text">Can I cancel a launch?</h3>
        <p>No. Once created, the ERC-20 exists forever on-chain. You can stop interacting with it, but it can&apos;t be deleted.</p>
      </Section>

      <div className="mt-12 rounded-2xl border border-arc-border bg-arc-bg-elevated p-4 text-xs text-arc-text-muted">
        Testnet only. Tokens have no monetary value. Nothing here is financial advice.
      </div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-10 scroll-mt-20 space-y-2 text-sm text-arc-text-muted">
      <h2 className="font-display text-xl font-semibold text-arc-text">{title}</h2>
      {children}
    </section>
  );
}

function Callout({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warn" }) {
  const cls =
    tone === "warn"
      ? "border-arc-warn/30 bg-arc-warn/10 text-arc-warn"
      : "border-arc-border bg-arc-bg-elevated text-arc-text-muted";
  return (
    <div className={`mt-4 rounded-xl border p-3 text-xs ${cls}`}>{children}</div>
  );
}

function Table({ rows, headers }: { rows: string[][]; headers: string[] }) {
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-arc-border">
      <table className="w-full text-sm">
        <thead className="bg-arc-bg-elevated text-xs uppercase tracking-wide text-arc-text-muted">
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`row-${i}-${row[0] ?? ""}`} className="border-t border-arc-border">
              {row.map((cell, j) => (
                <td key={`cell-${i}-${j}`} className="px-3 py-2 align-top text-arc-text">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
