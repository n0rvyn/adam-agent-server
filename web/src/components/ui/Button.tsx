import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,border-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-canvas)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--app-accent)] text-white shadow-[var(--app-shadow-accent)] hover:bg-[var(--app-accent-strong)] hover:shadow-[var(--app-shadow-lg)]",
        secondary:
          "border border-[var(--app-border)] bg-white/[0.06] text-[var(--app-text)] hover:border-[var(--app-border-strong)] hover:bg-white/[0.1]",
        destructive:
          "bg-[var(--app-danger)] text-white shadow-[var(--app-shadow-danger)] hover:bg-[var(--app-danger-strong)]",
        ghost: "text-[var(--app-text-muted)] hover:text-[var(--app-text)] hover:bg-white/[0.06]",
        outline:
          "border border-[var(--app-border)] bg-transparent text-[var(--app-text)] hover:border-[var(--app-border-strong)] hover:bg-white/[0.04]",
        link: "text-[var(--app-accent-strong)] underline-offset-4 hover:underline",
      },
      size: {
        default: "px-3.5 py-1.5",
        sm: "px-3 py-1.5 text-xs",
        lg: "px-5 py-2.5",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
