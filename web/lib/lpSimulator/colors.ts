/** Per-position palette used by the Liquidity Distribution chart and badges.
 *  Loops if there are more than 8 positions (UI caps at ~10 anyway). */
export const POSITION_COLORS = [
  "#7C5CFC", // purple
  "#22c55e", // green
  "#f59e0b", // amber
  "#2f7fd6", // blue
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#ef4444", // red
  "#84cc16", // lime
] as const;

/** Cumulative-sold line color (orange, matches the Clanker reference). */
export const CUMULATIVE_LINE_COLOR = "#f97316";

export function positionColor(index: number): string {
  return POSITION_COLORS[index % POSITION_COLORS.length];
}
