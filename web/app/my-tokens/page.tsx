"use client";

import { ArrowLeft, Rocket } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { useAccount } from "wagmi";
import { TokenCard } from "@/components/launchpad/TokenCard";
import { useLaunchpadTokens } from "@/lib/hooks/useLaunchpadTokens";

const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;

export default function MyTokensPage() {
  const { address: account } = useAccount();
  const { tokens, isLoading } = useLaunchpadTokens();

  const mine = useMemo(() => {
    if (!account) return [];
    const acc = account.toLowerCase();
    return tokens.filter((t) => t.creator.toLowerCase() === acc);
  }, [tokens, account]);

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
          Tokens you&apos;ve launched. Tap any card to manage recipients and claim creator LP fees.
        </p>
      </div>

      {!account ? (
        <div className="arc-card p-12 text-center text-sm text-arc-text-muted">
          Connect your wallet to see the tokens you&apos;ve launched.
        </div>
      ) : isLoading ? (
        <div className="arc-card p-12 text-center text-sm text-arc-text-muted">Loading…</div>
      ) : mine.length === 0 ? (
        <div className="arc-card p-12 text-center">
          <Rocket className="mx-auto mb-3 h-8 w-8 text-arc-text-faint" />
          <p className="text-sm text-arc-text-muted">You haven&apos;t launched any tokens yet.</p>
          <Link
            href="/launchpad/create"
            className="arc-button-primary mt-4 inline-block px-5 py-2 text-sm"
          >
            Launch a token
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {mine.map((token) => (
            <TokenCard key={token.address} token={token} curveSupply={CURVE_SUPPLY} />
          ))}
        </div>
      )}
    </div>
  );
}
