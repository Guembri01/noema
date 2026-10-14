import { cn } from "@/lib/utils";
import type { InputHTMLAttributes } from "react";

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-md border border-border bg-bg px-3 text-sm text-fg outline-none placeholder:text-muted focus:border-accent",
        className,
      )}
      {...props}
    />
  );
}
