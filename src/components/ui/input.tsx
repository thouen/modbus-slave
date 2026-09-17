import * as React from "react"

import { cn } from "@/lib/utils"

type InputSize = "sm" | "default" | "lg"

interface InputProps extends Omit<React.ComponentProps<"input">, "size"> {
  size?: InputSize
}

function Input({ className, type, size = "default", ...props }: InputProps) {
  const sizeClasses: Record<InputSize, string> = {
    sm: "h-8 px-2.5 text-xs",
    default: "h-9 px-3 py-1 text-base md:text-sm",
    lg: "h-10 px-4 text-base",
  }

  return (
    <input
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/3 border-input w-full min-w-0 rounded-md border bg-transparent shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        sizeClasses[size],
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
export type { InputProps }
