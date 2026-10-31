import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { ScreeningStatus } from "../lib/types";
import { STATUS_LABEL, STATUS_STYLE } from "../lib/format";

export function Card({ title, children, className = "", actions }: { title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={`rounded-xl border border-paper-200 bg-white p-5 shadow-sm sm:p-6 ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="font-serif text-xl font-semibold text-navy-900">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatusBadge({ status }: { status: ScreeningStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ring-1 ring-inset ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

type Variant = "primary" | "secondary" | "gold" | "danger" | "ghost";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-navy-800 text-white hover:bg-navy-700 focus-visible:outline-navy-800",
  secondary: "bg-white text-navy-800 ring-1 ring-inset ring-navy-200 hover:bg-navy-50 focus-visible:outline-navy-800",
  gold: "bg-gold-500 text-navy-900 hover:bg-gold-300 focus-visible:outline-gold-700",
  danger: "bg-red-700 text-white hover:bg-red-800 focus-visible:outline-red-700",
  ghost: "text-navy-700 hover:bg-navy-50 focus-visible:outline-navy-800",
};

export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-base font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warn" | "error" | "success"; title?: ReactNode; children?: ReactNode }) {
  const styles = {
    info: "border-navy-200 bg-navy-50 text-navy-900",
    warn: "border-gold-300 bg-gold-100 text-gold-700",
    error: "border-red-200 bg-red-50 text-red-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-lg border px-4 py-3 ${styles}`}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={title ? "mt-1 text-[0.95rem]" : ""}>{children}</div>}
    </div>
  );
}

/** Monospace hash/address with copy button. */
export function Hash({ value, href, label }: { value: string | null | undefined; href?: string | null; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-stone-500">—</span>;
  const display = value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="break-all font-mono text-sm text-navy-700 underline decoration-navy-200 underline-offset-2 hover:decoration-navy-700" title={value}>
          {label ?? display}
        </a>
      ) : (
        <code className="break-all font-mono text-sm text-navy-800" title={value}>
          {label ?? display}
        </code>
      )}
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
        className="rounded px-1 text-xs text-stone-500 hover:bg-paper-100 hover:text-navy-800"
        aria-label={`Copy ${value}`}
      >
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-stone-600" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-navy-200 border-t-navy-700" aria-hidden />
      {label}
    </span>
  );
}

export function Field({ label, hint, children, error }: { label: string; hint?: ReactNode; children: ReactNode; error?: string | null }) {
  return (
    <label className="block">
      <span className="block text-[0.95rem] font-semibold text-navy-900">{label}</span>
      {hint && <span className="mt-0.5 block text-sm text-stone-600">{hint}</span>}
      <div className="mt-1.5">{children}</div>
      {error && <span className="mt-1 block text-sm text-red-800">{error}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-base text-navy-900 shadow-sm focus:border-navy-600 focus:outline-none focus:ring-2 focus:ring-navy-200";

export function Dl({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[minmax(10rem,auto)_1fr]">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-sm font-semibold text-stone-600 sm:pt-0.5">{k}</dt>
          <dd className="min-w-0 text-navy-900">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
