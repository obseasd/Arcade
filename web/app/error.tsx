"use client";

import Link from "next/link";
import { AlertTriangle, RotateCcw, ArrowLeft } from "lucide-react";
import { useEffect } from "react";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Global error boundary. Next.js renders this when an unexpected exception
 * bubbles up past a route segment. Pre-mainnet we log to the console; in
 * production we'll wire this to Sentry / a real logger.
 */
export default function GlobalError({ error, reset }: Props) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[app error boundary]", error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center justify-center px-4 py-32 text-center sm:px-6">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border border-arc-danger/40 bg-arc-danger/10 text-arc-danger">
        <AlertTriangle className="h-8 w-8" />
      </div>
      <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
        Something went wrong
      </h1>
      <p className="mt-3 max-w-md text-sm text-arc-text-muted">
        Arcade hit an unexpected error. You can retry the action, or head back
        home if it keeps failing.
      </p>
      {error.digest && (
        <code className="mt-4 rounded-md border border-arc-border bg-black/40 px-2 py-1 text-[10px] text-arc-text-faint">
          ref: {error.digest}
        </code>
      )}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <button onClick={reset} className="arc-button-primary px-5 py-2.5 text-sm">
          <RotateCcw className="h-4 w-4" /> Retry
        </button>
        <Link href="/" className="arc-button-secondary px-5 py-2.5 text-sm">
          <ArrowLeft className="h-4 w-4" /> Home
        </Link>
      </div>
    </div>
  );
}
