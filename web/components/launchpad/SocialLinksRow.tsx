"use client";

import { Globe } from "lucide-react";
import type { TokenMetadata } from "@/lib/metadata";
import type { SocialKey } from "@/lib/socials";
import { cn } from "@/lib/utils";

/** Monochrome brand glyphs (single-path, currentColor) so the whole row reads as
 *  one muted icon set. Swap to the colored brand marks later if desired. */
function XIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
    );
}
function TelegramIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
            <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
        </svg>
    );
}
function DiscordIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
            <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9459 2.4189-2.1568 2.4189Z" />
        </svg>
    );
}
/** Farcaster arch (from vrypan/farcaster-brand purple-white.svg, purple bg
 *  dropped so the white arch renders as currentColor to match the row). */
export function FarcasterIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 1000 1000" fill="currentColor" className={className} aria-hidden>
            <path d="M257.778 155.556H742.222V844.444H671.111V528.889H670.414C662.554 441.677 589.258 373.333 500 373.333C410.742 373.333 337.446 441.677 329.586 528.889H328.889V844.444H257.778V155.556Z" />
            <path d="M128.889 253.333L157.778 351.111H182.222V746.667C169.949 746.667 160 756.616 160 768.889V795.556H155.556C143.283 795.556 133.333 805.505 133.333 817.778V844.444H382.222V817.778C382.222 805.505 372.273 795.556 360 795.556H355.556V768.889C355.556 756.616 345.606 746.667 333.333 746.667H306.667V253.333H128.889Z" />
            <path d="M675.556 746.667C663.283 746.667 653.333 756.616 653.333 768.889V795.556H648.889C636.616 795.556 626.667 805.505 626.667 817.778V844.444H875.556V817.778C875.556 805.505 865.606 795.556 853.333 795.556H848.889V768.889C848.889 756.616 838.94 746.667 826.667 746.667V351.111H851.111L880 253.333H702.222V746.667H675.556Z" />
        </svg>
    );
}

const ICONS: Record<SocialKey, (p: { className?: string }) => JSX.Element> = {
    twitter: XIcon,
    telegram: TelegramIcon,
    discord: DiscordIcon,
    website: (p) => <Globe {...p} />,
    farcaster: FarcasterIcon,
};

const ORDER: SocialKey[] = ["twitter", "telegram", "discord", "website", "farcaster"];

/** Renders one small linked icon per social link present on the token metadata.
 *  Nothing renders when the token has no socials. Icons are monochrome + muted,
 *  brightening on hover. `onClick` stops propagation so clicking an icon inside a
 *  card <Link> opens the social, not the token page. */
export function SocialLinksRow({
    metadata,
    className,
    iconClassName = "h-3.5 w-3.5",
}: {
    metadata: TokenMetadata | undefined;
    className?: string;
    iconClassName?: string;
}) {
    if (!metadata) return null;
    const links = ORDER.map((k) => ({ k, url: metadata[k] })).filter(
        (x): x is { k: SocialKey; url: string } => typeof x.url === "string" && x.url.length > 0,
    );
    if (links.length === 0) return null;
    return (
        <div className={cn("flex items-center gap-2", className)}>
            {links.map(({ k, url }) => {
                const Icon = ICONS[k];
                // A <span role="link">, NOT an <a>: these render inside the card's
                // own <Link> (an <a>), and nested anchors are invalid HTML. Open in
                // a new tab and stop the click from triggering the card navigation.
                const open = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.open(url, "_blank", "noopener,noreferrer");
                };
                return (
                    <span
                        key={k}
                        role="link"
                        tabIndex={0}
                        aria-label={k}
                        onClick={open}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") open(e);
                        }}
                        className="cursor-pointer text-arc-text-faint transition-colors hover:text-arc-text"
                    >
                        <Icon className={cn("shrink-0", iconClassName)} />
                    </span>
                );
            })}
        </div>
    );
}
