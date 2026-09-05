import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
 * Ghost-first buttons per DESIGN.md §4: default transparent, hover fills with
 * #EBEBEB and promotes text to primary. Colour-only transitions — no transform
 * or opacity on interactive elements.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-[6px] text-[14px] font-normal leading-none whitespace-nowrap transition-colors outline-none disabled:pointer-events-none disabled:opacity-50 focus-visible:shadow-[0_0_0_2px_#fff,0_0_0_4px_var(--color-accent)]",
  {
    variants: {
      variant: {
        primary: "bg-foreground text-elevated hover:bg-foreground/90",
        secondary: "bg-elevated text-foreground shadow-border hover:bg-hover",
        ghost: "bg-transparent text-secondary hover:bg-hover hover:text-foreground",
        link: "bg-transparent text-accent underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 px-3",
        default: "h-10 px-4",
        lg: "h-12 px-6",
        icon: "size-10",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { buttonVariants };
