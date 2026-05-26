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
          Trade and launch tokens on{" "}
          <span className="bg-gradient-to-r from-arc-primary to-arc-text bg-clip-text text-transparent">
            Arc
          </span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-arc-text-muted">
          Arcade is a USDC-native DEX and bonding-curve launchpad built on Arc — Circle&apos;s EVM L1
          for stablecoin-first finance.
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
          title="USDC-native swaps"
          body="No wrapper, no detours. All pools are USDC-quoted because USDC is Arc's gas token."
        />
        <FeatureCard
          icon={<Rocket className="h-5 w-5" />}
          title="Fair token launches"
          body="Launch a token in seconds with a bonding curve. LP burned automatically at migration."
        />
        <FeatureCard
          icon={<Droplets className="h-5 w-5" />}
          title="Provide liquidity"
          body="Earn fees on every trade. Add and manage your LP positions in one place."
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
