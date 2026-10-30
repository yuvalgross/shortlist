"use server";

import { requireUser } from "@/lib/supabase/user";
import { LOCATION_ROWS } from "./constants";

export type RulesState = { error: string | null; saved: boolean };

const n = (f: FormData, k: string) => {
  const raw = String(f.get(k) ?? "").trim().replace(",", ".");
  return raw === "" ? NaN : Number(raw);
};

export async function saveRules(_prev: RulesState, formData: FormData): Promise<RulesState> {
  const { supabase } = await requireUser();

  const locations: { label: string; points: number }[] = [];
  for (let i = 0; i < LOCATION_ROWS; i++) {
    const labelText = String(formData.get(`loc_label_${i}`) ?? "").trim().slice(0, 120);
    if (!labelText) continue;
    const points = n(formData, `loc_points_${i}`);
    if (!Number.isFinite(points) || points < 0 || points > 3) {
      return { error: `Points for "${labelText}" must be a number from 0 to 3.`, saved: false };
    }
    locations.push({ label: labelText, points });
  }
  if (!locations.length) return { error: "Add at least one location rule.", saved: false };

  const anchor = (k: string) => String(formData.get(`anchor_${k}`) ?? "").trim().slice(0, 500);
  const numbers: Record<string, number> = {};
  for (const k of [
    "cv_threshold", "queue_threshold", "pay_below", "pay_inside", "pay_above", "build_small_max", "build_small",
    "ops_large_min", "ops_large", "sales_ops", "run_and_report", "ops_years_gap", "deduction_cap", "cv_run_and_report",
  ]) {
    numbers[k] = n(formData, k);
    if (!Number.isFinite(numbers[k])) return { error: "Fill in every number on the page.", saved: false };
  }

  // Settings this screen does not show keep their current values
  const { data: current } = await supabase
    .from("scoring_configs")
    .select("weights, daily_scan_limit, cv_cap_per_run, rewrite_level")
    .eq("is_active", true)
    .maybeSingle();

  const { error } = await supabase.rpc("set_scoring_config", {
    cfg: {
      ...(current ?? {}),
      cv_threshold: numbers.cv_threshold,
      queue_threshold: numbers.queue_threshold,
      location_points: locations,
      rubric_anchors: { "9": anchor("9"), "7": anchor("7"), "5": anchor("5"), "3": anchor("3") },
      benchmark_role: { text: String(formData.get("benchmark") ?? "").trim().slice(0, 3000) },
      factor_rules: {
        pay_band: { below: numbers.pay_below, inside: numbers.pay_inside, above: numbers.pay_above },
        team_size: {
          build_small_max: Math.round(numbers.build_small_max), build_small: numbers.build_small,
          ops_large_min: Math.round(numbers.ops_large_min), ops_large: numbers.ops_large,
        },
        deductions: { sales_ops: numbers.sales_ops, run_and_report: numbers.run_and_report, ops_years_gap: numbers.ops_years_gap },
        deduction_cap: numbers.deduction_cap,
        // A bar at or under the normal CV bar adds nothing, so it is left out
        cv_threshold_by_factor: numbers.cv_run_and_report > numbers.cv_threshold ? { run_and_report: numbers.cv_run_and_report } : {},
      },
    },
  });
  if (error) return { error: `Not saved: ${error.message}.`, saved: false };
  return { error: null, saved: true };
}
