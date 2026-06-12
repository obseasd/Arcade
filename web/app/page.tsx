import Link from "next/link";
import { ArrowRight, Rocket, Repeat, Droplets } from "lucide-react";

export default function Home() {
  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6">
      <section className="flex flex-col items-center pb-16 pt-20 text-center">
        <div className="arc-pill mb-6">
          <span className="h-1.5 w-1.5 rounded-full bg-arc-success" />
          Live on Arc Testnet
        </div>
        <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-arc-text sm:text-6xl">
          USDC-native AMM and fair-launch tokenization on{" "}
          <span className="bg-gradient-to-r from-arc-primary to-arc-text bg-clip-text text-transparent">
            Arc
          </span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-arc-text-muted">
          Arcade is a capital formation venue for stablecoin-native markets.
          AMM trading, bonding-curve token issuance, and locked-LP fee
          distribution, all settled in USDC on Arc, Circle&apos;s EVM L1.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link href="/swap" className="arc-button-primary px-6 py-3 text-base">
            Open Swap <ArrowRight className="h-4 w-4" />
          </Link>
          <Link href="/launchpad" className="arc-button-secondary px-6 py-3 text-base">
            Explore Launchpad <Rocket className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <section className="grid gap-4 pb-16 sm:grid-cols-3">
        <FeatureCard
          icon={<Repeat className="h-5 w-5" />}
          title="USDC-native trading"
          body="Every pool is quoted in USDC, every fee settles in USDC. No wrapper, no FX leg, no volatile gas token to manage."
        />
        <FeatureCard
          icon={<Rocket className="h-5 w-5" />}
          title="Fair-launch token issuance"
          body="Issue a token via a bonding curve denominated in USDC. Atomic migration to an AMM pool on graduation. Locked LP fees stream to creators."
        />
        <FeatureCard
          icon={<Droplets className="h-5 w-5" />}
          title="Permissionless liquidity"
          body="Provide liquidity to any pool, earn 0.25% of every trade. Locked-LP vault for migrated tokens distributes creator fees automatically."
        />
      </section>
    </div>
  );
}

function FeatureCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="arc-card p-6">
      <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-arc-primary-soft text-arc-primary">
        {icon}
      </div>
      <h3 className="text-base font-semibold text-arc-text">{title}</h3>
      <p className="mt-2 text-sm text-arc-text-muted">{body}</p>
    </div>
  );
}
