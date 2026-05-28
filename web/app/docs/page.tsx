import Link from "next/link";

export const metadata = {
  title: "Docs",
  description: "How Arcade works: launch modes, fee splits, Twitter attribution, claiming, and on-chain primitives.",
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
        How the launchpad, the DEX, the Twitter attribution flow, and the locked-LP vault work.
      </p>

      <nav className="mt-8 grid gap-2 rounded-2xl border border-arc-border bg-arc-bg-elevated p-4 text-sm">
        <a href="#overview" className="text-arc-primary hover:underline">1. Overview</a>
        <a href="#launch-modes" className="text-arc-primary hover:underline">2. Launch modes</a>
        <a href="#clanker-pools" className="text-arc-primary hover:underline">3. Clanker pool types</a>
        <a href="#fees" className="text-arc-primary hover:underline">4. Fee splits</a>
        <a href="#twitter-attribution" className="text-arc-primary hover:underline">5. Twitter attribution + claim flow</a>
        <a href="#anti-sniper" className="text-arc-primary hover:underline">6. Anti-sniper tax</a>
        <a href="#vault" className="text-arc-primary hover:underline">7. Team vault</a>
        <a href="#trading" className="text-arc-primary hover:underline">8. Trading + migration</a>
        <a href="#contracts" className="text-arc-primary hover:underline">9. Contracts</a>
        <a href="#trust" className="text-arc-primary hover:underline">10. Trust model</a>
      </nav>

      <Section id="overview" title="1. Overview">
        <p>
          Arcade is a USDC-quoted token launchpad and DEX deployed on Arc, Circle&apos;s EVM L1.
          Three launch flavors live under the same launchpad contract: <b>Pump</b> and{" "}
          <b>Arcade</b> bonding curves that auto-migrate to V2 on fill, and <b>Clanker</b>{" "}
          locked single-sided V3 LP that&apos;s tradeable from launch.
        </p>
        <p>
          Native gas token is USDC (6 decimals). Wallets are standard Ethereum (secp256k1).
          Arc chainId is 5042002.
        </p>
      </Section>

      <Section id="launch-modes" title="2. Launch modes">
        <Table
          rows={[
            ["Pump", "Bonding curve, 50% creator / 50% platform on trade fees, migrates to V2 with LP burned at $20k raised"],
            ["Arcade", "Bonding curve, 30% creator / 70% platform on trade fees, migrates to V2 with LP burned at $20k raised"],
            ["Clanker", "No curve. Full token supply locked single-sided in a Uniswap V3 fork, tradeable from launch. 80% of LP fees to creator recipients, 20% to platform."],
          ]}
          headers={["Mode", "Behavior"]}
        />
      </Section>

      <Section id="clanker-pools" title="3. Clanker pool types">
        <p>Pick one at launch. Determines starting market cap and how the supply is split across V3 ranges.</p>
        <Table
          rows={[
            ["Standard", "USDC", "$35k start", "3 positions (40/35/25 split)"],
            ["Legacy", "USDC", "Custom $1 to $1M", "1 position (single range)"],
            ["Deep", "USDC", "$50k start", "3 positions"],
            ["WETH", "WETH", "10 ETH start", "3 positions"],
          ]}
          headers={["Name", "Paired", "Starting mcap", "Positions"]}
        />
      </Section>

      <Section id="fees" title="4. Fee splits">
        <h3 className="mt-4 font-semibold text-arc-text">Pump and Arcade (curve)</h3>
        <p>
          On every buy/sell, a 1% trade fee is taken (0.5% platform + 0.5% creator for Pump;
          0.7% platform + 0.3% creator for Arcade). Curve fees go to addresses set at launch.
        </p>

        <h3 className="mt-4 font-semibold text-arc-text">Clanker (locked V3 LP)</h3>
        <p>
          Pool fee is 1%, 2%, or 3% chosen at launch. On every swap, the V3 pool accrues fees on
          both sides (paired and clanker tokens). When anyone calls <code>collectFees</code> on
          the locker, the accrued fees are distributed:
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li><b>80%</b> split across creator-defined recipients (1 to 3 slots), weighted by bps</li>
          <li><b>20%</b> goes to the Arcade Treasury (immutable)</li>
        </ul>
        <p>
          Each creator slot can prefer the paired pot only, the clanker pot only, or both. Slots
          can be a regular address, OR a Twitter @handle escrow.
        </p>
      </Section>

      <Section id="twitter-attribution" title="5. Twitter attribution and claim flow">
        <p>
          You can attribute a Clanker recipient slot to a Twitter @handle. Anyone who proves
          they own that handle via OAuth can later claim the accumulated fees and redirect
          future fees to their wallet. This is great for tokens deployed for a community member
          or influencer who isn&apos;t on Arcade yet.
        </p>

        <h3 className="mt-4 font-semibold text-arc-text">At launch (creator)</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>On a Clanker launch, toggle <b>Twitter</b> on a recipient row</li>
          <li>Type the @handle the slot should pay out to</li>
          <li>That slot&apos;s on-chain recipient is set to <code>ArcadeTwitterEscrow</code></li>
          <li>The slot&apos;s admin is also the escrow (so the escrow can rotate the recipient at claim time)</li>
          <li>The @handle is stored in the token&apos;s on-chain metadata for later verification</li>
        </ol>

        <h3 className="mt-4 font-semibold text-arc-text">Trading</h3>
        <p>
          Trades happen normally. Anyone (literally anyone) can call <code>collectFees</code> on
          the locker. The Twitter-attributed slot&apos;s share goes into the escrow contract and
          sits there. Triggering claims is permissionless; the funds can&apos;t go anywhere but
          to the registered escrow.
        </p>

        <h3 className="mt-4 font-semibold text-arc-text">When the @handle owner shows up</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>They land on the token page. The slot shows <b>Fee recipient: @handle</b> with a Claim link</li>
          <li>Connect a wallet (any wallet, doesn&apos;t need ETH/USDC). Click Claim</li>
          <li>They&apos;re redirected to Twitter OAuth. Login as @handle, authorize Arcade</li>
          <li>Our backend exchanges the code, reads their Twitter username, verifies it matches the slot&apos;s attribution</li>
          <li>If match, backend signs an EIP-712 message with the trusted signer key</li>
          <li>They come back to <code>/claim</code> with the signed amounts and a Claim Fees button</li>
          <li>One tx: the escrow verifies the signature, transfers accumulated fees, then calls <code>updateRecipient + updateAdmin</code> on the locker so future fees flow direct</li>
        </ol>

        <h3 className="mt-4 font-semibold text-arc-text">Why a deadline on the signature</h3>
        <p>
          The EIP-712 message has a 30-min deadline so a leaked / shared URL can&apos;t be replayed
          forever. After expiry, the user re-runs the OAuth flow to get a fresh signature.
        </p>
      </Section>

      <Section id="anti-sniper" title="6. Anti-sniper tax">
        <p>
          On Clanker launches, the creator can configure a starting tax (max 50%) that linearly
          decays to 0 over <code>snipeDecaySeconds</code>. Implemented at the V3 router level: any
          USDC→token swap during the window has its input skimmed before swapping. The skim goes
          to the platform treasury.
        </p>
        <p>
          Creator buys at launch are NOT taxed (the snipe config is armed AFTER the creator buy
          inside the launch tx).
        </p>
      </Section>

      <Section id="vault" title="7. Team vault">
        <p>
          At Clanker launch, the creator can carve out up to 90% of the supply into a vault with
          a lockup and linear vesting schedule. The vault holds tokens; after <code>lockupDuration</code>{" "}
          they start vesting linearly over <code>vestingDuration</code>. The vaulted supply is excluded
          from the LP, so liquidity sits on what remains.
        </p>
      </Section>

      <Section id="trading" title="8. Trading and migration">
        <p>
          <b>Pump / Arcade:</b> trades route through <code>launchpad.buy/sell</code> while on
          the curve. When <code>realUsdcReserve</code> hits <code>MIGRATION_USDC_TARGET</code>{" "}
          (20,000 USDC), the contract auto-deploys a V2 pair, seeds it, and burns the LP
          tokens. Post-migration, trades route through V2 with a small royalty back to creator
          and platform.
        </p>
        <p>
          <b>Clanker:</b> trades go through the V3 router and quoter directly against the locked
          single-sided pool. No migration. Fees accrue continuously and are claimable via{" "}
          <code>locker.collectFees(positionId)</code>.
        </p>
      </Section>

      <Section id="contracts" title="9. Contracts">
        <p>
          Latest mainnet (Arc Testnet) addresses live in{" "}
          <Link href="/deployments.json" className="text-arc-primary hover:underline">
            /deployments.json
          </Link>{" "}
          on the site root.
        </p>
        <Table
          rows={[
            ["ArcadeLaunchpad", "Token state, curve trades, migration, Clanker bootstrap"],
            ["ArcadeV3Locker", "Custodies Clanker LP positions forever, distributes fees per recipient bps"],
            ["ArcadeTwitterEscrow", "Holds Twitter-attributed fees until OAuth claim"],
            ["ArcadeV3Router / Quoter", "V3 swaps for Clanker tokens, with anti-sniper skim"],
            ["ArcadeTokenVault", "Team vault for Clanker vesting"],
            ["ArcadeV2Factory / Router", "V2 AMM for migrated curve tokens"],
          ]}
          headers={["Contract", "Role"]}
        />
      </Section>

      <Section id="trust" title="10. Trust model">
        <h3 className="mt-4 font-semibold text-arc-text">On-chain</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Locker principal is unwithdrawable. No <code>decreaseLiquidity</code>, no NFT transfer, only <code>burn(0)</code> for fee poking</li>
          <li>Recipient bps are immutable post-launch</li>
          <li>Vault uses linear vesting; no admin override</li>
          <li>Pool fees accrue per the standard V3 math; <code>previewFees</code> view gives exact claimable</li>
        </ul>

        <h3 className="mt-4 font-semibold text-arc-text">Off-chain (Twitter escrow)</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>A single backend signer attests OAuth-verified handles via EIP-712</li>
          <li>If the signer key is compromised, an attacker could divert pending balances of Twitter-attributed slots. Mainnet rollout will migrate the signer to a 2-of-3 Safe multisig and optionally an HSM-backed key</li>
          <li>Past tx history (Arc Blockscout) and the immutable contracts are the source of truth</li>
        </ul>
      </Section>

      <div className="mt-12 rounded-2xl border border-arc-border bg-arc-bg-elevated p-4 text-xs text-arc-text-muted">
        Testnet only. Tokens have no monetary value. Don&apos;t LARP this as financial advice.
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
            <tr key={i} className="border-t border-arc-border">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 align-top text-arc-text">
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
