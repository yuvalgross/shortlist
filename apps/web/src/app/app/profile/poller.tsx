"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

const STUCK_AFTER = 5 * 60; // seconds

// While the CV is being read, refresh the page every few seconds so the result appears on its own.
// If it takes far longer than it should, show the retry button passed in as children.
export function Poller({ startedAt, children }: { startedAt: string; children: ReactNode }) {
  const router = useRouter();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.parse(startedAt);
    const tick = setInterval(() => setSeconds(Math.max(0, Math.round((Date.now() - start) / 1000))), 1000);
    const refresh = setInterval(() => router.refresh(), 4000);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
    };
  }, [router, startedAt]);

  if (seconds > STUCK_AFTER) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">This is taking longer than it should.</p>
        {children}
      </div>
    );
  }
  return (
    <p className="text-sm text-muted" aria-live="polite">
      Reading roles, results and skills… {seconds > 0 ? `${seconds}s. ` : ""}This usually takes under two minutes.
    </p>
  );
}
