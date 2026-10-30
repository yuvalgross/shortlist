"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { btn, field, label } from "@/components/ui";
import { saveTargets, type TargetsState } from "./actions";

export type TargetsValues = {
  titles: string; seniority: string; salary_min: string; salary_currency: string; keep_no_salary: boolean;
  industries: string; company_blocklist: string; exclude_terms: string; required_language_skip: string; open_to_relocation: string;
};

function Submit() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className={btn.primary}>{pending ? "Saving…" : "Save targets"}</button>;
}

export function TargetsForm({ v }: { v: TargetsValues }) {
  const [state, action] = useActionState<TargetsState, FormData>(saveTargets, { error: null, saved: false });
  return (
    <form action={action} className="flex flex-col gap-5">
      <label className={label}>
        Job titles, one per line, most wanted first
        <textarea name="titles" rows={6} defaultValue={v.titles} className={field} placeholder={"GTM Engineer\nRevOps Engineer\nGTM Systems Lead"} />
      </label>
      <label className={label}>Seniority<input name="seniority" defaultValue={v.seniority} className={field} placeholder="Mid to senior, individual contributor" /></label>
      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <label className={label}>Salary floor, base per year<input name="salary_min" inputMode="numeric" defaultValue={v.salary_min} className={field} placeholder="70000" /></label>
        <label className={label}>
          Currency
          <select name="salary_currency" defaultValue={v.salary_currency} className={field}>
            {["EUR", "GBP", "CHF", "USD", "ILS", "SEK", "DKK", "NOK", "PLN"].map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
      </div>
      <p className="-mt-3 text-sm text-muted">Pay bands are compared with this floor: top under it is minus, floor inside the band is 0, bottom at or above it is plus. Bands in another currency are not compared.</p>
      <label className="flex items-center gap-3 text-sm">
        <input type="checkbox" name="keep_no_salary" defaultChecked={v.keep_no_salary} className="h-5 w-5" />
        Keep jobs that do not state pay
      </label>
      <label className={label}>Industries you want (comma or one per line)<textarea name="industries" rows={2} defaultValue={v.industries} className={field} placeholder="B2B SaaS, AI, HR tech" /></label>
      <label className={label}>Companies to skip<textarea name="company_blocklist" rows={2} defaultValue={v.company_blocklist} className={field} /></label>
      <label className={label}>Words that rule a job out<textarea name="exclude_terms" rows={2} defaultValue={v.exclude_terms} className={field} placeholder="intern, working student, pure SDR" /></label>
      <label className={label}>Skip jobs whose main language is<input name="required_language_skip" defaultValue={v.required_language_skip} className={field} placeholder="German, Dutch" /></label>
      <label className={label}>Places you would move to<input name="open_to_relocation" defaultValue={v.open_to_relocation} className={field} placeholder="Barcelona, Limassol, Malta" /></label>
      <p className="text-sm text-muted">Location points are set per place in Rules.</p>
      {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
      {state.saved && <p role="status" className="text-sm text-[#0a4a3e]">Saved. The next score uses these targets.</p>}
      <Submit />
    </form>
  );
}
