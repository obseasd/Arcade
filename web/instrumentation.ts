// Next.js instrumentation hook. Loads the Sentry server/edge config for the
// active runtime and forwards nested React Server Component errors to Sentry.
// All init is DSN-gated, so this is a no-op when Sentry is unconfigured.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
