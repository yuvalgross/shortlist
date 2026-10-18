// Code checks on what the matching model read from a CV. Nothing reaches the database unless it can be
// traced to the CV text. Every removal is recorded in the report so the user (and the gate review) can see it.
import { normalize } from "./text";
import type { RawParse } from "./schema";

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
  experiences: {
    title: string; company: string; company_desc: string; location: string; work_mode: string;
    employment_type: string; start_date: string; end_date: string; is_current: boolean; quote: string;
    results: { title: string; text: string; metric: string; quote: string }[];
  }[];
  skills: { name: string; category: string; quote: string }[];
  suggestions: { kind: "skill" | "title"; payload: Record<string, unknown>; fingerprint: string; quote: string }[];
};

export type ParseReport = {
  dropped: { item: string; reason: string }[];
  conflicts: { item: string; claim: string }[];
  metrics_removed: { item: string; metric: string }[];
  counts: { experiences: number; results: number; skills: number; suggestions: number };
};

const LIMITS = { experiences: 25, results: 15, skills: 80, suggestions: 8 };
const SENIORITY = /\b(senior|sr|lead|head|director|vp|vice|chief|principal|manager|staff)\b/g;

export function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, ""));
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

export function verifyParse(raw: RawParse, cvText: string, notOnRecord: string[], model: string, now = new Date()): ParsePayload {
  const cv = normalize(cvText);
  const cvDigits = cvText.replace(/\D/g, "");
  const report: ParseReport = { dropped: [], conflicts: [], metrics_removed: [], counts: { experiences: 0, results: 0, skills: 0, suggestions: 0 } };
  const drop = (item: string, reason: string) => report.dropped.push({ item, reason });
  const inCv = (s: string) => {
    const q = normalize(s);
    return q.length >= 2 && cv.includes(q);
  };

  // Profile: keep a field only if it appears in the CV
  const keep = (label: string, value: string, check = inCv) => {
    if (!value.trim()) return "";
    if (check(value)) return value.trim();
    drop(`profile ${label}: ${value}`, "not found in the CV");
    return "";
  };
  const phoneInCv = (p: string) => {
    const d = p.replace(/\D/g, "");
    return d.length >= 6 && cvDigits.includes(d);
  };
  const profile: ParsePayload["profile"] = {
    full_name: keep("name", raw.full_name),
    headline: keep("headline", raw.headline),
    location: keep("location", raw.location),
    phone: keep("phone", raw.phone, phoneInCv),
    email: keep("email", raw.email),
    links: raw.links.filter((l) => {
      const ok = inCv(l.url.replace(/^https?:\/\/(www\.)?/, ""));
      if (!ok) drop(`link: ${l.url}`, "not found in the CV");
      return ok;
    }),
    languages: raw.languages.filter((l) => {
      const ok = inCv(l.language);
      if (!ok) drop(`language: ${l.language}`, "not found in the CV");
      return ok;
    }),
    education: raw.education.filter((e) => {
      const ok = inCv(e.school);
      if (!ok) drop(`education: ${e.school}`, "not found in the CV");
      return ok;
    }),
    certifications: keep("certifications", raw.certifications),
  };

  // Experiences and their results
  const experiences: ParsePayload["experiences"] = [];
  const indexMap = new Map<number, number>(); // model's index -> kept index
  raw.experiences.forEach((e, i) => {
    const label = `${e.title} at ${e.company}`;
    if (experiences.length >= LIMITS.experiences) return drop(label, "too many roles");
    if (!e.title.trim() || !inCv(e.title)) return drop(label, "title not found in the CV");
    if (!e.company.trim() || !inCv(e.company)) return drop(label, "company not found in the CV");

    // The role's own line in the CV. If the model's line is not in the CV it is not shown to the user,
    // and dates are then checked against the text around the job title instead of the whole CV.
    const headerOk = inCv(e.header_quote);
    if (e.header_quote.trim() && !headerOk) drop(`${label} line "${e.header_quote.slice(0, 80)}"`, "not found in the CV");
    const header = headerOk ? normalize(e.header_quote) : aroundTitle(cv, normalize(e.title), normalize(e.company));
    const date = (value: string, which: string) => {
      if (!value || value.trim().toLowerCase() === "present") return "";
      const d = toDate(value, now);
      if (!d) {
        drop(`${label} ${which} date "${value}"`, "not a valid date");
        return "";
      }
      if (!header.includes(d.slice(0, 4))) {
        drop(`${label} ${which} date ${value}`, "year not found in the role's line of the CV");
        return "";
      }
      return d;
    };

    const results: ParsePayload["experiences"][number]["results"] = [];
    for (const r of e.results) {
      if (results.length >= LIMITS.results) {
        drop(`result under ${label}: ${r.quote.slice(0, 80)}`, `too many results for one role (limit ${LIMITS.results})`);
        continue;
      }
      if (!inCv(r.quote)) {
        drop(`result under ${label}: ${r.quote.slice(0, 80)}`, "quote not found in the CV");
        continue;
      }
      let metric = r.metric.trim();
      if (metric) {
        const quoteNumbers = new Set(numbersIn(r.quote));
        const metricNumbers = numbersIn(metric);
        if (metricNumbers.length === 0 || metricNumbers.some((n) => !quoteNumbers.has(n))) {
          report.metrics_removed.push({ item: r.quote.slice(0, 80), metric });
          metric = "";
        }
      }
      const title = (r.label.trim() || r.quote.split(/[:;,.]/)[0]).slice(0, 120);
      results.push({ title, text: r.quote.trim(), metric, quote: r.quote.trim() });
    }

    indexMap.set(i, experiences.length);
    experiences.push({
      title: e.title.trim(),
      company: e.company.trim(),
      company_desc: e.company_desc && inCv(e.company_desc) ? e.company_desc.trim() : "",
      location: e.location && inCv(e.location) ? e.location.trim() : "",
      work_mode: e.work_mode === "unknown" ? "" : e.work_mode,
      employment_type: e.employment_type && inCv(e.employment_type) ? e.employment_type.trim() : "",
      start_date: date(e.start, "start"),
      end_date: date(e.end, "end"),
      is_current: e.end.trim().toLowerCase() === "present",
      quote: headerOk ? e.header_quote.trim() : "",
      results,
    });
  });

  // Skills
  const skills: ParsePayload["skills"] = [];
  const seen = new Set<string>();
  for (const s of raw.skills) {
    const key = normalize(s.name);
    if (!key || seen.has(key)) continue;
    if (skills.length >= LIMITS.skills) {
      drop(`skill: ${s.name}`, `too many skills (limit ${LIMITS.skills})`);
      continue;
    }
    if (!inCv(s.name) || !inCv(s.quote) || !normalize(s.quote).includes(key)) {
      drop(`skill: ${s.name}`, "not found in the CV");
      continue;
    }
    const claim = conflictingClaim(s.name, notOnRecord);
    if (claim) {
      report.conflicts.push({ item: s.name, claim });
      continue;
    }
    seen.add(key);
    skills.push({ name: s.name.trim(), category: s.category, quote: s.quote.trim() });
  }

  // Suggestions
  const suggestions: ParsePayload["suggestions"] = [];
  for (const sg of raw.suggestions) {
    if (suggestions.length >= LIMITS.suggestions) {
      drop(`suggestion: ${sg.kind} ${sg.kind === "skill" ? sg.name : sg.ats_title}`, `too many suggestions (limit ${LIMITS.suggestions})`);
      continue;
    }
    if (!inCv(sg.quote)) {
      drop(`suggestion: ${sg.kind} ${sg.name}`, "quote not found in the CV");
      continue;
    }
    if (sg.kind === "skill") {
      const key = normalize(sg.name);
      if (!key || !normalize(sg.quote).includes(key)) {
        drop(`suggestion: skill ${sg.name}`, "skill not in its quote");
        continue;
      }
      if (seen.has(key)) continue; // already a skill
      const claim = conflictingClaim(sg.name, notOnRecord);
      if (claim) {
        report.conflicts.push({ item: sg.name, claim });
        continue;
      }
      seen.add(key);
      suggestions.push({
        kind: "skill",
        payload: { name: sg.name.trim(), category: sg.category, reason: sg.reason },
        fingerprint: `skill:${key}`,
        quote: sg.quote.trim(),
      });
    } else {
      const idx = indexMap.get(sg.experience_index);
      if (idx === undefined) {
        drop(`suggestion: title ${sg.ats_title}`, "role not found");
        continue;
      }
      const exp = experiences[idx];
      const ats = sg.ats_title.trim();
      if (!ats || normalize(ats) === normalize(exp.title)) continue;
      const before = new Set(normalize(exp.title).match(SENIORITY) ?? []);
      const added = (normalize(ats).match(SENIORITY) ?? []).filter((w) => !before.has(w));
      if (added.length) {
        drop(`suggestion: title ${ats}`, `adds seniority not in the CV (${added.join(", ")})`);
        continue;
      }
      suggestions.push({
        kind: "title",
        payload: { experience_index: idx, original_title: exp.title, ats_title: ats, reason: sg.reason },
        fingerprint: `title:${normalize(exp.company)}:${normalize(exp.title)}:${normalize(ats)}`,
        quote: sg.quote.trim(),
      });
    }
  }

  report.counts = {
    experiences: experiences.length,
    results: experiences.reduce((n, e) => n + e.results.length, 0),
    skills: skills.length,
    suggestions: suggestions.length,
  };
  return { model, report, profile, experiences, skills, suggestions };
}
