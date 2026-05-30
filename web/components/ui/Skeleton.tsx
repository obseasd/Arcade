import { cn } from "@/lib/utils";

/**
 * Lightweight skeleton placeholder used wherever the page is waiting on RPC
 * reads. Pick one of the preset shapes (`text`, `block`, `circle`) or pass a
 * raw `className` to control sizing inline.
 *
 * Animation: subtle pulse via Tailwind's `animate-pulse`, no shimmer keyframe
 * to keep the page calm under N skeletons.
 */
interface Props {
  /** Tailwind classes that control width / height / extra styling. */
  className?: string;
  /** Convenience shape preset that picks sensible default dimensions. */
  shape?: "text" | "block" | "circle";
}

export function Skeleton({ className, shape = "block" }: Props) {
  const base = "animate-pulse rounded-md bg-arc-bg-elevated/80";
  const shapeClass =
    shape === "text"
      ? "h-3.5"
      : shape === "circle"
        ? "rounded-full"
        : "rounded-xl";
  return <div className={cn(base, shapeClass, className)} aria-hidden />;
}

/** Convenience: a card-sized rectangle with a couple of internal lines.
 *  Useful for token grids, position rows, etc. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "arc-card flex flex-col gap-3 p-4",
        "animate-pulse",
        className,
      )}
      aria-hidden
    >
      <div className="flex items-center gap-3">
        <Skeleton shape="circle" className="h-12 w-12 shrink-0" />
        <div className="flex-1 space-y-2">
          <Skeleton shape="text" className="w-2/3" />
          <Skeleton shape="text" className="w-1/3 opacity-60" />
        </div>
      </div>
      <Skeleton className="h-2 w-full" />
    </div>
  );
}
