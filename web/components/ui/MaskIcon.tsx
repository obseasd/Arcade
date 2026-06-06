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
            className={cn("inline-block bg-arc-text", className)}
            style={{
                width: size,
                height: size,
                WebkitMaskImage: `url(${src})`,
                maskImage: `url(${src})`,
                WebkitMaskSize: "contain",
                maskSize: "contain",
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                maskPosition: "center",
            }}
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
