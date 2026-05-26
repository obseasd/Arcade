import type { Config } from "tailwindcss";

// Arc palette — primary deep navy (#001029) to steel blue (#345A78),
// with intermediates derived as evenly spaced HSL stops between them.
const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        arc: {
          // page backgrounds — near-black with hint of navy
          bg: "#04060C",          // page (very dark, almost black)
          "bg-elevated": "#0A1426", // sections / nav

          // surfaces (cards)
          surface: "#0F1B2E",     // base card
          "surface-2": "#15324F", // hover / nested
          "surface-3": "#1E4264", // emphasized

          // borders — semi-transparent gray so it blends with whatever sits behind the surface
          border: "rgba(142, 147, 143, 0.20)",
          "border-strong": "rgba(142, 147, 143, 0.35)",

          // brand
          primary: "#345A78",        // accents (borders, secondary chips)
          "primary-hover": "#42729A",
          "primary-soft": "#1E4264", // subtle backgrounds for primary chips
          // CTA — deeper, more saturated, used for actionable buttons
          cta: "#0E3A6A",
          "cta-hover": "#15508F",
          "cta-disabled": "#22405F", // muted between cta and surface, for disabled state

          // text
          text: "#E5EEF8",
          "text-muted": "#92A8C2",
          "text-faint": "#5E7896",

          // neutral gray (footer / muted elements)
          gray: "#8E938F",

          // semantic
          success: "#10B981",
          warn: "#F59E0B",
          danger: "#EF4444",
        },
      },
      boxShadow: {
        "arc-glow": "0 0 24px -4px rgba(52, 90, 120, 0.5)",
        "arc-card": "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 24px -8px rgba(0,0,0,0.5)",
        "arc-cta-glow": "0 22px 28px -8px rgba(52, 90, 120, 0.95), 0 14px 20px -4px rgba(52, 90, 120, 0.65), 0 6px 10px -2px rgba(52, 90, 120, 0.35)",
        "arc-nav-glow": "0 8px 24px -8px rgba(52, 90, 120, 0.6)",
      },
      backgroundImage: {
        "arc-gradient": "linear-gradient(135deg, #001029 0%, #15324F 60%, #345A78 100%)",
        "arc-card-gradient": "linear-gradient(180deg, #0A1F3A 0%, #061A36 100%)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "system-ui", "-apple-system", "sans-serif"],
        display: ["var(--font-space-grotesk)", "Space Grotesk", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      borderRadius: {
        xl: "14px",
        "2xl": "18px",
        "3xl": "24px",
      },
    },
  },
  plugins: [],
};

export default config;
