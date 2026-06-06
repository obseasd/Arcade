import { cn } from "@/lib/utils";

/**
 * Renders a PNG as a CSS-masked block colored with the current text-color
 * variable. Used for the brand icons (slider, filter, view toggles) so a
 * single asset adapts to dark/light without re-exporting tinted versions.
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
