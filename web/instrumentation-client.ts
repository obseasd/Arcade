// Sentry client-side init. No-op unless NEXT_PUBLIC_SENTRY_DSN is set at build
// time (NEXT_PUBLIC_* are inlined into the client bundle). Runs in the browser.
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    // Session Replay: only capture on error (privacy + quota friendly).
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0,
    enabled: process.env.NODE_ENV === "production",
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  });
}

// Instruments Next.js App Router client-side navigations for tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
