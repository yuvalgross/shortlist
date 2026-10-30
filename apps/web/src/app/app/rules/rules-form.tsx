"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Card, btn, field, label } from "@/components/ui";
import { saveRules, type RulesState } from "./actions";

export type RulesValues = {
  version: number | null;
  numbers: Record<string, number>;
  locations: { label: string; points: number }[];
  anchors: Record<"9" | "7" | "5" | "3", string>;
  benchmark: string;
};

function Submit() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className={btn.primary}>{pending ? "Saving…" : "Save rules"}</button>;
}

function Num({ name, text, v, step = "0.5" }: { name: string; text: string; v: number; step?: string }) {
  return (
    <label className={label}>
      {text}
      <input name={name} type="number" step={step} defaultValue={v} className={`${field} w-32`} />
    </label>
  );
}

export function RulesForm({ v, rows }: { v: RulesValues; rows: number }) {
  const [state, action] = useActionState<RulesState, FormData>(saveRules, { error: null, saved: false });
  const locs = [...v.locations, ...Array(Math.max(0, rows - v.locations.length)).fill({ label: "", points: 0 })].slice(0, rows);
  const x = v.numbers;
  return (
    <form action={action} className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">What a score means to you</h2>
        <p className="text-sm text-muted">The matching model judges role fit on this scale. Write it the way you would explain it to a friend.</p>
        {(["9", "7", "5", "3"] as const).map((k) => (
          <label key={k} className={label}>
            {k}/10 means
            <textarea name={`anchor_${k}`} rows={2} defaultValue={v.anchors[k]} className={field} />
          </label>
        ))}
        <label className={label}>
          Your ideal role (optional): what it does, which tools, what kind of company
          <textarea name="benchmark" rows={5} defaultValue={v.benchmark} className={field} />
        </label>
        <p className="text-sm text-muted">The ideal role is a reference. A job that matches most of it can score 8 or more when your record supports it; it never adds points on its own.</p>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Location points</h2>
        <p className="text-sm text-muted">Added to role fit. Each job gets the points of the one rule it meets, and only when the ad says so. Write each rule plainly, for example &quot;Spain, remote&quot; or &quot;Cyprus, on site or hybrid&quot;. Empty rows are ignored.</p>
        <div className="flex flex-col gap-2">
          {locs.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_96px] gap-2">
              <input name={`loc_label_${i}`} defaultValue={l.label} maxLength={120} aria-label={`Location rule ${i + 1}`} className={field} />
              <input name={`loc_points_${i}`} type="number" step="0.25" min={0} max={3} defaultValue={l.label ? l.points : ""} aria-label={`Points for rule ${i + 1}`} className={field} />
            </div>
          ))}
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Pay band</h2>
        <p className="text-sm text-muted">Compares a pay band the ad or the company states with the salary floor in Targets. No stated band means no points.</p>
        <div className="flex flex-wrap gap-4">
          <Num name="pay_below" text="Band tops out under your floor" v={x.pay_below} />
          <Num name="pay_inside" text="Your floor is inside the band" v={x.pay_inside} />
          <Num name="pay_above" text="Band starts at or above your floor" v={x.pay_above} />
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Your personal rules</h2>
        <p className="text-sm text-muted">
          Preferences from your own search, switched off at 0. Use them when a kind of role keeps going badly or well for you,
          for example minus 0.5 for roles that mainly run an existing setup. Each one only applies when the ad shows it with a quote.
          The three deductions and the large company minus together take no more than the cap.
        </p>
        <div className="flex flex-wrap gap-4">
          <Num name="build_small" text="Build role at a small company" v={x.build_small} />
          <Num name="build_small_max" text="Small means under (people)" v={x.build_small_max} step="1" />
          <Num name="ops_large" text="Ops titled role at a large company" v={x.ops_large} />
          <Num name="ops_large_min" text="Large means over (people)" v={x.ops_large_min} step="1" />
        </div>
        <div className="flex flex-wrap gap-4">
          <Num name="sales_ops" text="Mostly planning and admin" v={x.sales_ops} />
          <Num name="run_and_report" text="Runs an existing setup" v={x.run_and_report} />
          <Num name="ops_years_gap" text="Asks 5+ years in ops" v={x.ops_years_gap} />
          <Num name="deduction_cap" text="Cap for these together" v={x.deduction_cap} />
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Bars</h2>
        <div className="flex flex-wrap gap-4">
          <Num name="cv_threshold" text="Tailored CV from" v={x.cv_threshold} />
          <Num name="cv_run_and_report" text="CV bar when it runs an existing setup" v={x.cv_run_and_report} />
          <Num name="queue_threshold" text="Show in your queue from" v={x.queue_threshold} />
        </div>
        <p className="text-sm text-muted">The bars decide what happens with a score. They are never shown to the matching model, so a role fit is never pushed up to reach one.</p>
      </Card>

      {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
      {state.saved && <p role="status" className="text-sm text-[#0a4a3e]">Saved as a new version. The next score uses it; earlier scores keep the version that made them.</p>}
      <div className="flex items-center gap-4">
        <Submit />
        {v.version != null && <span className="text-sm text-muted">Current version: {v.version}</span>}
      </div>
    </form>
  );
}
