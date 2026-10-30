import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkScore, fitLine, locationRules, payBand, quoteIn, roundHalf, teamSize, anchorsFrom, DEFAULT_ANCHORS,
  numbersIn, parseAmount, savedSalary, yearsIn,
} from "@/lib/score/rules";
import type { RawScore } from "@/lib/score/schema";
import { scoreJob } from "@/lib/score/run";
import { claudeScoreCall, SCORE_MAX_TOKENS } from "@/lib/score/model";
import { UserFacingError } from "@/lib/cv/errors";
import { JOB_SCORE_SYSTEM } from "@/lib/score/prompt";

// Location rules as Yuval's scan uses them (standing rule of 2026-10-17)
const SCAN_LOCATIONS = [
  { label: "Berlin", points: 1.5 },
  { label: "Remote anywhere in the EU, including Germany", points: 1.5 },
  { label: "Spain, remote", points: 1.5 },
  { label: "Cyprus", points: 1.25 },
  { label: "Malta", points: 1 },
  { label: "Netherlands, remote", points: 0.75 },
  { label: "Southern Europe, remote", points: 0.5 },
  { label: "Any other EU city that needs a move", points: 0 },
];
const RULES = { locations: SCAN_LOCATIONS, teamSize: { build_small_max: 150, ops_large_min: 300 } };
const FLOOR = { salary_min: 70000, salary_currency: "EUR" };

const JD = `GTM Engineer, HubSpot, Automation & AI
Location: Remote CET +/-4h
About us: we are 65 people building Kubernetes management.
You own the HubSpot portal and build integrations with Make, n8n or Zapier.
You have 5+ years in Revenue Operations or Marketing Operations.
Take over and further develop our existing reporting for a sales team of 40.
Salary: EUR 50,000 to 90,000 per year.
Fluent German is required.`;

function raw(over: Partial<RawScore> = {}): RawScore {
  return {
    company: "Kubermatic", title: "GTM Engineer", location_text: "Remote CET", remote_type: "remote",
    salary: { stated: false, min: 0, max: 0, currency: "", period: "none", is_ote: false, quote: "" },
    headcount: { stated: false, value: 0, quote: "" },
    summary: "Build role on HubSpot and n8n. GA4 missing.",
    plus: [{ point: "HubSpot and n8n", quote: "You own the HubSpot portal" }],
    minus: [{ point: "GA4 not on record", quote: "" }],
    role_fit: 8,
    location: { rule: 1, reason: "Remote in CET", quote: "Location: Remote CET +/-4h" },
    languages_required: [],
    role_shape: { value: "build", quote: "build integrations" },
    sales_ops: { applies: false, quote: "" },
    run_and_report: { applies: false, quote: "" },
    ops_years_gap: { applies: false, years: 0, quote: "" },
    ...over,
  };
}

describe("quotes from the ad", () => {
  it("match across case, spacing, curly quotes and dashes", () => {
    expect(quoteIn("location:   REMOTE cet +/-4h", JD)).toBe(true);
    expect(quoteIn("you’ve got this", "You've got this")).toBe(true);
    expect(quoteIn("2–3 years", "2-3 years")).toBe(true);
  });
  it("refuse invented or too short quotes", () => {
    expect(quoteIn("10+ years of Salesforce", JD)).toBe(false);
    expect(quoteIn("", JD)).toBe(false);
    expect(quoteIn("a", JD)).toBe(false);
  });
});

describe("pay band against the floor (scan rule 2026-10-15)", () => {
  const pay = (min: number, max: number, extra: Partial<Parameters<typeof payBand>[0] & object> = {}) =>
    payBand({ min, max, currency: "EUR", period: "year", is_ote: false, ...extra }, 70000, "EUR");
  it("Coverflex EUR 30k to 38k: below the floor", () => expect(pay(30000, 38000).band).toBe("below"));
  it("Checkpoint GTM EUR 50k to 90k: the floor sits inside", () => expect(pay(50000, 90000).band).toBe("inside"));
  it("Gigs EUR 115k to 130k: above", () => expect(pay(115000, 130000).band).toBe("above"));
  it("band bottom exactly at the floor counts as above", () => expect(pay(70000, 80000).band).toBe("above"));
  it("Wingify AE EUR 150k to 180k OTE: base is half, 75k to 90k, above", () => expect(pay(150000, 180000, { is_ote: true }).band).toBe("above"));
  it("monthly pay is turned into yearly", () => expect(pay(5000, 6000, { period: "month" }).band).toBe("inside"));
  it("only an upper end: below when it is under the floor, otherwise inside", () => {
    expect(pay(0, 60000).band).toBe("below");
    expect(pay(0, 90000).band).toBe("inside");
  });
  it("vCluster GBP 75k to 95k: another currency is not compared", () => {
    const r = payBand({ min: 75000, max: 95000, currency: "GBP", period: "year", is_ote: false }, 70000, "EUR");
    expect(r.band).toBe("not_stated");
    expect(r.note).toMatch(/GBP/);
  });
  it("no band, hourly pay or no floor: no points, and the note says why", () => {
    expect(payBand(null, 70000, "EUR").note).toBe("pay not stated, check against EUR 70k");
    expect(payBand({ min: 40, max: 50, currency: "EUR", period: "hour", is_ote: false }, 70000, "EUR").band).toBe("not_stated");
    expect(payBand({ min: 1, max: 2, currency: "EUR", period: "year", is_ote: false }, null, "EUR").note).toMatch(/no salary floor/);
  });
});

describe("team size (scan rule 2026-10-28)", () => {
  const r = { build_small_max: 150, ops_large_min: 300 };
  it("build role under 150 people", () => expect(teamSize("build", 65, r)).toBe("build_small"));
  it("ops titled role over 300 people", () => expect(teamSize("ops_titled", 1100, r)).toBe("ops_large"));
  it("anything else with a known size is neutral; unknown size gets no points", () => {
    expect(teamSize("build", 150, r)).toBe("neutral");
    expect(teamSize("ops_titled", 300, r)).toBe("neutral");
    expect(teamSize("other", 50, r)).toBe("neutral");
    expect(teamSize("build", null, r)).toBe("unknown");
  });
});

describe("checking the model's answer", () => {
  it("Kubermatic: remote EU +1.5, build role, 65 people stated in the ad", () => {
    const c = checkScore(raw({ headcount: { stated: true, value: 65, quote: "we are 65 people" } }), { jobText: JD }, RULES, FLOOR);
    expect(c.location_points).toBe(1.5);
    expect(c.factors).toEqual({ pay_band: "not_stated", team_size: "build_small" });
    expect(c.headcount).toBe(65);
    expect(c.headcount_source).toBe("company_site");
    expect(c.details.dropped).toEqual([]);
  });

  it("deductions with real quotes are kept; ops years needs a quote asking 5 or more", () => {
    const c = checkScore(raw({
      run_and_report: { applies: true, quote: "Take over and further develop our existing reporting" },
      ops_years_gap: { applies: true, years: 5, quote: "5+ years in Revenue Operations" },
      sales_ops: { applies: true, quote: "own territory and quota design" },
    }), { jobText: JD }, RULES, FLOOR);
    expect(c.factors.run_and_report).toBe(true);
    expect(c.factors.ops_years_gap).toBe(true);
    expect(c.factors.sales_ops).toBeUndefined();
    expect(c.details.dropped).toEqual(["sales ops: quote not found in the ad"]);
  });

  it("an ops years label whose quote asks only 3 years is dropped", () => {
    const c = checkScore(raw({ ops_years_gap: { applies: true, years: 5, quote: "Location: Remote CET" } }), { jobText: JD }, RULES, FLOOR);
    expect(c.factors.ops_years_gap).toBeUndefined();
    expect(c.details.dropped[0]).toMatch(/5 or more years/);
  });

  it("vCluster: a location the ad does not back gets +0 and a note", () => {
    const c = checkScore(raw({ location: { rule: 1, reason: "EMEA", quote: "Remote, based in EMEA" } }), { jobText: JD }, RULES, FLOOR);
    expect(c.location_points).toBe(0);
    expect(c.location_note).toMatch(/not confirmed/);
  });

  it("a location rule that does not exist gives +0", () => {
    const c = checkScore(raw({ location: { rule: 42, reason: "?", quote: "Location: Remote CET +/-4h" } }), { jobText: JD }, RULES, FLOOR);
    expect(c.location_points).toBe(0);
  });

  it("the location the user typed counts as part of the ad", () => {
    const c = checkScore(raw({ location: { rule: 0, reason: "Berlin", quote: "Berlin Mitte, on site" } }),
      { jobText: JD, location: "Berlin Mitte, on site" }, RULES, FLOOR);
    expect(c.location_points).toBe(1.5);
  });

  it("pay from the ad needs its quote; pay from a call beats the ad", () => {
    const stated = { stated: true, min: 50000, max: 90000, currency: "EUR", period: "year" as const, is_ote: false, quote: "Salary: EUR 50,000 to 90,000 per year." };
    let c = checkScore(raw({ salary: stated }), { jobText: JD }, RULES, FLOOR);
    expect(c.factors).toMatchObject({ pay_band: "inside", pay_band_source: "posting" });
    c = checkScore(raw({ salary: { ...stated, quote: "EUR 90k" } }), { jobText: JD }, RULES, FLOOR);
    expect(c.factors.pay_band).toBe("not_stated");
    c = checkScore(raw({ salary: stated }), { jobText: JD, callPay: { min: 0, max: 60000 } }, RULES, FLOOR);
    expect(c.factors).toMatchObject({ pay_band: "below", pay_band_source: "call" });
  });

  it("the headcount the user typed beats the ad", () => {
    const c = checkScore(raw({ headcount: { stated: true, value: 65, quote: "we are 65 people" }, role_shape: { value: "ops_titled", quote: "Take over and further develop our existing reporting" } }),
      { jobText: JD, headcount: 1100 }, RULES, FLOOR);
    expect(c.headcount).toBe(1100);
    expect(c.factors.team_size).toBe("ops_large");
  });

  it("role fit is only rounded to half steps and kept inside 0 to 10, never moved toward a bar", () => {
    expect(roundHalf(7.74)).toBe(7.5);
    expect(roundHalf(7.76)).toBe(8);
    expect(roundHalf(12)).toBe(10);
    expect(roundHalf(Number.NaN)).toBe(0);
    for (const fit of [6.5, 7.5, 7.9, 8.4]) {
      expect(checkScore(raw({ role_fit: fit }), { jobText: JD }, RULES, FLOOR).role_fit).toBe(roundHalf(fit));
    }
  });

  it("required languages are kept only with a quote", () => {
    const c = checkScore(raw({ languages_required: [
      { language: "German", quote: "Fluent German is required." },
      { language: "Dutch", quote: "Dutch is a must" },
    ] }), { jobText: JD }, RULES, FLOOR);
    expect(c.details.languages).toEqual(["German"]);
  });
});

describe("the fit line reads like the scan's", () => {
  it("Kubermatic: fit 10 (role 8, remote +1.5, small team +0.5)", () => {
    expect(fitLine({ total_fit: 10, role_fit: 8, location_points: 1.5, location_label: "Remote anywhere in the EU, including Germany", factor_points: { team_size: 0.5 } }))
      .toBe("fit 10 (role 8, Remote anywhere in the EU, including Germany +1.5, small team +0.5)");
  });
  it("over 10 says so: role 9, Berlin +1.5", () => {
    expect(fitLine({ total_fit: 10, role_fit: 9, location_points: 1.5, location_label: "Berlin", factor_points: {} }))
      .toBe("fit 10 (role 9, Berlin +1.5, capped at 10)");
  });
  it("Dandy: fit 6 (role 5.5, Spain remote +1.5, ops years gap and run and report capped at minus 1)", () => {
    expect(fitLine({
      total_fit: 6, role_fit: 5.5, location_points: 1.5, location_label: "Spain, remote",
      factor_points: { run_and_report: -0.5, ops_years_gap: -0.5, team_size: -0.5, deduction_cap: -1 },
    })).toBe("fit 6 (role 5.5, Spain, remote +1.5, run and report minus 0.5, ops years gap minus 0.5, large team, ops title minus 0.5, deductions capped at minus 1)");
  });
  it("Coverflex: pay below floor", () => {
    expect(fitLine({ total_fit: 6.5, role_fit: 6.5, location_points: 1.5, location_label: "Remote anywhere in the EU, including Germany", factor_points: { pay_band: -1.5 }, factors: { pay_band: "below" } }))
      .toBe("fit 6.5 (role 6.5, Remote anywhere in the EU, including Germany +1.5, pay below floor minus 1.5)");
  });
});

describe("settings", () => {
  it("old style location points are read with plain labels; bad rows are dropped", () => {
    expect(locationRules([{ match: "home_city", points: 1.5 }, { label: "Malta", points: 1 }, { label: "", points: 1 }, { label: "Mars", points: 9 }]))
      .toEqual([{ label: "My home city (on site, hybrid or remote)", points: 1.5 }, { label: "Malta", points: 1 }]);
  });
  it("missing anchors fall back to the defaults", () => {
    expect(anchorsFrom({ "9": "My own words" })).toEqual({ ...DEFAULT_ANCHORS, "9": "My own words" });
  });
});

// ---------------------------------------------------------------------------
// The whole run with a fake database and a fake model
// ---------------------------------------------------------------------------
function fakeDb(opts: { experiences?: unknown[]; config?: boolean; targets?: Record<string, unknown> | null } = {}) {
  const calls: { name: string; args: unknown }[] = [];
  let config = opts.config ?? true;
  const cfgRow = {
    location_points: SCAN_LOCATIONS, rubric_anchors: {}, benchmark_role: { text: "Founding GTM Engineering Lead" },
    factor_rules: { team_size: { build_small_max: 150, ops_large_min: 300 } },
  };
  const query = (table: string) => {
    const q = {
      select: () => q, eq: () => q,
      maybeSingle: async () => ({ data: table === "scoring_configs" ? (config ? cfgRow : null) : table === "targets" ? (opts.targets ?? null) : null }),
    };
    return q;
  };
  const db = {
    from: query,
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      if (name === "my_profile_snapshot") {
        return { data: { profile: { full_name: "Ann" }, experiences: opts.experiences ?? [{ title: "GTM Engineer" }], skills: [], stories: [], not_on_record: ["Salesforce admin"], scoring: { cv_threshold: 8 } }, error: null };
      }
      if (name === "set_scoring_config") { config = true; return { data: "cfg", error: null }; }
      if (name === "score_pasted_job") return { data: { match_id: "m1" }, error: null };
      return { data: null, error: { message: "unknown rpc" } };
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe("scoring a pasted job end to end", () => {
  const model = (r = raw()) => {
    const seen: string[] = [];
    return { seen, call: async (msg: string) => { seen.push(msg); return { raw: r, model: "claude-sonnet-5-5", usage: { input_tokens: 9000, output_tokens: 900 } }; } };
  };

  it("saves the checked labels, never the bars, and the model never sees the CV bar", async () => {
    const { db, calls } = fakeDb({ targets: { salary_min: 70000, salary_currency: "EUR", titles: [{ title: "GTM Engineer", priority: 1 }] } });
    const m = model();
    const res = await scoreJob(db, { jobText: JD, url: "https://kubermatic.bamboohr.com/careers/43" }, m.call);
    expect(res).toEqual({ ok: true, matchId: "m1" });
    expect(m.seen[0]).not.toMatch(/cv_threshold/);
    expect(m.seen[0]).toMatch(/Salesforce admin/);
    expect(m.seen[0]).toMatch(/1\. Remote anywhere in the EU/);
    expect(m.seen[0]).toMatch(/Founding GTM Engineering Lead/);
    const save = calls.find((c) => c.name === "score_pasted_job")!.args as { p: { match: Record<string, unknown>; job: Record<string, unknown> } };
    expect(save.p.match.role_fit).toBe(8);
    expect(save.p.match.location_points).toBe(1.5);
    expect(save.p.match.factors).toEqual({ pay_band: "not_stated", team_size: "unknown" });
    expect(save.p.job.url).toBe("https://kubermatic.bamboohr.com/careers/43");
    expect(JSON.stringify(save.p)).not.toMatch(/total_fit|cv_threshold/);
  });

  it("creates the default rules the first time", async () => {
    const { db, calls } = fakeDb({ config: false });
    const res = await scoreJob(db, { jobText: JD }, model().call);
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.name)).toContain("set_scoring_config");
  });

  it("refuses before calling the model when the profile is not confirmed, the text is short or the key is missing", async () => {
    const m = model();
    expect(await scoreJob(fakeDb({ experiences: [] }).db, { jobText: JD }, m.call)).toEqual({ ok: false, error: expect.stringMatching(/Confirm your profile/) });
    expect(await scoreJob(fakeDb().db, { jobText: "short" }, m.call)).toEqual({ ok: false, error: expect.stringMatching(/too short/) });
    expect(await scoreJob(fakeDb().db, { jobText: JD }, null)).toEqual({ ok: false, error: expect.stringMatching(/not switched on/) });
    expect(m.seen).toHaveLength(0);
  });

  it("an empty account gives a clear 'paused' message", async () => {
    const res = await scoreJob(fakeDb().db, { jobText: JD }, async () => {
      throw Object.assign(new Error("Your credit balance is too low"), { status: 400 });
    });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/Scoring is paused/) });
  });
});

describe("the call to the matching model", () => {
  it("goes through the SDK with the score schema", async () => {
    const sent: Record<string, unknown>[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5-5",
        content: [{ type: "text", text: JSON.stringify(raw()) }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const res = await claudeScoreCall("sk-test", "claude-sonnet-5-5", fetchImpl)("msg");
    expect(sent[0].max_tokens).toBe(SCORE_MAX_TOKENS);
    expect(sent[0].system).toBe(JOB_SCORE_SYSTEM);
    expect(res.raw.role_fit).toBe(8);
  });
  it("a cut off answer is a user facing error", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      id: "msg", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "{" }],
      stop_reason: "max_tokens", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(claudeScoreCall("sk", "m", fetchImpl)("x")).rejects.toBeInstanceOf(UserFacingError);
  });
});

describe("fixes from the 10-30 review", () => {
  it("typed amounts: German separators, k and ranges", () => {
    expect(parseAmount("70.000")).toBe(70000);
    expect(parseAmount("70,000")).toBe(70000);
    expect(parseAmount("70 000")).toBe(70000);
    expect(parseAmount("70k")).toBe(70000);
    expect(parseAmount("1.200")).toBe(1200);
    expect(parseAmount("50-100")).toBe(50);
    expect(parseAmount("")).toBe(0);
    expect(parseAmount("about")).toBe(0);
  });

  it("numbers in a quote are read with separators and k", () => {
    expect(numbersIn("EUR 60,000 to 75.000 and 90k")).toEqual([60000, 75000, 90000]);
    expect(numbersIn("we are 65 people")).toEqual([65]);
    expect(numbersIn("25,50 EUR per hour")).toEqual([25.5]);
  });

  it("pay amounts that are not in their quote are dropped", () => {
    const c = checkScore(raw({ salary: { stated: true, min: 90000, max: 100000, currency: "EUR", period: "year", is_ote: false, quote: "Salary: EUR 50,000 to 90,000 per year." } }), { jobText: JD }, RULES, FLOOR);
    expect(c.factors.pay_band).toBe("not_stated");
    expect(c.details.dropped[0]).toMatch(/amounts are not the ones/);
  });

  it("a headcount that is not in its quote is dropped", () => {
    const c = checkScore(raw({ headcount: { stated: true, value: 650, quote: "we are 65 people" } }), { jobText: JD }, RULES, FLOOR);
    expect(c.headcount).toBeNull();
    expect(c.factors.team_size).toBe("unknown");
  });

  it("a role shape without a real quote gives no team size points", () => {
    const c = checkScore(raw({ role_shape: { value: "build", quote: "" } }), { jobText: JD, headcount: 40 }, RULES, FLOOR);
    expect(c.factors.team_size).toBe("neutral");
    expect(c.details.dropped.join(" ")).toMatch(/role shape/);
  });

  it("pay with an unclear period is not compared", () => {
    expect(payBand({ min: 5500, max: 0, currency: "EUR", period: "none", is_ote: false }, 70000, "EUR").band).toBe("not_stated");
  });

  it("'3-5 years' asks for 3, not 5", () => {
    expect(yearsIn("3-5 years in Revenue Operations")).toBe(3);
    expect(yearsIn("3 to 5 years")).toBe(3);
    expect(yearsIn("5+ years")).toBe(5);
    expect(yearsIn("at least 6 years of RevOps")).toBe(6);
  });

  it("a role fit off the 0 to 10 scale is refused, not clamped to 10", () => {
    expect(() => checkScore(raw({ role_fit: 75 }), { jobText: JD }, RULES, FLOOR)).toThrow(/off the 0 to 10 scale/);
  });

  it("saved pay is whole, low to high, and hourly or unclear pay is not stored", () => {
    expect(savedSalary({ min: 80000, max: 60000.4, currency: "eur", period: "year", is_ote: false })).toEqual({ min: 60000, max: 80000, currency: "EUR", period: "year", is_ote: false });
    expect(savedSalary({ min: 25.5, max: 30, currency: "EUR", period: "hour", is_ote: false }).min).toBeNull();
    expect(savedSalary({ min: 5500, max: 0, currency: "EUR", period: "none", is_ote: false }).period).toBeNull();
  });

  it("call pay typed high to low is saved low to high", () => {
    const c = checkScore(raw(), { jobText: JD, callPay: { min: 80000, max: 60000 } }, RULES, FLOOR);
    expect(c.salary).toMatchObject({ min: 60000, max: 80000 });
    expect(c.factors.pay_band).toBe("inside");
  });

  it("very short quotes do not count", () => {
    expect(quoteIn("Sales", "Sales team of 40")).toBe(false);
    expect(quoteIn("sales team", "Sales team of 40")).toBe(true);
  });
});
