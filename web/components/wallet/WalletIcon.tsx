/**
 * Small avatar element that prefers the connected wallet's own logo
 * (Backpack, MetaMask, Rabby, etc.) and falls back to a gradient
 * letter circle when the connector doesn't expose one. RainbowKit + wagmi
 * v2 typically populate `connector.icon` with a data URI; the fallback
 * is what we ship for headless / weird connectors.
 *
 * Used both in the header widget dropdown trigger and on the
 * /my-tokens portfolio page, so the user sees a consistent identity
 * marker across the app.
 */
interface Props {
    icon?: string;
    name: string;
    size?: number;
    /** Rounded shape. lg = subtle rounded rectangle (default), full = circle. */
    shape?: "lg" | "full";
}

export function WalletIcon({ icon, name, size = 24, shape = "lg" }: Props) {
    const radius = shape === "full" ? "rounded-full" : "rounded-lg";
    if (icon) {
        return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
                src={icon}
                alt={name}
                width={size}
                height={size}
                style={{ width: size, height: size }}
                className={radius}
            />
        );
    }
    return (
        <div
            style={{ width: size, height: size, fontSize: size * 0.42 }}
            className={`flex items-center justify-center ${radius} bg-gradient-to-br from-arc-primary to-arc-cta font-bold text-white`}
        >
            {name.slice(0, 1).toUpperCase()}
        </div>
    );
}
