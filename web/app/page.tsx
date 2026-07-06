"use client";

import Link from "next/link";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import {
  ArrowRight,
  Coins,
  Link as LinkIcon,
  Lock,
  Repeat,
  Rocket,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Static content                                                      */
/* ------------------------------------------------------------------ */

const PILLARS = [
  {
    icon: Coins,
    title: "USDC-native trading",
    body: "Every pool is quoted in USDC. Every fee settles in USDC. No wrapper, no FX leg.",
  },
  {
    icon: Rocket,
    title: "Fair-launch issuance",
    body: "Launch a token on a USDC-denominated bonding curve. Atomic migration to AMM on graduation.",
  },
  {
    icon: Lock,
    title: "Locked-LP fee streams",
    body: "Provide liquidity, earn 0.25% of every trade. Graduated tokens stream creator fees forever.",
  },
] as const;

const STEPS = [
  {
    num: "01",
    icon: LinkIcon,
    title: "Bridge USDC in",
    body: "Send USDC from any CCTP-supported chain to Arc in under 60s.",
  },
  {
    num: "02",
    icon: Repeat,
    title: "Trade or launch",
    body: "Swap any pair through the aggregator (Arcade V2, Arcade V3, Synthra, UnitFlow, XyloNet), or launch your own token on the bonding curve.",
  },
  {
    num: "03",
    icon: Coins,
    title: "Earn forever",
    body: "Provide LP, earn 0.25% on every trade. Or launch a token and stream creator fees from your locked LP.",
  },
] as const;

const BIG_NUMBERS = [
  { value: "$1.24M", label: "Volume routed" },
  { value: "412", label: "Tokens launched" },
  { value: "2,481", label: "Wallets" },
] as const;

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Home() {
  const reduced = useReducedMotion();
  const dur = reduced ? 0 : 0.55;

  const fadeUp: Variants = {
    hidden: { opacity: 0, y: reduced ? 0 : 18 },
    show: { opacity: 1, y: 0, transition: { duration: dur, ease: "easeOut" } },
  };

  const stagger: Variants = {
    hidden: {},
    show: {
      transition: { staggerChildren: reduced ? 0 : 0.12 },
    },
  };

  const viewport = { once: true, margin: "-100px" } as const;

  return (
    <div className="overflow-x-clip">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        {/* ------------------------------------------------------------ */}
        {/* 1. Hero                                                       */}
        {/* ------------------------------------------------------------ */}
        <section className="relative flex flex-col items-center pb-20 pt-20 text-center">
          {/* Hairline grid with radial fade — reads as "market structure"
              without competing with the fixed arc-header-glow above. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-8 -z-10 h-[34rem]"
            style={{
              backgroundImage:
                "linear-gradient(to right, rgba(142,147,143,0.14) 1px, transparent 1px), linear-gradient(to bottom, rgba(142,147,143,0.14) 1px, transparent 1px)",
              backgroundSize: "56px 56px",
              maskImage:
                "radial-gradient(ellipse 60% 55% at 50% 35%, black 0%, transparent 75%)",
              WebkitMaskImage:
                "radial-gradient(ellipse 60% 55% at 50% 35%, black 0%, transparent 75%)",
            }}
          />

          <motion.div
            variants={stagger}
            initial="hidden"
            animate="show"
            className="flex flex-col items-center"
          >
            <motion.h1
              variants={fadeUp}
              className="max-w-3xl font-display text-5xl font-semibold tracking-tight text-arc-text sm:text-6xl"
            >
              Trade and launch tokens,{" "}
              <span className="bg-gradient-to-r from-sky-400 to-arc-text bg-clip-text text-transparent">
                USDC-native
              </span>
              , on Arc
            </motion.h1>

            <motion.p
              variants={fadeUp}
              className="mt-6 max-w-2xl text-lg text-arc-text-muted"
            >
              Arcade is the capital formation venue for stablecoin-native
              markets. AMM trading, bonding-curve issuance, and locked-LP fee
              streams, all settled in USDC on Circle&apos;s EVM L1.
            </motion.p>

            <motion.div
              variants={fadeUp}
              className="mt-10 flex flex-wrap items-center justify-center gap-3"
            >
              <Link href="/swap" className="arc-button-primary px-6 py-3 text-base">
                Open Swap <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/launchpad"
                className="arc-button-secondary px-6 py-3 text-base"
              >
                Explore Launchpad <Rocket className="h-4 w-4" />
              </Link>
            </motion.div>

            <motion.p
              variants={fadeUp}
              className="mt-8 text-sm text-arc-text-faint"
            >
              12.4K trades <span className="mx-2 text-arc-text-faint/60">&middot;</span>
              412 tokens launched <span className="mx-2 text-arc-text-faint/60">&middot;</span>
              $1.2M routed
            </motion.p>
          </motion.div>
        </section>

        {/* ------------------------------------------------------------ */}
        {/* 2. Feature pillars                                            */}
        {/* ------------------------------------------------------------ */}
        <motion.section
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          className="grid gap-4 pb-20 sm:grid-cols-3"
        >
          {PILLARS.map(({ icon: Icon, title, body }) => (
            <motion.div
              key={title}
              variants={fadeUp}
              whileHover={reduced ? undefined : { y: -4 }}
              className="arc-card p-6"
            >
              <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-400/10 text-sky-400">
                <Icon className="h-5 w-5" />
              </div>
              <h3 className="text-base font-semibold text-arc-text">{title}</h3>
              <p className="mt-2 text-sm text-arc-text-muted">{body}</p>
            </motion.div>
          ))}
        </motion.section>

        {/* ------------------------------------------------------------ */}
        {/* 3. How it works                                               */}
        {/* ------------------------------------------------------------ */}
        <section className="pb-20">
          <motion.div
            variants={fadeUp}
            initial="hidden"
            whileInView="show"
            viewport={viewport}
            className="mb-8 text-center"
          >
            <h2 className="font-display text-3xl font-semibold tracking-tight text-arc-text sm:text-4xl">
              How it works
            </h2>
            <p className="mt-3 text-arc-text-muted">
              From any chain to earning on Arc in three steps.
            </p>
          </motion.div>

          <motion.div
            variants={stagger}
            initial="hidden"
            whileInView="show"
            viewport={viewport}
            className="grid gap-4 sm:grid-cols-3"
          >
            {STEPS.map(({ num, icon: Icon, title, body }) => (
              <motion.div
                key={num}
                variants={fadeUp}
                whileHover={reduced ? undefined : { y: -4 }}
                className="arc-card p-6"
              >
                <div className="mb-5 flex items-center justify-between">
                  <span className="font-display text-sm font-semibold tracking-widest text-arc-text-faint">
                    {num}
                  </span>
                  <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-400/10 text-sky-400">
                    <Icon className="h-5 w-5" />
                  </div>
                </div>
                <h3 className="text-base font-semibold text-arc-text">{title}</h3>
                <p className="mt-2 text-sm text-arc-text-muted">{body}</p>
              </motion.div>
            ))}
          </motion.div>
        </section>

        {/* ------------------------------------------------------------ */}
        {/* 4. Live numbers band                                          */}
        {/* ------------------------------------------------------------ */}
        <section className="pb-20">
          <motion.div
            variants={stagger}
            initial="hidden"
            whileInView="show"
            viewport={viewport}
            className="arc-card grid gap-8 px-6 py-10 text-center sm:grid-cols-3"
          >
            {BIG_NUMBERS.map(({ value, label }) => (
              <motion.div key={label} variants={fadeUp}>
                <div className="font-display text-4xl font-semibold tracking-tight text-arc-text sm:text-5xl">
                  {value}
                </div>
                <div className="mt-2 text-sm text-arc-text-muted">{label}</div>
              </motion.div>
            ))}
            <motion.p
              variants={fadeUp}
              className="text-xs text-arc-text-faint sm:col-span-3"
            >
              Live numbers ship with the indexer roadmap.
            </motion.p>
          </motion.div>
        </section>

        {/* ------------------------------------------------------------ */}
        {/* 5. Footer CTA                                                 */}
        {/* ------------------------------------------------------------ */}
        <motion.section
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          className="flex flex-col items-center pb-24 text-center"
        >
          <h2 className="font-display text-3xl font-semibold tracking-tight text-arc-text sm:text-4xl">
            Ready to trade?
          </h2>
          <Link
            href="/swap"
            className="arc-button-primary mt-8 px-6 py-3 text-base"
          >
            Open Swap <ArrowRight className="h-4 w-4" />
          </Link>
        </motion.section>
      </div>
    </div>
  );
}
