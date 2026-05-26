import { cn } from "@/lib/utils";

const PALETTES = [
  "from-arc-primary to-arc-surface-3",
  "from-arc-surface-3 to-arc-primary-hover",
  "from-arc-surface-2 to-arc-primary",
  "from-arc-primary-hover to-arc-surface-3",
];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function TokenLogo({ symbol, size = 32, className }: { symbol: string; size?: number; className?: string }) {
  const initial = (symbol || "?").slice(0, 1).toUpperCase();
  const palette = PALETTES[hash(symbol) % PALETTES.length];
  return (
    <div
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className={cn(
        "inline-flex items-center justify-center rounded-full font-semibold text-white",
        "bg-gradient-to-br",
        palette,
        className,
      )}
    >
      {initial}
    </div>
  );
}
