// Pure scoring rules: everything here is plain code with no model involved, so it can be tested line by line.
// The model returns labels with quotes from the job ad; these functions decide what counts and turn it into
// the factor labels the database trigger (20261030000001_scoring_factors.sql) converts into points.
import type { RawScore } from "./schema";

// ---------------------------------------------------------------------------
// Settings the user controls (Targets and Rules screens)
// ---------------------------------------------------------------------------
export type LocationRule = { label: string; points: number };
export type Anchors = { "9": string; "7": string; "5": string; "3": string };
export type TargetTitle = { title: string; priority: number };

export type Targets = {
  titles: TargetTitle[];
  seniority: string | null;
  exclude_terms: string[];
  salary_min: number | null;
  salary_currency: string;
  industries: string[];
  company_blocklist: string[];
  required_language_skip: string[];
  open_to_relocation: string[];
};

export const EMPTY_TARGETS: Targets = {
  titles: [], seniority: null, exclude_terms: [], salary_min: null, salary_currency: "EUR",
  industries: [], company_blocklist: [], required_language_skip: [], open_to_relocation: [],
};

export const DEFAULT_ANCHORS: Anchors = {
  "9": "Almost every main duty is work I have done, with the tools the ad names, at the level it asks. Nothing important is missing.",
  "7": "Most duties match my record. One or two requirements are missing or only partly covered.",
  "5": "About half matches. Important requirements are missing, or it is a different kind of job.",
  "3": "Little overlap: a different function or level.",
};

// Older configs stored location points as {match, points} with fixed keys; newer ones as {label, points}.
const OLD_MATCH_LABELS: Record<string, string> = {
  home_city: "My home city (on site, hybrid or remote)",
  remote_home_region: "Remote from my home country or region",
  relocation: "Needs a move",
};

export function locationRules(raw: unknown): LocationRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r: { label?: unknown; match?: unknown; points?: unknown }) => ({
      label: String(r?.label ?? OLD_MATCH_LABELS[String(r?.match)] ?? r?.match ?? "").trim(),
      points: Number(r?.points),
    }))
    .filter((r) => r.label && Number.isFinite(r.points) && r.points >= 0 && r.points <= 3);
}

export function anchorsFrom(raw: unknown): Anchors {
  const a = (raw ?? {}) as Partial<Record<keyof Anchors, unknown>>;
  const pick = (k: keyof Anchors) => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : DEFAULT_ANCHORS[k]);
  return { "9": pick("9"), "7": pick("7"), "5": pick("5"), "3": pick("3") };
}

// ---------------------------------------------------------------------------
// Quotes: a label only counts when its quote is really in the job ad
// ---------------------------------------------------------------------------
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[•·▪●*]/g, " ")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Quotes that give points must be long enough to mean something ("the" or "Sales" proves nothing).
export const MIN_QUOTE_CHARS = 8;
export function quoteIn(quote: string, jobText: string, min = MIN_QUOTE_CHARS): boolean {
  const q = normalize(quote);
  return q.length >= min && normalize(jobText).includes(q);
}

// Every number written in a quote, as plain values: "EUR 60,000", "60.000", "60k", "1,2 Mio" are all read.
export function numbersIn(quote: string): number[] {
  const out: number[] = [];
  for (const m of quote.matchAll(/(\d[\d.,'\u00a0 ]*\d|\d)\s*(k|tsd|mio|m)?\b/gi)) {
    const digits = m[1].replace(/[^\d.,]/g, "");
    // A separator followed by exactly three digits is a thousands separator; otherwise a decimal point.
    const plain = digits.replace(/[.,](?=\d{3}(\D|$))/g, "").replace(",", ".");
    let n = Number(plain);
    if (!Number.isFinite(n)) continue;
    const unit = (m[2] ?? "").toLowerCase();
    if (unit === "k" || unit === "tsd") n *= 1000;
    if (unit === "mio" || unit === "m") n *= 1_000_000;
    out.push(n);
  }
  return out;
}
const inQuote = (value: number, quote: string) => numbersIn(quote).some((n) => Math.abs(n - value) < 0.5);

// A number the user typed: "70000", "70.000", "70,000", "70 000" and "70k" all mean 70000.
// Only the first number counts ("50-100" is 50). Anything else is 0, which means "not given".
export function parseAmount(input: string): number {
  const m = input.match(/\d[\d.,' \u00a0]*/);
  if (!m) return 0;
  let n = Number(m[0].replace(/[^\d]/g, ""));
  if (/^\s*\d[\d.,' \u00a0]*\s*k\b/i.test(input)) n *= 1000;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// ---------------------------------------------------------------------------
// Pay band against the user's floor (scan rule of 2026-10-15)
// ---------------------------------------------------------------------------
export type PayInput = { min: number; max: number; currency: string; period: "year" | "month" | "hour" | "none"; is_ote: boolean };
export type PayResult =
  | { band: "below" | "inside" | "above"; note: string }
  | { band: "not_stated"; note: string };

const money = (n: number, cur: string) => `${cur} ${Math.round(n / 1000)}k`;

export function payBand(pay: PayInput | null, floor: number | null, floorCurrency: string): PayResult {
  if (!pay) return { band: "not_stated", note: floor ? `pay not stated, check against ${money(floor, floorCurrency)}` : "pay not stated" };
  if (!floor) return { band: "not_stated", note: "no salary floor set in Targets, pay not compared" };
  const cur = (pay.currency || "").toUpperCase();
  if (cur && cur !== floorCurrency.toUpperCase()) {
    return { band: "not_stated", note: `pay is in ${cur}, your floor is in ${floorCurrency}; not compared` };
  }
  const yearly = pay.period === "month" ? 12 : pay.period === "year" ? 1 : 0;
  if (!yearly) {
    return { band: "not_stated", note: pay.period === "hour" ? "pay is stated per hour; not compared" : "the ad does not say if the pay is yearly or monthly; not compared" };
  }
  // OTE only: take base as half, as the scan does when the split is not given
  const base = pay.is_ote ? 0.5 : 1;
  let lo = pay.min > 0 ? pay.min * yearly * base : 0;
  let hi = pay.max > 0 ? pay.max * yearly * base : 0;
  if (lo && hi && lo > hi) [lo, hi] = [hi, lo];
  if (!lo && !hi) return { band: "not_stated", note: `pay not stated, check against ${money(floor, floorCurrency)}` };
  const range = lo && hi ? `${money(lo, floorCurrency)} to ${money(hi, floorCurrency)}` : money(lo || hi, floorCurrency);
  const ote = pay.is_ote ? " (half of OTE)" : "";
  if (lo && lo >= floor) return { band: "above", note: `band ${range}${ote} starts at or above your ${money(floor, floorCurrency)}` };
  if (hi && hi < floor) return { band: "below", note: `pay below floor: band ${range}${ote} tops out under your ${money(floor, floorCurrency)}` };
  return { band: "inside", note: `your ${money(floor, floorCurrency)} sits inside the band ${range}${ote}` };
}

// ---------------------------------------------------------------------------
// Team size (scan rule of 2026-10-28)
// ---------------------------------------------------------------------------
export type TeamSizeRules = { build_small_max: number; ops_large_min: number };
export function teamSize(shape: "build" | "ops_titled" | "other", headcount: number | null, r: TeamSizeRules) {
  if (headcount == null) return "unknown" as const;
  if (shape === "build" && headcount < r.build_small_max) return "build_small" as const;
  if (shape === "ops_titled" && headcount > r.ops_large_min) return "ops_large" as const;
  return "neutral" as const;
}

// ---------------------------------------------------------------------------
// Turning the model's answer into checked labels
// ---------------------------------------------------------------------------
export type ScoreInput = {
  jobText: string;
  title?: string;
  company?: string;
  url?: string;
  location?: string;
  headcount?: number | null;
  callPay?: { min: number; max: number } | null;
};

export type Checked = {
  company: string;
  title: string;
  location_text: string;
  remote_type: RawScore["remote_type"];
  role_fit: number;
  location_points: number;
  location_label: string | null;
  location_note: string;
  factors: Record<string, string | boolean>;
  headcount: number | null;
  headcount_source: "company_site" | "other" | null;
  salary: { min: number | null; max: number | null; currency: string | null; period: string | null; is_ote: boolean };
  reasons: { plus: string[]; minus: string[] };
  details: {
    summary: string;
    pay_note: string;
    languages: string[];
    shape: string;
    quotes: Record<string, string>;
    dropped: string[];
  };
};

// What is stored on the job: whole yearly or monthly amounts, low to high. Hourly or unclear pay is not stored.
export function savedSalary(pay: PayInput | null): Checked["salary"] {
  if (!pay || (pay.period !== "year" && pay.period !== "month")) return { min: null, max: null, currency: null, period: null, is_ote: false };
  const vals = [pay.min, pay.max].map((n) => (n > 0 ? Math.round(n) : null));
  const [lo, hi] = vals[0] != null && vals[1] != null && vals[0] > vals[1] ? [vals[1], vals[0]] : vals;
  return { min: lo, max: hi, currency: (pay.currency || "").toUpperCase().slice(0, 3) || null, period: pay.period, is_ote: pay.is_ote };
}

export function roundHalf(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(10, Math.max(0, Math.round(n * 2) / 2));
}

// The years a quote asks for. A range ("3-5 years", "3 to 5 years") asks for its lower end.
export const yearsIn = (quote: string) => Math.max(0, ...[...quote.matchAll(
  /(\d{1,2})(?:\s*(?:-|\u2013|to|bis)\s*(\d{1,2}))?\s*\+?\s*(?:years|yrs|jahre)/gi,
)].map((m) => Number(m[1])));

export function checkScore(
  raw: RawScore,
  input: ScoreInput,
  rules: { locations: LocationRule[]; teamSize: TeamSizeRules },
  targets: Pick<Targets, "salary_min" | "salary_currency">,
): Checked {
  if (!Number.isFinite(raw.role_fit) || raw.role_fit < 0 || raw.role_fit > 10) {
    throw new Error(`The matching model returned a role fit off the 0 to 10 scale (${raw.role_fit}).`);
  }
  const text = input.location ? `${input.jobText}\nLocation: ${input.location}` : input.jobText;
  const has = (q: string) => quoteIn(q, text);
  const dropped: string[] = [];
  const quotes: Record<string, string> = {};

  // Location: points only when the rule exists and the ad (or the location the user typed) backs it
  let locationPoints = 0;
  let locationLabel: string | null = null;
  let locationNote = raw.location.reason.trim();
  const rule = rules.locations[raw.location.rule];
  if (raw.location.rule >= 0 && rule) {
    if (rule.points === 0 || has(raw.location.quote)) {
      locationPoints = rule.points;
      locationLabel = rule.label;
      if (rule.points > 0) quotes.location = raw.location.quote;
    } else {
      dropped.push(`location "${rule.label}": its quote is not in the ad, so +0`);
      locationNote = `location not confirmed in the ad (${rule.label}?)`;
    }
  }

  // Deductions: each needs its own quote from the ad
  const factors: Record<string, string | boolean> = {};
  const deduction = (key: "sales_ops" | "run_and_report" | "ops_years_gap", applies: boolean, quote: string, extra = true) => {
    if (!applies) return;
    if (!has(quote)) return void dropped.push(`${key.replace(/_/g, " ")}: quote not found in the ad`);
    if (!extra) return void dropped.push(`${key.replace(/_/g, " ")}: the quote does not ask for 5 or more years`);
    factors[key] = true;
    quotes[key] = quote;
  };
  deduction("sales_ops", raw.sales_ops.applies, raw.sales_ops.quote);
  deduction("run_and_report", raw.run_and_report.applies, raw.run_and_report.quote);
  deduction("ops_years_gap", raw.ops_years_gap.applies, raw.ops_years_gap.quote, yearsIn(raw.ops_years_gap.quote) >= 5);

  // Pay: what the company said on a call beats the ad
  let pay: PayInput | null = null;
  let paySource: "call" | "posting" | null = null;
  if (input.callPay && (input.callPay.min > 0 || input.callPay.max > 0)) {
    pay = { ...input.callPay, currency: targets.salary_currency, period: "year", is_ote: false };
    paySource = "call";
  } else if (raw.salary.stated) {
    const amounts = [raw.salary.min, raw.salary.max].filter((n) => n > 0);
    if (!has(raw.salary.quote)) {
      dropped.push("pay: quote not found in the ad, treated as not stated");
    } else if (!amounts.length || !amounts.every((n) => inQuote(n, raw.salary.quote))) {
      dropped.push("pay: the amounts are not the ones in the quote, treated as not stated");
    } else {
      pay = { min: raw.salary.min, max: raw.salary.max, currency: raw.salary.currency, period: raw.salary.period, is_ote: raw.salary.is_ote };
      paySource = "posting";
      quotes.pay = raw.salary.quote;
    }
  }
  const payResult = payBand(pay, targets.salary_min, targets.salary_currency);
  factors.pay_band = payResult.band;
  if (payResult.band !== "not_stated" && paySource) factors.pay_band_source = paySource;

  // Team size: the headcount the user typed beats one stated in the ad
  let headcount: number | null = null;
  let headcountSource: Checked["headcount_source"] = null;
  if (input.headcount && input.headcount > 0) {
    headcount = Math.round(input.headcount);
    headcountSource = "other";
  } else if (raw.headcount.stated && raw.headcount.value > 0) {
    if (has(raw.headcount.quote) && inQuote(raw.headcount.value, raw.headcount.quote)) {
      headcount = Math.round(raw.headcount.value);
      headcountSource = "company_site";
      quotes.headcount = raw.headcount.quote;
    } else dropped.push("team size: the headcount is not in a quote from the ad");
  }
  let shape = raw.role_shape.value;
  if (shape !== "other" && !has(raw.role_shape.quote)) {
    dropped.push(`role shape "${shape.replace("_", " ")}": quote not found in the ad, so no team size points`);
    shape = "other";
  }
  factors.team_size = teamSize(shape, headcount, rules.teamSize);

  const plus = raw.plus.map((r) => r.point.trim()).filter(Boolean).slice(0, 8);
  const minus = raw.minus.map((r) => r.point.trim()).filter(Boolean).slice(0, 8);
  const languages = raw.languages_required.filter((l) => has(l.quote)).map((l) => l.language.trim()).filter(Boolean);

  return {
    company: (input.company || raw.company || "").trim().slice(0, 200),
    title: (input.title || raw.title || "").trim().slice(0, 300),
    location_text: (input.location || raw.location_text || "").trim().slice(0, 300),
    remote_type: raw.remote_type,
    role_fit: roundHalf(raw.role_fit),
    location_points: locationPoints,
    location_label: locationLabel,
    location_note: locationNote.slice(0, 300),
    factors,
    headcount,
    headcount_source: headcountSource,
    salary: savedSalary(pay),
    reasons: { plus, minus },
    details: { summary: raw.summary.trim(), pay_note: payResult.note, languages, shape, quotes, dropped },
  };
}

// ---------------------------------------------------------------------------
// The fit line, worded like the scan's: "fit 8 (role 7, Berlin +1.5, run and report minus 0.5)"
// ---------------------------------------------------------------------------
const num = (n: number) => String(Math.round(Math.abs(n) * 100) / 100);
const signed = (n: number) => (n < 0 ? `minus ${num(n)}` : `+${num(n)}`);
const FACTOR_WORDS: Record<string, string> = {
  pay_band: "pay",
  team_size: "team size",
  sales_ops: "sales ops",
  run_and_report: "run and report",
  ops_years_gap: "ops years gap",
};

export function fitLine(m: {
  total_fit: number;
  role_fit: number;
  location_points: number;
  location_label?: string | null;
  factor_points: Record<string, number>;
  factors?: Record<string, unknown>;
}): string {
  const parts = [`role ${num(m.role_fit)}`];
  parts.push(m.location_label ? `${m.location_label} ${signed(m.location_points)}` : `location ${signed(m.location_points)}`);
  const capped = typeof m.factor_points.deduction_cap === "number";
  for (const [k, v] of Object.entries(m.factor_points)) {
    if (k === "deduction_cap" || v === 0) continue;
    let word = FACTOR_WORDS[k] ?? k.replace(/_/g, " ");
    if (k === "pay_band") word = m.factors?.pay_band === "below" ? "pay below floor" : "pay above floor";
    if (k === "team_size") word = v > 0 ? "small team" : "large team, ops title";
    parts.push(`${word} ${signed(v)}`);
  }
  if (capped) parts.push(`deductions capped at ${signed(m.factor_points.deduction_cap)}`);
  const raw = m.role_fit + m.location_points + Object.entries(m.factor_points).reduce((s, [k, v]) => {
    if (capped && ["sales_ops", "run_and_report", "ops_years_gap"].includes(k)) return s;
    if (capped && k === "team_size" && v < 0) return s;
    return s + v;
  }, 0);
  if (raw > 10) parts.push("capped at 10");
  return `fit ${num(m.total_fit)} (${parts.join(", ")})`;
}
