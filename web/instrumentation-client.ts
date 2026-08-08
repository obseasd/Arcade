// Sentry client-side init. No-op unless NEXT_PUBLIC_SENTRY_DSN is set at build
// time (NEXT_PUBLIC_* are inlined into the client bundle). Runs in the browser.
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.01"),
    replaysOnErrorSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    enabled: process.env.NODE_ENV === "production",
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
    denyUrls: [
      /inpage\.js/i,
      /inject\.js/i,
      /proxy-injected-providers/i,
      /injectLeap/i,
      /extensions\//i,
      /^chrome-extension:\/\//i,
      /^moz-extension:\/\//i,
    ],
    ignoreErrors: [
      "Failed to connect to MetaMask",
      "Cannot set property chainId",
      "Could not establish connection. Receiving end does not exist",
      /Failed to execute '(insertBefore|removeChild)' on 'Node'/,
      "func sseError not found",
      /Cannot destructure property 'message_id'/,
      "QuotaExceededError",
      /Maximum call stack size exceeded/,
      /invalid border=0/,
      /has not been authorized yet/,
    ],
    beforeSend(event) {
      const frames = event.exception?.values?.[0]?.stacktrace?.frames;
      if (frames?.some((f) =>
        /inpage\.js|inject\.js|proxy-injected|injectLeap|extensions\//i.test(f.filename ?? "")
      )) {
        return null;
      }
      return event;
    },
  });
}

// Instruments Next.js App Router client-side navigations for tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
