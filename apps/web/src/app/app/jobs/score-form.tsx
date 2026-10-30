"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { btn, field, label } from "@/components/ui";
import { scorePastedJob, type ScoreState } from "./actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="submit" disabled={pending} className={btn.primary}>{pending ? "Scoring…" : "Score this job"}</button>
      {pending && <span className="text-sm text-muted" role="status">This takes about a minute. Keep the page open.</span>}
    </div>
  );
}

export function ScoreForm() {
  const [state, action] = useActionState<ScoreState, FormData>(scorePastedJob, { error: null });
  return (
    <form action={action} className="flex flex-col gap-4">
      <label className={label}>
        Job ad
        <textarea name="job_text" required minLength={200} maxLength={40000} rows={12} className={field}
          placeholder="Paste the full job ad: title, location, duties, requirements and pay if stated." />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={label}>Company<input name="company" maxLength={200} className={field} /></label>
        <label className={label}>Job title<input name="title" maxLength={300} className={field} /></label>
        <label className={label}>Location, if the ad leaves it out<input name="location" maxLength={300} className={field} placeholder="Berlin, hybrid" /></label>
        <label className={label}>Link to the company&apos;s own posting<input name="url" type="url" maxLength={2000} className={field} placeholder="https://" /></label>
        <label className={label}>Company headcount, if you know it<input name="headcount" inputMode="numeric" className={field} placeholder="65" /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className={label}>Pay they told you, from<input name="call_min" inputMode="numeric" className={field} placeholder="60000" /></label>
          <label className={label}>to<input name="call_max" inputMode="numeric" className={field} placeholder="75000" /></label>
        </div>
      </div>
      <p className="text-sm text-muted">
        Headcount and pay are optional. A headcount you type beats one in the ad, and pay from a call beats the ad.
        Leave them empty when you do not know: unknown means no points, never a guess.
      </p>
      {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
      <Submit />
    </form>
  );
}
