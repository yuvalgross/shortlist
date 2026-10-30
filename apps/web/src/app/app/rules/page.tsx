import { Suspense } from "react";
import { requireUser } from "@/lib/supabase/user";
import { PageTitle } from "@/components/ui";
import { anchorsFrom, locationRules } from "@/lib/score/rules";
import { RulesForm } from "./rules-form";
import { LOCATION_ROWS } from "./constants";

export default function RulesPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageTitle sub="How a job's score is built: role fit on your scale, then location, pay, team size and deductions. Every save is a new version.">Scoring rules</PageTitle>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <Rules />
      </Suspense>
    </div>
  );
}

// Same values as the database defaults (20261031000001_score_pasted_job.sql), shown before the first save.
// Personal rules start at 0: each user switches on the ones that fit their search.
const DEFAULT_RULES = {
  pay_band: { below: -1.5, inside: 0, above: 0.5 },
  team_size: { build_small_max: 150, build_small: 0, ops_large_min: 300, ops_large: 0 },
  deductions: { sales_ops: 0, run_and_report: 0, ops_years_gap: 0 },
  deduction_cap: -1,
  cv_threshold_by_factor: {} as { run_and_report?: number },
};
const DEFAULT_LOCATIONS = [
  { match: "home_city", points: 1.5 },
  { match: "remote_home_region", points: 1.5 },
  { match: "relocation", points: 0 },
];

async function Rules() {
  const { supabase } = await requireUser();
  const { data: c } = await supabase
    .from("scoring_configs")
    .select("version, cv_threshold, queue_threshold, location_points, rubric_anchors, benchmark_role, factor_rules")
    .eq("is_active", true)
    .maybeSingle();
  const r = { ...DEFAULT_RULES, ...(c?.factor_rules ?? {}) };
  const bench = c?.benchmark_role && typeof c.benchmark_role === "object" ? String(c.benchmark_role.text ?? "") : "";
  return (
    <RulesForm
      rows={LOCATION_ROWS}
      v={{
        version: c?.version ?? null,
        locations: locationRules(c?.location_points ?? DEFAULT_LOCATIONS),
        anchors: anchorsFrom(c?.rubric_anchors),
        benchmark: bench,
        numbers: {
          cv_threshold: Number(c?.cv_threshold ?? 8),
          queue_threshold: Number(c?.queue_threshold ?? 7),
          pay_below: r.pay_band.below, pay_inside: r.pay_band.inside, pay_above: r.pay_band.above,
          build_small_max: r.team_size.build_small_max, build_small: r.team_size.build_small,
          ops_large_min: r.team_size.ops_large_min, ops_large: r.team_size.ops_large,
          sales_ops: r.deductions.sales_ops, run_and_report: r.deductions.run_and_report, ops_years_gap: r.deductions.ops_years_gap,
          deduction_cap: r.deduction_cap,
          cv_run_and_report: r.cv_threshold_by_factor.run_and_report ?? Number(c?.cv_threshold ?? 8),
        },
      }}
    />
  );
}
