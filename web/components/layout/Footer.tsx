import { Github, Globe, BookOpen } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

export function Footer() {
  return (
    <footer
      className="mt-16 border-t"
      style={{ borderTopColor: "rgba(142, 147, 143, 0.10)", borderTopWidth: "1px" }}
    >
      <div className="mx-auto grid max-w-7xl grid-cols-3 items-center px-4 py-4 text-sm sm:px-6">
        {/* Left: logo + version */}
        <div className="flex items-center gap-2.5">
          <Image
            src="/arcv2.png"
            alt="Arcade"
            width={24}
            height={24}
            className="h-6 w-6 object-contain"
          />
          <span className="font-display text-arc-gray">
            <span className="font-semibold text-arc-text">Arcade</span> v0.0.1
          </span>
        </div>

        {/* Center: social/doc icons - centered on viewport axis */}
        <div className="flex items-center justify-center gap-5 text-arc-gray">
          <a
            href="https://arcade.example/"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-arc-cta-hover"
            aria-label="Website"
          >
            <Globe className="h-4 w-4" />
          </a>
          <a
            href="https://github.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-arc-cta-hover"
            aria-label="GitHub"
          >
            <Github className="h-4 w-4" />
          </a>
          <Link
            href="/docs"
            className="transition-colors hover:text-arc-cta-hover"
            aria-label="Docs"
          >
            <BookOpen className="h-4 w-4" />
          </Link>
        </div>

        {/* Right: legal + copyright */}
        <div className="flex flex-col items-end gap-1 font-display text-xs text-arc-gray">
          <div className="flex items-center gap-3">
            <Link href="/terms" className="hover:text-arc-cta-hover">Terms</Link>
            <Link href="/privacy" className="hover:text-arc-cta-hover">Privacy</Link>
          </div>
          <span>© 2026 Arcade Labs. All rights reserved.</span>
        </div>
      </div>
    </footer>
  );
}
