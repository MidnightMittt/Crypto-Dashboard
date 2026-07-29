import { cn } from "@/lib/utils/cn";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-gradient-to-r from-white/[0.03] via-white/[0.07] to-white/[0.03] bg-[length:200%_100%]",
        className
      )}
    />
  );
}

/**
 * Placeholder for everything above the chart: the sentiment banner and the
 * four gauges. Deliberately excludes the chart row — the chart draws from
 * its own fast endpoint and is live while this is still showing, so covering
 * it with a skeleton would hide data we already have.
 */
export function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-52 w-full" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[380px] w-full" />
        ))}
      </div>
    </div>
  );
}

/** Placeholder for the panels below the chart. */
export function LowerSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
