import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
  {
    variants: {
      variant: {
        neutral: "bg-white/5 text-ink-muted border border-hairline",
        success: "bg-success/10 text-success border border-success/30",
        danger: "bg-danger/10 text-danger border border-danger/30",
        cyan: "bg-cyan/10 text-cyan border border-cyan/30",
        amber: "bg-amber/10 text-amber border border-amber/30",
      },
    },
    defaultVariants: { variant: "neutral" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
