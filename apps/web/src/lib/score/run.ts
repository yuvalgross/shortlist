// Scores one pasted job: loads the user's confirmed profile and rules, asks the matching model,
// checks the answer in code (rules.ts) and saves it through score_pasted_job().
// Uses a Supabase client that acts as the signed in user, so row level security applies throughout.
import type { SupabaseClient } from "@supabase/supabase-js";
import { UserFacingError } from "@/lib/cv/errors";
import { accountProblem } from "@/lib/cv/run";
import { jobScoreUserMessage } from "./prompt";
import type { ScoreModelCall } from "./model";
import {
  EMPTY_TARGETS, anchorsFrom, checkScore, locationRules,
  type ScoreInput, type Targets, type TeamSizeRules,
} from "./rules";

const SCORING_PAUSED = "Scoring is paused right now because of a problem with the matching model account. Try again later.";
export const MIN_JOB_CHARS = 200;
export const MAX_JOB_CHARS = 40000;

export type ScoreOutcome = { ok: true; matchId: string } | { ok: false; error: string };

type Config = { location_points: unknown; rubric_anchors: unknown; benchmark_role: unknown; factor_rules: { team_size: TeamSizeRules } };

export async function loadRules(db: SupabaseClient) {
  let { data: cfg } = await db
    .from("scoring_configs")
    .select("location_points, rubric_anchors, benchmark_role, factor_rules")
    .eq("is_active", true)
    .maybeSingle<Config>();
  if (!cfg) {
    const { error } = await db.rpc("set_scoring_config", { cfg: {} });
    if (error) throw new Error(`Creating the default rules failed: ${error.message}`);
    ({ data: cfg } = await db
      .from("scoring_configs")
      .select("location_points, rubric_anchors, benchmark_role, factor_rules")
      .eq("is_active", true)
      .maybeSingle<Config>());
  }
  if (!cfg) throw new Error("No scoring rules found");
  const { data: t } = await db.from("targets").select("*").maybeSingle();
  const targets: Targets = { ...EMPTY_TARGETS, ...(t ?? {}), titles: Array.isArray(t?.titles) ? t.titles : [] };
  const benchmark = cfg.benchmark_role && typeof cfg.benchmark_role === "object" ? String((cfg.benchmark_role as { text?: unknown }).text ?? "") : "";
  return {
    locations: locationRules(cfg.location_points),
    anchors: anchorsFrom(cfg.rubric_anchors),
    benchmark,
    teamSize: cfg.factor_rules.team_size,
    targets,
  };
}

export async function scoreJob(db: SupabaseClient, input: ScoreInput, modelCall: ScoreModelCall | null): Promise<ScoreOutcome> {
  try {
    const jobText = input.jobText.trim();
    if (jobText.length < MIN_JOB_CHARS) throw new UserFacingError("Paste the full job ad: this is too short to score.");
    if (jobText.length > MAX_JOB_CHARS) throw new UserFacingError("The text is too long. Paste only the job ad, not the whole page.");
    if (!modelCall) throw new UserFacingError("Scoring is not switched on yet. The matching model key still needs to be added.");

    const { data: snapshot, error: snapError } = await db.rpc("my_profile_snapshot");
    if (snapError) throw new Error(`Reading the profile failed: ${snapError.message}`);
    const snap = (snapshot ?? {}) as Record<string, unknown>;
    if (!Array.isArray(snap.experiences) || snap.experiences.length === 0) {
      throw new UserFacingError("Confirm your profile first: scores compare the job with your confirmed roles and results.");
    }
    const rules = await loadRules(db);
    const notOnRecord = Array.isArray(snap.not_on_record) ? (snap.not_on_record as string[]) : [];
    // The model never sees the CV bar, the queue bar or the factor points: it only judges the work.
    const profile = { profile: snap.profile, experiences: snap.experiences, skills: snap.skills, stories: snap.stories };

    const message = jobScoreUserMessage({
      profile, notOnRecord, anchors: rules.anchors, benchmark: rules.benchmark, locations: rules.locations,
      targets: rules.targets, jobText, extra: { title: input.title, company: input.company, location: input.location },
    });
    const { raw, model, usage } = await modelCall(message);
    const c = checkScore(raw, { ...input, jobText }, { locations: rules.locations, teamSize: rules.teamSize }, rules.targets);

    const { data: saved, error: saveError } = await db.rpc("score_pasted_job", {
      p: {
        company: { name: c.company, headcount: c.headcount, headcount_source: c.headcount_source },
        job: {
          title: c.title, url: input.url ?? "", description: jobText, location_text: c.location_text,
          remote_type: c.remote_type, salary_min: c.salary.min, salary_max: c.salary.max,
          salary_currency: c.salary.currency, salary_period: c.salary.period, salary_is_ote: c.salary.is_ote,
        },
        match: {
          role_fit: c.role_fit, location_points: c.location_points, factors: c.factors, reasons: c.reasons,
          location_note: c.location_note,
          factor_scores: { ...c.details, location_label: c.location_label, model, usage },
        },
      },
    });
    if (saveError) throw new Error(`Saving the score failed: ${saveError.message}`);
    return { ok: true, matchId: String((saved as { match_id: string }).match_id) };
  } catch (err) {
    const known = err instanceof UserFacingError ? err.message : accountProblem(err, SCORING_PAUSED);
    if (!(err instanceof UserFacingError)) console.error("Job score failed", err);
    return { ok: false, error: known ?? "Something went wrong while scoring this job. Try again in a minute." };
  }
}
