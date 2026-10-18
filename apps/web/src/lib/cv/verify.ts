// Code checks on what the matching model read from a CV. Nothing reaches the database unless it can be
// traced to the CV text. Every removal is recorded in the report so the user (and the gate review) can see it.
import { normalize } from "./text";
import type { RawExperience, RawParse, RawSkill, RawSuggestion } from "./schema";

export type ParsePayload = {
  model: string;
  report: ParseReport;
  profile: {
    full_name: string; headline: string; location: string; phone: string; email: string;
    links: { label: string; url: string }[];
    languages: { language: string; level: string }[];
    education: { school: string; degree: string; year: string }[];
    certifications: string;
  };
  experiences: Experience[];
  skills: { name: string; category: string; quote: string }[];
  suggestions: { kind: "skill" | "title"; payload: Record<string, unknown>; fingerprint: string; quote: string }[];
};

type Experience = {
  title: string; company: string; company_desc: string; location: string; work_mode: string;
  employment_type: string; start_date: string; end_date: string; is_current: boolean; quote: string;
  results: { title: string; text: string; metric: string; quote: string }[];
};

export type ParseReport = {
  dropped: { item: string; reason: string }[];
  conflicts: { item: string; claim: string }[];
  metrics_removed: { item: string; metric: string }[];
  counts: { experiences: number; results: number; skills: number; suggestions: number };
};

// The same limits are enforced in the database function apply_cv_parse.
const LIMITS = { experiences: 25, results: 15, skills: 80, suggestions: 8 };
const SENIORITY = /\b(senior|sr|lead|head|director|vp|vice|chief|principal|manager|staff)\b/g;
const NOT_IN_CV = "not found in the CV";

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests)
// ---------------------------------------------------------------------------

// Numbers written as words count too, so "in three weeks" backs a metric of "3 weeks" or "three weeks".
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUMBER_WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "gi");

export function numbersIn(text: string): string[] {
  const digits = text.replace(NUMBER_WORD_RE, (w) => String(NUMBER_WORDS[w.toLowerCase()]));
  return (digits.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, ""));
}

function claimParts(claim: string): string[] {
  return normalize(claim)
    .split(/\s*(?:,|\/|\bor\b|\band\b)\s*/)
    .map((p) => p.replace(/^(a|an|the)\s+/, "").trim())
    .filter((p) => p.length >= 2);
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A skill conflicts with a "not on record" claim when it equals one part of the claim,
// or contains that part as a whole word ("ZoomInfo SalesOS" vs "ZoomInfo"). The reverse is not a conflict:
// "scoring" does not clash with "health scoring".
export function conflictingClaim(name: string, claims: string[]): string | null {
  const n = normalize(name);
  for (const claim of claims) {
    for (const part of claimParts(claim)) {
      if (part === n) return claim;
      if (part.length >= 3 && new RegExp(`(^|[^a-z0-9])${escapeRe(part)}([^a-z0-9]|$)`).test(n)) return claim;
    }
  }
  return null;
}

// The stretch of CV text around a role's title (and company, when it sits close by): where its dates should be.
export function aroundTitle(cv: string, title: string, company: string, span = 160): string {
  let at = -1;
  if (title) {
    let from = 0;
    while ((at = cv.indexOf(title, from)) !== -1) {
      if (!company || cv.slice(Math.max(0, at - span), at + title.length + span).includes(company)) break;
      from = at + 1;
    }
  }
  if (at === -1 && company) at = cv.indexOf(company);
  if (at === -1) return "";
  return cv.slice(Math.max(0, at - span), at + title.length + span);
}

export function toDate(value: string, now = new Date()): string | null {
  const v = value.trim();
  const m = /^(\d{4})(?:-(\d{1,2}))?$/.exec(v);
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : 1;
  if (year < 1950 || year > now.getFullYear() + 1 || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

const isPresent = (value: string) => value.trim().toLowerCase() === "present";
const short = (s: string) => s.slice(0, 80);

// ---------------------------------------------------------------------------
// The check context: the normalized CV, the report, and the two questions every rule asks
// ---------------------------------------------------------------------------

class Checks {
  readonly cv: string;
  readonly report: ParseReport = { dropped: [], conflicts: [], metrics_removed: [], counts: { experiences: 0, results: 0, skills: 0, suggestions: 0 } };
  private readonly cvDigits: string;

  constructor(cvText: string, readonly notOnRecord: string[], readonly now: Date) {
    this.cv = normalize(cvText);
    this.cvDigits = cvText.replace(/\D/g, "");
  }

  drop(item: string, reason: string) {
    this.report.dropped.push({ item, reason });
  }

  inCv(s: string): boolean {
    const q = normalize(s);
    return q.length >= 2 && this.cv.includes(q);
  }

  phoneInCv(p: string): boolean {
    const d = p.replace(/\D/g, "");
    return d.length >= 6 && this.cvDigits.includes(d);
  }

  // A text field is kept only if it appears in the CV.
  keep(label: string, value: string, check: (s: string) => boolean = (s) => this.inCv(s)): string {
    if (!value.trim()) return "";
    if (check(value)) return value.trim();
    this.drop(`profile ${label}: ${value}`, NOT_IN_CV);
    return "";
  }

  // A list is kept item by item, judged on one field.
  keepList<T>(label: string, items: T[], field: (item: T) => string): T[] {
    return items.filter((item) => {
      const ok = this.inCv(field(item));
      if (!ok) this.drop(`${label}: ${field(item)}`, NOT_IN_CV);
      return ok;
    });
  }

  // Not on the user's record: the skill is left out and the conflict is reported.
  conflicts(name: string): boolean {
    const claim = conflictingClaim(name, this.notOnRecord);
    if (claim) this.report.conflicts.push({ item: name, claim });
    return Boolean(claim);
  }
}

// ---------------------------------------------------------------------------
// One function per section of the CV
// ---------------------------------------------------------------------------

function checkProfile(raw: RawParse, c: Checks): ParsePayload["profile"] {
  return {
    full_name: c.keep("name", raw.full_name),
    headline: c.keep("headline", raw.headline),
    location: c.keep("location", raw.location),
    phone: c.keep("phone", raw.phone, (p) => c.phoneInCv(p)),
    email: c.keep("email", raw.email),
    links: c.keepList("link", raw.links, (l) => l.url.replace(/^https?:\/\/(www\.)?/, "")),
    languages: c.keepList("language", raw.languages, (l) => l.language),
    education: c.keepList("education", raw.education, (e) => e.school),
    certifications: c.keep("certifications", raw.certifications),
  };
}

// Returns null when the role itself cannot be traced to the CV.
function checkExperience(e: RawExperience, c: Checks): Experience | null {
  const label = `${e.title} at ${e.company}`;
  if (!e.title.trim() || !c.inCv(e.title)) {
    c.drop(label, `title ${NOT_IN_CV}`);
    return null;
  }
  if (!e.company.trim() || !c.inCv(e.company)) {
    c.drop(label, `company ${NOT_IN_CV}`);
    return null;
  }

  // The role's own line in the CV. If the model's line is not in the CV it is not shown to the user,
  // and dates are then checked against the text around the job title instead of the whole CV.
  const headerOk = c.inCv(e.header_quote);
  if (e.header_quote.trim() && !headerOk) c.drop(`${label} line "${short(e.header_quote)}"`, NOT_IN_CV);
  const header = headerOk ? normalize(e.header_quote) : aroundTitle(c.cv, normalize(e.title), normalize(e.company));

  const date = (value: string, which: string): string => {
    if (!value || isPresent(value)) return "";
    const d = toDate(value, c.now);
    if (!d) {
      c.drop(`${label} ${which} date "${value}"`, "not a valid date");
      return "";
    }
    if (!header.includes(d.slice(0, 4))) {
      c.drop(`${label} ${which} date ${value}`, "year not found in the role's line of the CV");
      return "";
    }
    return d;
  };

  const results: Experience["results"] = [];
  for (const r of e.results) {
    const item = `result under ${label}: ${short(r.quote)}`;
    if (results.length >= LIMITS.results) {
      c.drop(item, `too many results for one role (limit ${LIMITS.results})`);
      continue;
    }
    if (!c.inCv(r.quote)) {
      c.drop(item, `quote ${NOT_IN_CV}`);
      continue;
    }
    // A number in the metric must be in the quote, otherwise the result is kept without its number.
    let metric = r.metric.trim();
    if (metric) {
      const quoteNumbers = new Set(numbersIn(r.quote));
      const metricNumbers = numbersIn(metric);
      if (metricNumbers.length === 0 || metricNumbers.some((n) => !quoteNumbers.has(n))) {
        c.report.metrics_removed.push({ item: short(r.quote), metric });
        metric = "";
      }
    }
    const title = (r.label.trim() || r.quote.split(/[:;,.]/)[0]).slice(0, 120);
    results.push({ title, text: r.quote.trim(), metric, quote: r.quote.trim() });
  }

  const optional = (value: string) => (value && c.inCv(value) ? value.trim() : "");
  return {
    title: e.title.trim(),
    company: e.company.trim(),
    company_desc: optional(e.company_desc),
    location: optional(e.location),
    work_mode: e.work_mode === "unknown" ? "" : e.work_mode,
    employment_type: optional(e.employment_type),
    start_date: date(e.start, "start"),
    end_date: date(e.end, "end"),
    is_current: isPresent(e.end),
    quote: headerOk ? e.header_quote.trim() : "",
    results,
  };
}

function checkSkills(rawSkills: RawSkill[], c: Checks, seen: Set<string>): ParsePayload["skills"] {
  const skills: ParsePayload["skills"] = [];
  for (const s of rawSkills) {
    const key = normalize(s.name);
    if (!key || seen.has(key)) continue;
    if (skills.length >= LIMITS.skills) {
      c.drop(`skill: ${s.name}`, `too many skills (limit ${LIMITS.skills})`);
      continue;
    }
    if (!c.inCv(s.name) || !c.inCv(s.quote) || !normalize(s.quote).includes(key)) {
      c.drop(`skill: ${s.name}`, NOT_IN_CV);
      continue;
    }
    if (c.conflicts(s.name)) continue;
    seen.add(key);
    skills.push({ name: s.name.trim(), category: s.category, quote: s.quote.trim() });
  }
  return skills;
}

function checkSuggestions(
  rawSuggestions: RawSuggestion[], c: Checks, seen: Set<string>, experiences: Experience[], indexMap: Map<number, number>,
): ParsePayload["suggestions"] {
  const suggestions: ParsePayload["suggestions"] = [];
  for (const sg of rawSuggestions) {
    const what = sg.kind === "skill" ? sg.name : sg.ats_title;
    if (suggestions.length >= LIMITS.suggestions) {
      c.drop(`suggestion: ${sg.kind} ${what}`, `too many suggestions (limit ${LIMITS.suggestions})`);
      continue;
    }
    if (!c.inCv(sg.quote)) {
      c.drop(`suggestion: ${sg.kind} ${what}`, `quote ${NOT_IN_CV}`);
      continue;
    }

    if (sg.kind === "skill") {
      const key = normalize(sg.name);
      if (!key || !normalize(sg.quote).includes(key)) {
        c.drop(`suggestion: skill ${sg.name}`, "skill not in its quote");
        continue;
      }
      if (seen.has(key)) continue; // already a skill
      if (c.conflicts(sg.name)) continue;
      seen.add(key);
      suggestions.push({
        kind: "skill",
        payload: { name: sg.name.trim(), category: sg.category, reason: sg.reason },
        fingerprint: `skill:${key}`,
        quote: sg.quote.trim(),
      });
      continue;
    }

    // ATS title: must point at a kept role and must not add seniority the CV does not have
    const idx = indexMap.get(sg.experience_index);
    if (idx === undefined) {
      c.drop(`suggestion: title ${sg.ats_title}`, "role not found");
      continue;
    }
    const exp = experiences[idx];
    const ats = sg.ats_title.trim();
    if (!ats || normalize(ats) === normalize(exp.title)) continue;
    const before = new Set(normalize(exp.title).match(SENIORITY) ?? []);
    const added = (normalize(ats).match(SENIORITY) ?? []).filter((w) => !before.has(w));
    if (added.length) {
      c.drop(`suggestion: title ${ats}`, `adds seniority not in the CV (${added.join(", ")})`);
      continue;
    }
    suggestions.push({
      kind: "title",
      payload: { experience_index: idx, original_title: exp.title, ats_title: ats, reason: sg.reason },
      fingerprint: `title:${normalize(exp.company)}:${normalize(exp.title)}:${normalize(ats)}`,
      quote: sg.quote.trim(),
    });
  }
  return suggestions;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function verifyParse(raw: RawParse, cvText: string, notOnRecord: string[], model: string, now = new Date()): ParsePayload {
  const c = new Checks(cvText, notOnRecord, now);

  const profile = checkProfile(raw, c);

  const experiences: Experience[] = [];
  const indexMap = new Map<number, number>(); // model's index -> kept index
  raw.experiences.forEach((e, i) => {
    if (experiences.length >= LIMITS.experiences) return c.drop(`${e.title} at ${e.company}`, "too many roles");
    const kept = checkExperience(e, c);
    if (!kept) return;
    indexMap.set(i, experiences.length);
    experiences.push(kept);
  });

  const seen = new Set<string>(); // normalized skill names, shared with suggestions so nothing is proposed twice
  const skills = checkSkills(raw.skills, c, seen);
  const suggestions = checkSuggestions(raw.suggestions, c, seen, experiences, indexMap);

  c.report.counts = {
    experiences: experiences.length,
    results: experiences.reduce((n, e) => n + e.results.length, 0),
    skills: skills.length,
    suggestions: suggestions.length,
  };
  return { model, report: c.report, profile, experiences, skills, suggestions };
}
