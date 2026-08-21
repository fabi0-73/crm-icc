/** The one form-control treatment used everywhere. */
const CONTROL =
  "w-full rounded-lg border border-line-strong bg-paper px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/80 shadow-xs transition-[border-color,box-shadow] focus:border-brand-600 focus:outline-none focus:ring-4 focus:ring-brand-600/10 disabled:bg-mist disabled:text-muted";

export function Label({
  className = "",
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      {...props}
      className={`mb-1.5 block text-[13px] font-medium text-ink ${className}`}
    />
  );
}

export function Input({
  className = "",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${CONTROL} ${className}`} />;
}

export function Select({
  className = "",
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${CONTROL} ${className}`} />;
}

export function Textarea({
  className = "",
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${CONTROL} ${className}`} />;
}
