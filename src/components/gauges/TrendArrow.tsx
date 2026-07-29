import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export function TrendArrow({ value, threshold = 0.01 }: { value: number; threshold?: number }) {
  if (Math.abs(value) < threshold) {
    return <Minus className="h-3.5 w-3.5 text-ink-faint" />;
  }
  return value > 0 ? (
    <ArrowUpRight className={cn("h-3.5 w-3.5 text-success")} />
  ) : (
    <ArrowDownRight className={cn("h-3.5 w-3.5 text-danger")} />
  );
}
