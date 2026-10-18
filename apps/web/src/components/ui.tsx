import Link from "next/link";
import type { ReactNode } from "react";

// Small shared pieces so every screen looks the same as the approved mockups.

export const btn = {
  primary: "inline-flex items-center justify-center rounded-lg bg-accent px-5 py-3 font-medium text-white disabled:opacity-60",
  secondary: "inline-flex items-center justify-center rounded-lg border border-line bg-surface px-4 py-2.5 text-sm",
  small: "inline-flex items-center justify-center rounded-md border border-line bg-surface px-3 py-2 text-sm",
  smallPrimary: "inline-flex items-center justify-center rounded-md bg-accent px-3 py-2 text-sm text-white",
  link: "text-accent underline underline-offset-2",
};

export const field = "rounded-lg border border-line bg-surface px-3 py-2.5 text-base text-foreground";
export const label = "flex flex-col gap-1.5 text-sm text-muted";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-line bg-surface p-5 ${className}`}>{children}</section>;
}

export function SuggestionCard({ children }: { children: ReactNode }) {
  return <section className="rounded-xl border border-[#bfdcd2] bg-accent-soft p-5">{children}</section>;
}

export function Tag({ tone, children }: { tone: "ok" | "warn" | "muted"; children: ReactNode }) {
  const tones = {
    ok: "bg-[#e5f0ec] text-[#0a4a3e]",
    warn: "bg-[#fbebd8] text-[#7a3b05]",
    muted: "bg-[#ecEAE4] text-muted",
  };
  return <span className={`rounded px-2 py-0.5 font-mono text-xs ${tones[tone]}`}>{children}</span>;
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-3xl font-semibold tracking-tight">{children}</h1>
      {sub && <p className="text-muted">{sub}</p>}
    </div>
  );
}

const steps = [
  { href: "/app/upload", label: "1 Upload CV" },
  { href: "/app/profile", label: "2 Check profile" },
  { href: "/app/proof", label: "3 Proof bank" },
];

export function Steps({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap gap-2 text-sm">
      {steps.map((s, i) => (
        <li key={s.href}>
          <Link
            href={s.href}
            aria-current={i === current ? "step" : undefined}
            className={`inline-block rounded-full px-3.5 py-2 ${
              i === current ? "bg-foreground text-white" : i < current ? "bg-[#e5f0ec] text-[#0a4a3e]" : "border border-line text-muted"
            }`}
          >
            {s.label}
          </Link>
        </li>
      ))}
    </ol>
  );
}
