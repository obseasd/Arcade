"use client";

import { ArrowLeft, Rocket, Wallet } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { useAccount } from "wagmi";
import { TokenCard } from "@/components/launchpad/TokenCard";
import { HoldingCard } from "@/components/launchpad/HoldingCard";
import { CreatorFeesPanel } from "@/components/pool/CreatorFeesPanel";
import { CreatorEarningsCard } from "@/components/pool/CreatorEarningsCard";
import { VaultClaimPanel } from "@/components/pool/VaultClaimPanel";
import { PendingWithdrawalsCard } from "@/components/pool/PendingWithdrawalsCard";
import { useLaunchpadTokens } from "@/lib/hooks/useLaunchpadTokens";
import { useMyHoldings } from "@/lib/hooks/useMyHoldings";

const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;

export default function MyTokensPage() {
  const { address: account } = useAccount();
  const { tokens, isLoading } = useLaunchpadTokens();
  const { holdings, isLoading: holdingsLoading } = useMyHoldings();

  const mine = useMemo(() => {
    if (!account) return [];
    const acc = account.toLowerCase();
    return tokens.filter((t) => t.creator.toLowerCase() === acc);
  }, [tokens, account]);

  // Total USD value of the unified portfolio (sum of holdings + launched
  // tokens the user might also hold). Simple sum from the holdings hook;
  // launched tokens that the user kept are NOT double-counted because
  // useMyHoldings excludes the creator.
  const totalHoldingsUsd = useMemo(() => {
    let total = 0n;
    for (const h of holdings) {
      if (h.valueUsdcRaw !== undefined) total += h.valueUsdcRaw;
    }
    return total;
  }, [holdings]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <Link
        href="/launchpad"
        className="mb-6 inline-flex items-center gap-2 text-sm text-arc-text-muted transition-colors hover:text-arc-text"
      >
        <ArrowLeft className="h-4 w-4" /> Launchpad
      </Link>

      <div className="mb-8">
        <h1 className="text-3xl font-semibold sm:text-4xl">
          My{" "}
          <span className="bg-gradient-to-r from-arc-cta-hover to-arc-primary-hover bg-clip-text text-transparent">
            Tokens
          </span>
        </h1>
        <p className="mt-2 text-sm text-arc-text-muted">
          Tokens you&apos;ve launched, plus every position where this wallet can
          claim creator LP fees or vested allocations.
        </p>
      </div>

      {!account ? (
        <div className="arc-card p-12 text-center text-sm text-arc-text-muted">
          Connect your wallet to see your tokens.
        </div>
      ) : (
        <div className="space-y-10">
          {/* Earnings summary - self-hides if the wallet has no V3 locker
              positions and zero pending balance. */}
          <CreatorEarningsCard />

          {/* Self-hiding escape hatch: surfaces only when this wallet has a
              pending-withdrawal balance in the launchpad or locker ledgers. */}
          <PendingWithdrawalsCard />

          <Section
            title="Launched by you"
            empty={
              !isLoading && mine.length === 0
                ? {
                    icon: <Rocket className="mx-auto mb-3 h-8 w-8 text-arc-text-faint" />,
                    message: "You haven't launched any tokens yet.",
                    cta: (
                      <Link
                        href="/launchpad/create"
                        className="arc-button-primary mt-4 inline-block px-5 py-2 text-sm"
                      >
                        Launch a token
                      </Link>
                    ),
                  }
                : undefined
            }
            loading={isLoading}
          >
            {mine.length > 0 && (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {mine.map((token) => (
                  <TokenCard key={token.address} token={token} curveSupply={CURVE_SUPPLY} />
                ))}
              </div>
            )}
          </Section>

          <Section
            title="Held by you"
            subtitle={
              holdings.length > 0 && totalHoldingsUsd > 0n
                ? `${holdings.length} token${holdings.length === 1 ? "" : "s"} · approx $${(Number(totalHoldingsUsd) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                : "Tokens you hold from other creators' launches."
            }
            loading={holdingsLoading && holdings.length === 0}
            empty={
              !holdingsLoading && holdings.length === 0
                ? {
                    icon: <Wallet className="mx-auto mb-3 h-8 w-8 text-arc-text-faint" />,
                    message: "No holdings from other launches yet.",
                    cta: (
                      <Link
                        href="/launchpad"
                        className="arc-button-primary mt-4 inline-block px-5 py-2 text-sm"
                      >
                        Browse launchpad
                      </Link>
                    ),
                  }
                : undefined
            }
          >
            {holdings.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {holdings.map((h) => (
                  <HoldingCard key={h.token.address} holding={h} />
                ))}
              </div>
            )}
          </Section>

          <Section title="Creator fees" subtitle="Locked LP fees claimable on Clanker V3 launches you're attributed to.">
            <CreatorFeesPanel />
          </Section>

          <Section title="Vested allocations" subtitle="Claimable token allocations that were locked at launch.">
            <VaultClaimPanel />
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  loading,
  empty,
  children,
}: {
  title: string;
  subtitle?: string;
  loading?: boolean;
  empty?: { icon: React.ReactNode; message: string; cta?: React.ReactNode };
  children?: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-arc-text-muted">{subtitle}</p>}
      </div>
      {loading ? (
        <div className="arc-card p-8 text-center text-sm text-arc-text-muted">Loading…</div>
      ) : empty ? (
        <div className="arc-card p-12 text-center">
          {empty.icon}
          <p className="text-sm text-arc-text-muted">{empty.message}</p>
          {empty.cta}
        </div>
      ) : (
        children
      )}
    </section>
  );
}
