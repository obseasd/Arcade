// Sentry server-side init (Node runtime). No-op unless a DSN is set, so the app
// runs identically with Sentry unconfigured. Set SENTRY_DSN (server) in the
// environment to activate. Loaded from instrumentation.ts register().
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Keep tracing cheap by default; tune via env.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    // Don't spam Sentry from local dev even if a DSN leaks into .env.local.
    enabled: process.env.NODE_ENV === "production",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });
}
