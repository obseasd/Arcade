// Sentry edge-runtime init (middleware, edge routes). No-op unless a DSN is set.
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    enabled: process.env.NODE_ENV === "production",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });
}
