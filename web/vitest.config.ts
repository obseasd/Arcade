import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Audit A-7: Vitest harness for the frontend. Catches Permit2 encoding
 * regressions, UniversalRouter command byte drift, V3 path bytes
 * malformation, and useRouteQuotes race-condition bugs before they
 * ship. CI gating: a failed test blocks merge.
 *
 * Run: `npm run test` (added to package.json).
 * Watch mode: `npm run test:watch`.
 *
 * The harness skips DOM-heavy components for now — those would require
 * MSW + React Testing Library; the priority is the pure logic layer
 * (encoders, hooks, parsers) that historically shipped bugs silently.
 */
export default defineConfig({
    test: {
        include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
        environment: "node",
        globals: false,
        testTimeout: 5_000,
    },
    resolve: {
        alias: {
            "@/components": path.resolve(__dirname, "./components"),
            "@/lib": path.resolve(__dirname, "./lib"),
            "@/types": path.resolve(__dirname, "./types"),
            "@/constants": path.resolve(__dirname, "./constants"),
        },
    },
});
