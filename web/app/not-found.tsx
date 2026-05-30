import Link from "next/link";
import { ArrowLeft, Compass } from "lucide-react";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center justify-center px-4 py-32 text-center sm:px-6">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border border-arc-border bg-arc-bg-elevated text-arc-text-muted">
        <Compass className="h-8 w-8" />
      </div>
      <h1 className="font-display text-5xl font-semibold tracking-tight sm:text-6xl">
        4
        <span className="bg-gradient-to-r from-arc-cta-hover to-arc-primary-hover bg-clip-text text-transparent">
          0
        </span>
        4
      </h1>
      <p className="mt-3 max-w-md text-sm text-arc-text-muted">
        We couldn&apos;t find that page. It may have moved, been removed, or the
        link you followed is mistyped.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link href="/" className="arc-button-primary px-5 py-2.5 text-sm">
          <ArrowLeft className="h-4 w-4" /> Back to home
        </Link>
        <Link href="/launchpad" className="arc-button-secondary px-5 py-2.5 text-sm">
          Browse the Launchpad
        </Link>
      </div>
    </div>
  );
}
