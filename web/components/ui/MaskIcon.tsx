import Image from "next/image";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * Renders a PNG as a CSS-masked block colored with the current text-color
 * variable. Used for the brand icons (slider, filter, view toggles) so a
 * single asset adapts to dark/light without re-exporting tinted versions.
 *
 * Pass `className="bg-<colour>"` to override the default arc-text tint
 * (tailwind-merge handles the override correctly).
 */
export function MaskIcon({
    src,
    size = 16,
    className,
}: {
    src: string;
    size?: number;
    className?: string;
}) {
    return (
        <span
            className={cn("arc-mask-icon inline-block bg-arc-text", className)}
            // The 6 static mask-* props live in .arc-mask-icon in
            // globals.css; only width/height/--mask-src vary at runtime.
            style={
                {
                    width: size,
                    height: size,
                    "--mask-src": `url(${src})`,
                } as CSSProperties
            }
            aria-hidden
        />
    );
}

// --------------------------------------------------------------------------
// Brand-asset wrappers. Each one targets a single PNG in /public so we
// don't repeat the path string and can swap the asset in one place. Default
// size 14 (~h-3.5 w-3.5) matches the existing button icon sizing in
// /explore and /positions; pass `size` to override.
// --------------------------------------------------------------------------

type IconProps = { size?: number; className?: string };

export function SliderIcon({ size = 14, className }: IconProps) {
    return <MaskIcon src="/slider.png" size={size} className={className} />;
}

export function RefreshIcon({
    size = 14,
    className,
    spinning,
}: IconProps & { spinning?: boolean }) {
    return (
        <MaskIcon
            src="/reload.png"
            size={size}
            className={cn(spinning && "animate-spin", className)}
        />
    );
}

export function PlusIcon({ size = 14, className }: IconProps) {
    return <MaskIcon src="/plus.png" size={size} className={className} />;
}

export function MinusIcon({ size = 14, className }: IconProps) {
    return <MaskIcon src="/minus.png" size={size} className={className} />;
}

export function UpArrowIcon({ size = 14, className }: IconProps) {
    return <MaskIcon src="/uparrow.png" size={size} className={className} />;
}

export function DownArrowIcon({ size = 14, className }: IconProps) {
    return <MaskIcon src="/downarrow.png" size={size} className={className} />;
}

/** Full-colour PNG icon rendered directly (NOT as a CSS mask). Use for
 *  icons that already ship with their final colour baked in.
 *  - Forces a square box at `size` x `size` so a non-square source PNG
 *    doesn't make the parent layout stretch into a rectangle.
 *  - `object-contain` keeps the icon centred in the box with its
 *    aspect ratio preserved (uniform downscale, never cropped). */
function FullColourIcon({
    src,
    alt,
    size = 16,
    className,
}: {
    src: string;
    alt: string;
    size?: number;
    className?: string;
}) {
    return (
        <span
            style={{ width: size, height: size }}
            className={cn(
                "inline-flex shrink-0 items-center justify-center",
                className,
            )}
            aria-hidden={alt === "" ? true : undefined}
        >
            <Image
                src={src}
                alt={alt}
                width={size}
                height={size}
                style={{ width: size, height: size, objectFit: "contain" }}
                unoptimized
            />
        </span>
    );
}

/** Bigger down arrow used in MultiSwapCard between rows. */
export function DownArrowBigIcon({ size = 22, className }: IconProps) {
    return <FullColourIcon src="/downarrowbig.png" alt="" size={size} className={className} />;
}

/** Swap-flip glyph. Replaces lucide ArrowDownUp. */
export function SwitchIcon({ size = 20, className }: IconProps) {
    return <FullColourIcon src="/switch.png" alt="" size={size} className={className} />;
}

/** Close glyph used in modals. Replaces lucide X. */
export function CrossIcon({ size = 18, className }: IconProps) {
    return <FullColourIcon src="/cross.png" alt="" size={size} className={className} />;
}
