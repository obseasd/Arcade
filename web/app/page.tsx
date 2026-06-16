"use client";

import Link from "next/link";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Coins,
  Layers,
  Lock,
  Rocket,
  Shield,
  Sparkles,
  Wallet,
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
  {
    icon: Sparkles,
    title: "Auto-managed V3 LP",
    body: "Compound fees automatically with anti-MEV cooldown, TWAP gate and slippage cap. Or auto-receive to your wallet.",
    badge: "NEW",
  },
] as const;

const PRODUCT_TILES = [
  {
    icon: BarChart3,
    title: "Swap",
    body: "Auto-routes V2 / V3 / Launchpad. Limit orders. Multi-swap up to 5 tokens.",
    href: "/swap",
    cta: "Open swap",
  },
  {
    icon: Rocket,
    title: "Launchpad",
    body: "3 token creation modes. TwitterFeeEscrow. V4 prototype in build.",
    href: "/launchpad",
    cta: "Browse launches",
  },
  {
    icon: Layers,
    title: "Pools",
    body: "V2 and V3 grouped by token. Incentive campaigns. Live TVL + APR.",
    href: "/explore",
    cta: "Explore pools",
  },
  {
    icon: Wallet,
    title: "Positions",
    body: "Manage every LP across V2 and V3. Auto-compound, auto-receive, claim fees.",
    href: "/positions",
    cta: "View positions",
  },
] as const;

const BIG_NUMBERS = [
  { value: "$265.33", label: "Volume routed", spark: [12, 18, 14, 22, 28, 26, 35, 42, 38, 48, 56, 64] },
  { value: "35", label: "Tokens launched", spark: [4, 6, 9, 12, 14, 18, 22, 24, 28, 30, 33, 35] },
  { value: "11", label: "Unique wallets", spark: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11] },
] as const;

const TRUST_POINTS = [
  { icon: Shield, label: "Audit pass", body: "22 of 31 internal multi-agent findings shipped" },
  { icon: Coins, label: "USDC settlement", body: "Native L1 gas + every fee in USDC" },
  { icon: Sparkles, label: "Anti-MEV cooldown", body: "TWAP gate and slippage cap on every compound" },
] as const;

/* ------------------------------------------------------------------ */
/* Inline SVG decorations                                              */
/* ------------------------------------------------------------------ */

/** Soft animated glow orb. Position with absolute via the parent. */
function GlowOrb({
  className,
  delay = 0,
  size = 360,
  color = "rgba(14, 58, 106, 0.55)",
}: {
  className?: string;
  delay?: number;
  size?: number;
  color?: string;
}) {
  return (
    <motion.div
      aria-hidden
      className={`pointer-events-none absolute -z-10 rounded-full blur-3xl ${className ?? ""}`}
      style={{ width: size, height: size, background: color }}
      initial={{ opacity: 0.0, scale: 0.95 }}
      animate={{ opacity: [0.35, 0.6, 0.4], scale: [0.95, 1.05, 0.98] }}
      transition={{ duration: 8, repeat: Infinity, delay, ease: "easeInOut" }}
    />
  );
}

/** Decorative SVG chart line, used as background art in the hero. */
function HeroChartArt() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 800 240"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-40 w-full opacity-50"
    >
      <defs>
        <linearGradient id="hero-line" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#345A78" stopOpacity="0" />
          <stop offset="30%" stopColor="#42729A" stopOpacity="0.9" />
          <stop offset="70%" stopColor="#7DD3FC" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#345A78" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="hero-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#42729A" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#42729A" stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path
        d="M0 180 C 120 120, 200 200, 320 140 S 520 80, 640 140 S 760 100, 800 120 L 800 240 L 0 240 Z"
        fill="url(#hero-fill)"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.5 }}
      />
      <motion.path
        d="M0 180 C 120 120, 200 200, 320 140 S 520 80, 640 140 S 760 100, 800 120"
        fill="none"
        stroke="url(#hero-line)"
        strokeWidth="2"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 2.2, ease: "easeInOut" }}
      />
    </svg>
  );
}

/** Mini sparkline rendered behind big numbers. */
function Sparkline({ points }: { points: readonly number[] }) {
  if (points.length < 2) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const stepX = 100 / (points.length - 1);
  const path = points
    .map((p, i) => {
      const x = (i * stepX).toFixed(2);
      const y = (40 - ((p - min) / range) * 36).toFixed(2);
      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
  const fillPath = `${path} L 100 40 L 0 40 Z`;
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-12 w-full opacity-50"
    >
      <defs>
        <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#42729A" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#42729A" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill="url(#spark-fill)" />
      <path d={path} fill="none" stroke="#7DD3FC" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** Floating decorative coin used in the footer CTA. */
function FloatingCoin({
  className,
  delay = 0,
  duration = 6,
  size = 32,
}: {
  className?: string;
  delay?: number;
  duration?: number;
  size?: number;
}) {
  return (
    <motion.div
      aria-hidden
      className={`pointer-events-none absolute rounded-full border border-arc-border bg-arc-surface-2 ${className ?? ""}`}
      style={{ width: size, height: size }}
      initial={{ y: 0, opacity: 0 }}
      animate={{ y: [-8, 8, -8], opacity: [0.4, 0.8, 0.4] }}
      transition={{ duration, repeat: Infinity, delay, ease: "easeInOut" }}
    >
      <div className="absolute inset-1 rounded-full bg-gradient-to-br from-sky-400/60 to-arc-cta/40" />
    </motion.div>
  );
}

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
        <section className="relative flex flex-col items-center pb-24 pt-20 text-center">
          {/* Hairline grid with radial fade. Reads as market structure. */}
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

          {/* Animated glow orbs for depth. */}
          {!reduced && (
            <>
              <GlowOrb className="left-[-6rem] top-10" size={420} color="rgba(14, 58, 106, 0.45)" />
              <GlowOrb className="right-[-4rem] top-40" size={360} delay={2} color="rgba(125, 211, 252, 0.18)" />
              <GlowOrb className="left-1/2 top-72 -translate-x-1/2" size={520} delay={4} color="rgba(52, 90, 120, 0.35)" />
            </>
          )}

          {/* Hero chart art at the bottom of the section. */}
          <HeroChartArt />

          <motion.div
            variants={stagger}
            initial="hidden"
            animate="show"
            className="relative flex flex-col items-center"
          >
            <motion.div variants={fadeUp} className="relative mb-6">
              <div className="arc-pill">
                <motion.span
                  className="h-1.5 w-1.5 rounded-full bg-arc-success"
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                />
                Live on Arc Testnet
              </div>
              <motion.div
                aria-hidden
                className="absolute inset-0 -z-10 rounded-full bg-arc-success/30 blur-xl"
                animate={{ opacity: [0.3, 0.6, 0.3], scale: [0.95, 1.1, 0.95] }}
                transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
              />
            </motion.div>

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
              Arcade is the capital formation venue for stablecoin-native markets.
              AMM trading, bonding-curve issuance, and auto-managed LP, all settled
              in USDC on Circle&apos;s EVM L1.
            </motion.p>

            <motion.div
              variants={fadeUp}
              className="mt-10 flex flex-wrap items-center justify-center gap-3"
            >
              <Link href="/swap" className="arc-button-primary px-6 py-3 text-base shadow-arc-cta-glow">
                Open swap <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/launchpad"
                className="arc-button-secondary px-6 py-3 text-base"
              >
                Explore launchpad <Rocket className="h-4 w-4" />
              </Link>
              <Link
                href="/activity"
                className="arc-button-secondary px-6 py-3 text-base"
              >
                Live activity <ArrowUpRight className="h-4 w-4" />
              </Link>
            </motion.div>
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
          className="grid gap-4 pb-24 sm:grid-cols-2 lg:grid-cols-4"
        >
          {PILLARS.map(({ icon: Icon, title, body, ...rest }) => {
            const badge = "badge" in rest ? rest.badge : undefined;
            return (
              <motion.div
                key={title}
                variants={fadeUp}
                whileHover={reduced ? undefined : { y: -4 }}
                className="group relative overflow-hidden arc-card p-6"
              >
                {/* Hover glow that follows the pointer subtly */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 bg-gradient-to-br from-sky-400/0 via-sky-400/0 to-arc-cta/0 opacity-0 transition-opacity duration-300 group-hover:from-sky-400/[0.04] group-hover:via-transparent group-hover:to-arc-cta/[0.12] group-hover:opacity-100"
                />
                {/* Decorative corner accent */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full bg-sky-400/[0.05] blur-2xl"
                />
                {badge && (
                  <span className="absolute right-4 top-4 inline-flex items-center rounded-full border border-arc-success/40 bg-arc-success/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-arc-success">
                    {badge}
                  </span>
                )}
                <div className="relative mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-sky-400/10 text-sky-400 ring-1 ring-sky-400/20">
                  <Icon className="h-5 w-5" />
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-xl bg-sky-400/10 blur-md"
                  />
                </div>
                <h3 className="relative text-base font-semibold text-arc-text">{title}</h3>
                <p className="relative mt-2 text-sm text-arc-text-muted">{body}</p>
              </motion.div>
            );
          })}
        </motion.section>

        {/* ------------------------------------------------------------ */}
        {/* 3. Product showcase (replaces How it works)                   */}
        {/* ------------------------------------------------------------ */}
        <section className="pb-24">
          <motion.div
            variants={fadeUp}
            initial="hidden"
            whileInView="show"
            viewport={viewport}
            className="mb-10 text-center"
          >
            <h2 className="font-display text-3xl font-semibold tracking-tight text-arc-text sm:text-4xl">
              Everything onchain, in one place
            </h2>
            <p className="mt-3 text-arc-text-muted">
              Trade, launch, provide, and earn. Built and tuned for Arc.
            </p>
          </motion.div>

          <motion.div
            variants={stagger}
            initial="hidden"
            whileInView="show"
            viewport={viewport}
            className="grid gap-4 sm:grid-cols-2"
          >
            {PRODUCT_TILES.map(({ icon: Icon, title, body, href, cta }) => (
              <motion.div
                key={title}
                variants={fadeUp}
                whileHover={reduced ? undefined : { y: -4 }}
                className="group relative overflow-hidden arc-card p-6"
              >
                {/* Subtle grid pattern unique to product tiles */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 -z-10 opacity-30"
                  style={{
                    backgroundImage:
                      "linear-gradient(to right, rgba(125,211,252,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(125,211,252,0.06) 1px, transparent 1px)",
                    backgroundSize: "40px 40px",
                    maskImage:
                      "radial-gradient(circle at 80% 0%, black 0%, transparent 65%)",
                    WebkitMaskImage:
                      "radial-gradient(circle at 80% 0%, black 0%, transparent 65%)",
                  }}
                />
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-arc-cta/15 text-sky-300 ring-1 ring-arc-cta/30">
                      <Icon className="h-5 w-5" />
                    </div>
                    <h3 className="text-lg font-semibold text-arc-text">{title}</h3>
                    <p className="mt-2 text-sm text-arc-text-muted">{body}</p>
                    <Link
                      href={href}
                      className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-sky-300 transition-colors hover:text-sky-200"
                    >
                      {cta}
                      <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                    </Link>
                  </div>
                  {/* Decorative side art: stack of subtle bars */}
                  <div
                    aria-hidden
                    className="relative hidden h-24 w-20 shrink-0 sm:block"
                  >
                    <div className="absolute bottom-0 left-0 h-10 w-3 rounded-sm bg-sky-400/20" />
                    <div className="absolute bottom-0 left-5 h-14 w-3 rounded-sm bg-sky-400/30" />
                    <div className="absolute bottom-0 left-10 h-20 w-3 rounded-sm bg-sky-400/40" />
                    <div className="absolute bottom-0 left-[3.75rem] h-16 w-3 rounded-sm bg-sky-400/25" />
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </section>

        {/* ------------------------------------------------------------ */}
        {/* 4. Live numbers band with sparklines                          */}
        {/* ------------------------------------------------------------ */}
        <section className="pb-24">
          <motion.div
            variants={stagger}
            initial="hidden"
            whileInView="show"
            viewport={viewport}
            className="arc-card relative overflow-hidden px-6 py-12"
          >
            {/* Inner gradient wash */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br from-arc-cta/[0.07] via-transparent to-sky-400/[0.05]"
            />
            <div className="grid gap-10 text-center sm:grid-cols-3">
              {BIG_NUMBERS.map(({ value, label, spark }) => (
                <motion.div key={label} variants={fadeUp} className="relative">
                  <Sparkline points={spark} />
                  <div className="relative font-display text-4xl font-semibold tracking-tight text-arc-text sm:text-5xl">
                    {value}
                  </div>
                  <div className="relative mt-2 text-sm text-arc-text-muted">{label}</div>
                </motion.div>
              ))}
            </div>
            <motion.p
              variants={fadeUp}
              className="mt-10 text-center text-xs text-arc-text-faint"
            >
              Live snapshot from{" "}
              <Link href="/activity" className="underline-offset-2 hover:text-arc-text-muted hover:underline">
                /activity
              </Link>
              . Refreshed hourly. Indexer cutover incoming.
            </motion.p>
          </motion.div>
        </section>

        {/* ------------------------------------------------------------ */}
        {/* 5. Trust strip                                                */}
        {/* ------------------------------------------------------------ */}
        <motion.section
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          className="grid gap-4 pb-24 sm:grid-cols-3"
        >
          {TRUST_POINTS.map(({ icon: Icon, label, body }) => (
            <motion.div
              key={label}
              variants={fadeUp}
              className="flex items-start gap-3 rounded-2xl border border-arc-border bg-arc-surface/40 p-4"
            >
              <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-arc-success/10 text-arc-success ring-1 ring-arc-success/30">
                <Icon className="h-4 w-4" />
              </div>
              <div>
                <div className="text-sm font-semibold text-arc-text">{label}</div>
                <div className="mt-0.5 text-xs text-arc-text-muted">{body}</div>
              </div>
            </motion.div>
          ))}
        </motion.section>

        {/* ------------------------------------------------------------ */}
        {/* 6. Footer CTA                                                 */}
        {/* ------------------------------------------------------------ */}
        <motion.section
          variants={fadeUp}
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          className="relative mb-24 flex flex-col items-center overflow-hidden rounded-3xl border border-arc-border bg-gradient-to-br from-arc-surface to-arc-surface-2 px-6 py-16 text-center"
        >
          {/* Floating decorative coins */}
          {!reduced && (
            <>
              <FloatingCoin className="left-[10%] top-8" size={28} delay={0} duration={6} />
              <FloatingCoin className="right-[12%] top-12" size={36} delay={1.2} duration={7} />
              <FloatingCoin className="left-[18%] bottom-10" size={24} delay={2.4} duration={5.5} />
              <FloatingCoin className="right-[22%] bottom-14" size={32} delay={3.2} duration={6.5} />
            </>
          )}

          {/* Inner accent */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            style={{
              backgroundImage:
                "radial-gradient(ellipse at 50% 0%, rgba(125,211,252,0.10) 0%, transparent 60%), radial-gradient(ellipse at 50% 100%, rgba(14,58,106,0.30) 0%, transparent 60%)",
            }}
          />

          <h2 className="font-display text-3xl font-semibold tracking-tight text-arc-text sm:text-4xl">
            Ready to trade on Arc?
          </h2>
          <p className="mt-3 max-w-md text-sm text-arc-text-muted">
            One-click swaps, fair launches, auto-compounding LP, USDC settlement.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/swap" className="arc-button-primary px-6 py-3 text-base shadow-arc-cta-glow">
              Open swap <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/launchpad" className="arc-button-secondary px-6 py-3 text-base">
              Launch a token <Rocket className="h-4 w-4" />
            </Link>
          </div>
        </motion.section>
      </div>
    </div>
  );
}
