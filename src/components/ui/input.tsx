import * as React from "react";
import { cn } from "@/lib/utils";

/* Form input per DESIGN.md §4: 40px height, shadow-as-border, focus outline. */
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "bg-elevated text-foreground placeholder:text-muted shadow-border h-10 w-full rounded-[6px] px-3 text-[14px] outline-none",
      "focus-visible:shadow-[0_0_0_2px_#fff,0_0_0_4px_var(--color-accent)]",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
