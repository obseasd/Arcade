"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { HeaderWalletWidget } from "./HeaderWalletWidget";

const NAV_ITEMS = [
  { href: "/swap", label: "Swap" },
  { href: "/launchpad", label: "Launchpad" },
  { href: "/explore", label: "Explore" },
  { href: "/positions", label: "Positions" },
  { href: "/bridge", label: "Bridge" },
];

export function Navbar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile menu whenever the route changes so a tap on a link
  // doesn't leave the drawer open.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <header className="sticky top-0 z-40 bg-transparent">
      <div className="mx-auto flex h-20 max-w-7xl items-center justify-between px-4 sm:h-24 sm:px-6">
        {/* Left: logo */}
        <Link href="/" className="flex items-center gap-3">
          <Image
            src="/arcdlogo.png"
            alt="Arcade"
            width={48}
            height={48}
            className="h-12 w-12 object-contain"
            priority
          />
          <span className="font-display text-2xl font-semibold tracking-tight">Arcade</span>
        </Link>

        {/* Center: nav with active highlight (desktop only) */}
        <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 rounded-2xl border border-arc-border bg-black/15 px-2.5 py-1.5 backdrop-blur-xl md:flex">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "relative rounded-xl px-5 py-2 text-base font-medium transition-colors",
                  active ? "text-white" : "text-arc-text-muted hover:text-arc-text",
                )}
              >
                {item.label}
                {active && (
                  <>
                    <span
                      className="absolute -bottom-2 left-1/2 h-[3px] w-3/4 -translate-x-1/2 rounded-full bg-gradient-to-r from-transparent via-arc-cta-hover to-transparent"
                      aria-hidden
                    />
                    <span
                      className="pointer-events-none absolute bottom-[14px] left-1/2 h-6 w-full -translate-x-1/2 rounded-full opacity-90 blur-md"
                      style={{
                        background:
                          "radial-gradient(ellipse at center top, rgba(52, 90, 120, 0.95) 0%, rgba(52, 90, 120, 0.45) 35%, transparent 75%)",
                      }}
                      aria-hidden
                    />
                  </>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Right cluster: wallet widget + mobile hamburger */}
        <div className="flex items-center gap-2">
          <HeaderWalletWidget />
          <button type="button"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-arc-border bg-black/15 text-arc-text backdrop-blur-xl transition-colors hover:bg-white/5 md:hidden"
          >
            {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Mobile drawer - slides down under the header on small screens. */}
      {mobileOpen && (
        <div className="md:hidden">
          {/* Backdrop catches taps outside the panel. */}
          <div
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm"
            aria-hidden
          />
          <nav className="relative z-40 mx-4 mt-2 overflow-hidden rounded-2xl border border-arc-border bg-arc-bg-elevated/95 shadow-arc-card backdrop-blur-xl">
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "block border-b border-arc-border/40 px-4 py-3 text-sm font-medium transition-colors last:border-b-0",
                    active
                      ? "bg-arc-cta-hover/15 text-white"
                      : "text-arc-text-muted hover:bg-white/5 hover:text-arc-text",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      )}
    </header>
  );
}
