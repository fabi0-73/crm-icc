type Variant = "primary" | "secondary" | "destructive" | "ghost";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-brand-grad text-white shadow-brand hover:brightness-110 active:brightness-95",
  secondary:
    "border border-line-strong bg-paper text-ink shadow-xs hover:bg-mist",
  destructive: "bg-red-600 text-white hover:bg-red-700",
  ghost: "text-muted hover:bg-mist hover:text-ink",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
};

export function buttonClasses(variant: Variant = "primary", size: Size = "md") {
  return `inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-[filter,background-color,transform] active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]}`;
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
}) {
  return (
    <button
      {...props}
      className={`${buttonClasses(variant, size)} ${className}`}
    />
  );
}
