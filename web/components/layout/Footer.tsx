import { Github, Globe, BookOpen } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

/** Inline Discord glyph. lucide-react does not ship an official Discord icon
 *  and importing a separate icon library for one mark is overkill. Path
 *  data is the canonical Discord logo (current-color stroke disabled,
 *  fill follows the surrounding `text-` colour so hover states match
 *  the other footer icons without extra wiring). */
function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3.2a.07.07 0 0 0-.073.034c-.21.375-.444.864-.608 1.249-1.846-.275-3.68-.275-5.486 0-.164-.395-.408-.874-.617-1.249a.073.073 0 0 0-.073-.034 19.74 19.74 0 0 0-3.76 1.169.066.066 0 0 0-.03.027C2.79 7.913 2.069 11.353 2.42 14.75a.082.082 0 0 0 .031.056 19.91 19.91 0 0 0 5.993 3.03.07.07 0 0 0 .076-.027c.462-.63.873-1.295 1.226-1.994a.07.07 0 0 0-.04-.099 13.106 13.106 0 0 1-1.872-.892.071.071 0 0 1-.008-.118c.126-.094.252-.193.372-.291a.07.07 0 0 1 .073-.01c3.927 1.793 8.18 1.793 12.061 0a.069.069 0 0 1 .075.009c.12.099.246.198.373.292a.071.071 0 0 1-.006.118 12.319 12.319 0 0 1-1.873.891.07.07 0 0 0-.04.1c.36.699.772 1.363 1.225 1.994a.069.069 0 0 0 .076.027 19.84 19.84 0 0 0 6.002-3.03.07.07 0 0 0 .03-.056c.42-3.927-.704-7.337-2.977-10.354a.06.06 0 0 0-.029-.028zM8.02 12.68c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.957-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.974 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

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
            src="/arcdlogo22.png"
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
            href="https://discord.gg/NTx4Rkq2p5"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-arc-cta-hover"
            aria-label="Discord"
          >
            <DiscordIcon className="h-4 w-4" />
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
