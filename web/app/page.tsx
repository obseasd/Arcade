"use client";

import Link from "next/link";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import {
  ArrowRight,
  ChevronDown,
  Coins,
  Lock,
  Repeat,
  Rocket,
} from "lucide-react";

/* Shared easing: fast start, long satin tail. */
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/* Variants are factories rather than constants so the page can swap to a
 * no-op animation when the OS / browser reports prefers-reduced-motion.
 * WCAG 2.3.3 (Animation from Interactions) requires that motion is
 * either user-disablable or under 5 s and non-essential. react-doctor
 * flagged the previous always-on motion as accessibility-failing. */
function makeVariants(reduceMotion: boolean | null) {
  if (reduceMotion) {
    return {
      fadeUp: {
        hidden: { opacity: 1, y: 0 },
        visible: () => ({ opacity: 1, y: 0, transition: { duration: 0 } }),
      } satisfies Variants,
      cardGroup: { hidden: {}, visible: {} } satisfies Variants,
      cardItem: {
        hidden: { opacity: 1, y: 0 },
        visible: { opacity: 1, y: 0, transition: { duration: 0 } },
      } satisfies Variants,
    };
  }
  return {
    fadeUp: {
      hidden: { opacity: 0, y: 28 },
      visible: (i: number) => ({
        opacity: 1,
        y: 0,
        transition: { delay: i * 0.15, duration: 0.6, ease: EASE },
      }),
    } satisfies Variants,
    cardGroup: {
      hidden: {},
      visible: { transition: { staggerChildren: 0.14 } },
    } satisfies Variants,
    cardItem: {
      hidden: { opacity: 0, y: 24 },
      visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE } },
    } satisfies Variants,
  };
}

/* Inline heading icon: sits on the text baseline inside a soft chip so the
   glyph reads as punctuation, not clipart. */
function HeadingIcon({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className="mx-1 inline-flex h-[0.85em] w-[0.85em] translate-y-[0.08em] items-center justify-center rounded-xl border border-arc-border bg-arc-primary-soft/60 align-baseline text-arc-primary-hover [&>svg]:h-[60%] [&>svg]:w-[60%]"
    >
      {children}
    </span>
  );
}

export default function Home() {
  // Respect OS-level prefers-reduced-motion. Pulls the user pref via
  // CSS media query; null until the page mounts then resolves to bool.
  const reduceMotion = useReducedMotion();
  const { fadeUp, cardGroup, cardItem } = makeVariants(reduceMotion);
  return (
    <HomeInner fadeUp={fadeUp} cardGroup={cardGroup} cardItem={cardItem} />
  );
}

function HomeInner({
  fadeUp,
  cardGroup,
  cardItem,
}: {
  fadeUp: Variants;
  cardGroup: Variants;
  cardItem: Variants;
}) {
  return (
    <div className="relative w-full overflow-x-clip">
      <HeroBackdrop />

      {/* ------------------------------------------------------------------ */}
      {/* Hero: fills the first viewport minus the navbar                     */}
      {/* ------------------------------------------------------------------ */}
      <section
        className="relative mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-7xl flex-col items-center px-4 sm:px-6"
        style={{ paddingTop: "clamp(40px, 8vw, 80px)" }}
      >
        <div className="flex w-full max-w-[640px] flex-col items-center text-center">
          <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={0}>
            <div className="arc-pill mb-7">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-arc-success opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-arc-success" />
              </span>
              Live on Arc Testnet
            </div>
            <h1
              className="font-display font-semibold text-arc-text"
              style={{
                fontSize: "clamp(2rem, 6vw, 4rem)",
                lineHeight: 1.05,
                letterSpacing: "-0.02em",
              }}
            >
              Trade
              <HeadingIcon>
                <Repeat strokeWidth={2.4} />
              </HeadingIcon>
              and launch
              <HeadingIcon>
                <Rocket strokeWidth={2.4} />
              </HeadingIcon>
              tokens.{" "}
              <span className="whitespace-nowrap">
                All in{" "}
                <span className="bg-gradient-to-r from-arc-primary-hover to-arc-text bg-clip-text text-transparent">
                  USDC
                </span>
                <HeadingIcon>
                  <Coins strokeWidth={2.4} />
                </HeadingIcon>
              </span>
            </h1>
          </motion.div>

          <motion.p
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={1}
            className="mt-6 max-w-[560px] font-sans text-arc-text-muted opacity-90"
            style={{ fontSize: "clamp(0.95rem, 2vw, 1.125rem)", lineHeight: 1.65 }}
          >
            Arcade is the capital formation venue on Arc, Circle&apos;s EVM L1.
            Bonding-curve fair launches graduate atomically into AMM liquidity,
            and locked-LP fees stream back to creators. Every pool quoted in
            USDC: no wrapper, no FX leg.
          </motion.p>

          <motion.div
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={2}
            className="mt-10 flex flex-wrap items-center justify-center gap-3"
          >
            <motion.div whileHover={{ scale: 1.04, filter: "brightness(1.1)" }} whileTap={{ scale: 0.96 }}>
              <Link
                href="/swap"
                className="inline-flex items-center gap-2 rounded-full bg-arc-cta px-7 py-[17px] font-sans text-base font-semibold text-white shadow-arc-cta-glow transition-colors hover:bg-arc-cta-hover"
              >
                Open Swap <ArrowRight className="h-4 w-4" />
              </Link>
            </motion.div>
            <motion.div whileHover={{ scale: 1.04, filter: "brightness(1.1)" }} whileTap={{ scale: 0.96 }}>
              <Link
                href="/launchpad"
                className="inline-flex items-center gap-2 rounded-full border border-arc-border bg-transparent px-7 py-[17px] font-sans text-base font-semibold text-arc-text transition-colors hover:border-arc-border-strong hover:bg-arc-surface/60"
              >
                Explore Launchpad <Rocket className="h-4 w-4" />
              </Link>
            </motion.div>
          </motion.div>

          {/* Stat strip: mock numbers until the indexer lands. */}
          <motion.div
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={3}
            className="mt-12 flex flex-wrap items-center justify-center gap-x-2 gap-y-2 rounded-full border border-arc-border bg-black/20 px-5 py-2.5 backdrop-blur-md"
          >
            <HeroStat value="12,481" label="trades today" />
            <StatDot />
            <HeroStat value="412" label="tokens launched" />
            <StatDot />
            <HeroStat value="$1.2M" label="TVL" />
          </motion.div>
        </div>

        {/* Scroll hint pinned to the bottom of the first viewport. */}
        <motion.div
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.2, duration: 0.8 }}
          className="pointer-events-none mt-auto pb-6 pt-12 text-arc-text-faint"
        >
          <motion.div
            animate={{ y: [0, 8, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          >
            <ChevronDown className="h-5 w-5" />
          </motion.div>
        </motion.div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Feature cards                                                       */}
      {/* ------------------------------------------------------------------ */}
      <motion.section
        variants={cardGroup}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.25 }}
        className="mx-auto grid w-full max-w-7xl gap-4 px-4 pb-24 pt-24 sm:grid-cols-3 sm:px-6"
      >
        <FeatureCard
          icon={<Coins className="h-5 w-5" />}
          title="USDC-native trading"
          body="Every pool is quoted in USDC and every fee settles in USDC. No wrapper, no FX leg, no volatile gas token to manage."
          variant={cardItem}
        />
        <FeatureCard
          icon={<Rocket className="h-5 w-5" />}
          title="Fair-launch issuance"
          body="Launch a token on a USDC-denominated bonding curve. On graduation it migrates atomically into an AMM pool, no presale, no team allocation."
          variant={cardItem}
        />
        <FeatureCard
          icon={<Lock className="h-5 w-5" />}
          title="Locked-LP fee streams"
          body="Provide liquidity to any pool and earn 0.25% of every trade. Graduated tokens lock their LP forever and stream creator fees automatically."
          variant={cardItem}
        />
      </motion.section>
    </div>
  );
}

function HeroStat({ value, label }: { value: string; label: string }) {
  return (
    <span className="text-xs text-arc-text-muted sm:text-sm">
      <span className="font-display font-semibold text-arc-text">{value}</span>{" "}
      {label}
    </span>
  );
}

function StatDot() {
  return <span aria-hidden className="text-arc-text-faint">·</span>;
}

function FeatureCard({
  icon,
  title,
  body,
  variant,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  variant: Variants;
}) {
  return (
    <motion.div
      variants={variant}
      whileHover={{ y: -4 }}
      transition={{ duration: 0.25, ease: EASE }}
      className="arc-card group p-6"
    >
      <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-arc-primary-soft text-arc-primary-hover transition-colors group-hover:bg-arc-surface-3 group-hover:text-arc-text">
        {icon}
      </div>
      <h3 className="font-display text-base font-semibold text-arc-text">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-arc-text-muted">{body}</p>
    </motion.div>
  );
}

/* ------------------------------------------------------------------------ */
/* Backdrop: faint grid + two slow-drifting blue blooms. The fixed           */
/* arc-header-glow from layout.tsx still paints the top-right; these add a   */
/* centered stage glow behind the heading without any video asset.           */
/* ------------------------------------------------------------------------ */
function HeroBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {/* Hairline grid, masked so it fades out toward the edges. */}
      <div className="arc-hero-grid absolute inset-0" />

      {/* Primary bloom behind the heading. */}
      <motion.div
        className="absolute left-1/2 top-[8%] h-[34rem] w-[52rem] -translate-x-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(21, 80, 143, 0.28) 0%, rgba(14, 58, 106, 0.14) 45%, transparent 70%)",
          filter: "blur(20px)",
        }}
        animate={{ x: ["-50%", "-46%", "-53%", "-50%"], y: [0, 14, -8, 0] }}
        transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Secondary cooler bloom, lower-left, counter-drifting. */}
      <motion.div
        className="absolute -left-40 top-[55%] h-[26rem] w-[40rem] rounded-full"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(52, 90, 120, 0.20) 0%, transparent 70%)",
          filter: "blur(24px)",
        }}
        animate={{ x: [0, 24, -12, 0], y: [0, -16, 10, 0] }}
        transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}
