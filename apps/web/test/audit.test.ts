// Audit tests: each `describe` targets one suspected bug. A failing test here is a confirmed bug;
// a passing test is a cleared suspicion (kept as a regression guard).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanText, extractCvText, kindFor, normalize } from "@/lib/cv/text";
import { conflictingClaim, numbersIn, toDate, verifyParse, type ParsePayload } from "@/lib/cv/verify";
import { runParse } from "@/lib/cv/run";
import type { ModelCall } from "@/lib/cv/model";
import type { RawExperience, RawParse } from "@/lib/cv/schema";

const fx = (n: string) => join(__dirname, "fixtures", n);
const raw = JSON.parse(readFileSync(fx("fictional-cv.model-output.json"), "utf8")) as RawParse;
const NOW = new Date("2026-10-18");
let pdfText = "";

beforeAll(async () => {
  pdfText = await extractCvText(new Uint8Array(readFileSync(fx("fictional-cv.pdf"))), "pdf");
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const keysOf = (o: object) => Object.keys(o).sort();

// ---------------------------------------------------------------------------
// 1. Shape: what verifyParse sends must be exactly what apply_cv_parse (SQL) reads
// ---------------------------------------------------------------------------
describe("1. payload shape matches apply_cv_parse", () => {
  let out: ParsePayload;
  beforeAll(() => {
    out = verifyParse(raw, pdfText, [], "test-model", NOW);
  });

  it("top level keys", () => {
    expect(keysOf(out)).toEqual(["experiences", "model", "profile", "report", "skills", "suggestions"]);
    expect(typeof out.model).toBe("string");
  });

  it("profile keys the SQL reads (full_name, headline, location, phone, email, links, languages, education, certifications)", () => {
    expect(keysOf(out.profile)).toEqual(
      ["certifications", "education", "email", "full_name", "headline", "languages", "links", "location", "phone"],
    );
    for (const l of out.profile.links) expect(keysOf(l)).toEqual(["label", "url"]);
    for (const l of out.profile.languages) expect(keysOf(l)).toEqual(["language", "level"]);
    for (const e of out.profile.education) expect(keysOf(e)).toEqual(["degree", "school", "year"]);
  });

  it("experience keys: start_date/end_date/is_current/quote, not start/end/header_quote", () => {
    expect(out.experiences.length).toBeGreaterThan(0);
    for (const e of out.experiences) {
      expect(keysOf(e)).toEqual([
        "company", "company_desc", "employment_type", "end_date", "is_current", "location",
        "quote", "results", "start_date", "title", "work_mode",
      ]);
      expect(typeof e.is_current).toBe("boolean");
      // SQL does nullif(..., '')::date, so a date is either '' or YYYY-MM-DD
      expect(e.start_date).toMatch(/^$|^\d{4}-\d{2}-01$/);
      expect(e.end_date).toMatch(/^$|^\d{4}-\d{2}-01$/);
      for (const r of e.results) {
        expect(keysOf(r)).toEqual(["metric", "quote", "text", "title"]);
        expect(r.title.length).toBeLessThanOrEqual(120);
      }
    }
  });

  it("skill keys: name, category, quote", () => {
    for (const s of out.skills) expect(keysOf(s)).toEqual(["category", "name", "quote"]);
  });

  it("suggestion keys: kind, payload, fingerprint (non empty), quote; title payload carries experience_index", () => {
    expect(out.suggestions.length).toBe(2);
    for (const s of out.suggestions) {
      expect(keysOf(s)).toEqual(["fingerprint", "kind", "payload", "quote"]);
      expect(s.fingerprint.length).toBeGreaterThan(0);
      expect(["skill", "title"]).toContain(s.kind);
      if (s.kind === "title") {
        expect(keysOf(s.payload)).toEqual(["ats_title", "experience_index", "original_title", "reason"]);
        expect(typeof s.payload.experience_index).toBe("number");
        // the index must point into the kept experiences list (what the SQL indexes exp_ids by)
        expect(s.payload.experience_index).toBeLessThan(out.experiences.length);
      } else {
        expect(keysOf(s.payload)).toEqual(["category", "name", "reason"]);
        expect(s.payload).not.toHaveProperty("experience_index");
      }
    }
  });

  it("report keys", () => {
    expect(keysOf(out.report)).toEqual(["conflicts", "counts", "dropped", "metrics_removed"]);
  });
});

// ---------------------------------------------------------------------------
// 5a. The experience's own source quote (header_quote) is saved without being checked against the CV
// ---------------------------------------------------------------------------
describe("5a. experience header_quote is verified before being saved as source_quote", () => {
  it("drops or blanks a header_quote that is not in the CV", () => {
    const r = clone(raw);
    r.experiences = [{ ...r.experiences[0], header_quote: "Chief Revenue Officer, Northwind Analytics, 2010 to present" }];
    r.suggestions = [];
    const out = verifyParse(r, pdfText, [], "m", NOW);
    expect(out.experiences).toHaveLength(1);
    // BUG: the fabricated line is stored and shown to the user as "From your CV: ..."
    expect(out.experiences[0].quote).toBe("");
  });

  it("when header_quote is not in the CV, a date is accepted if its year appears anywhere in the CV", () => {
    const r = clone(raw);
    // 2018 is the education year in the CV, not a date of this role
    r.experiences = [{ ...r.experiences[0], header_quote: "not in the cv at all", start: "2018-05", end: "present" }];
    r.suggestions = [];
    const out = verifyParse(r, pdfText, [], "m", NOW);
    // BUG: falls back to the whole CV as the "header line", so an invented 2018 start passes
    expect(out.experiences[0].start_date).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 5b. "Present" with a capital letter
// ---------------------------------------------------------------------------
describe("5b. 'Present' spelled with a capital", () => {
  it("is treated as a current role without a spurious 'not a valid date' report line", () => {
    const r = clone(raw);
    r.experiences = [{ ...r.experiences[0], end: "Present" }];
    r.suggestions = [];
    const out = verifyParse(r, pdfText, [], "m", NOW);
    expect(out.experiences[0].is_current).toBe(true);
    expect(out.experiences[0].end_date).toBe("");
    // BUG: the user sees `end date "Present" (not a valid date)` under "What we left out"
    expect(out.report.dropped.map((d) => d.item).join("\n")).not.toMatch(/end date "Present"/);
  });
});

// ---------------------------------------------------------------------------
// 5c. numbersIn edge cases
// ---------------------------------------------------------------------------
describe("5c. numbersIn", () => {
  it("handles the common CV number formats", () => {
    expect(numbersIn("€921k annual quota")).toEqual(["921"]);
    expect(numbersIn("2.4x pipeline")).toEqual(["2.4"]);
    expect(numbersIn("40% vs 12%")).toEqual(["40", "12"]);
    expect(numbersIn("from 17 to 5 days")).toEqual(["17", "5"]);
    expect(numbersIn("$2M ARR")).toEqual(["2"]);
    expect(numbersIn("$1.1M")).toEqual(["1.1"]);
    expect(numbersIn("1,200 accounts")).toEqual(["1200"]);
    expect(numbersIn("grew 20.")).toEqual(["20"]);
    expect(numbersIn("Q3, 2024")).toEqual(["3", "2024"]);
  });
  it("European thousands separator: '1.200' in the bullet vs '1,200' in the metric are different numbers (low)", () => {
    // Documented behaviour, not asserted as a bug: the model is told to copy numbers as written.
    expect(numbersIn("1.200 accounts")).toEqual(["1.200"]);
  });
});

// ---------------------------------------------------------------------------
// 5d. toDate
// ---------------------------------------------------------------------------
describe("5d. toDate", () => {
  it("accepts YYYY, YYYY-MM, YYYY-M; rejects present and far future", () => {
    expect(toDate("2024", NOW)).toBe("2024-01-01");
    expect(toDate("2024-7", NOW)).toBe("2024-07-01");
    expect(toDate("2027", NOW)).toBe("2027-01-01");
    expect(toDate("2028", NOW)).toBeNull();
    expect(toDate("present", NOW)).toBeNull();
    expect(toDate("2024-00", NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5e. not on record matching
// ---------------------------------------------------------------------------
describe("5e. conflictingClaim", () => {
  it("is case insensitive and matches whole words", () => {
    expect(conflictingClaim("zoominfo", ["ZoomInfo"])).toBe("ZoomInfo");
    expect(conflictingClaim("Clay Enrichment", ["Clay"])).toBe("Clay");
    expect(conflictingClaim("Clayton", ["Clay"])).toBeNull();
  });
  it("splitting a claim on 'and' turns 'Research and Development' into two blocking words (design limit, low)", () => {
    // 'Market Research' is blocked by the claim 'Research and Development'. Recorded, not asserted as a bug.
    expect(conflictingClaim("Market Research", ["Research and Development"])).toBe("Research and Development");
  });
});

// ---------------------------------------------------------------------------
// 5f. Seniority block is case insensitive and does not block a title that only drops words
// ---------------------------------------------------------------------------
describe("5f. seniority words in title suggestions", () => {
  const withTitle = (original: string, ats: string) => {
    const r = clone(raw);
    r.experiences = [r.experiences[0]];
    r.experiences[0].title = original;
    r.suggestions = [{ kind: "title", name: original, category: "other", experience_index: 0, ats_title: ats, reason: "r", quote: r.experiences[0].header_quote }];
    return verifyParse(r, pdfText, [], "m", NOW);
  };
  it("blocks SENIOR in capitals", () => {
    const out = withTitle("Revenue Operations Manager", "SENIOR Revenue Operations Manager");
    expect(out.suggestions).toHaveLength(0);
    expect(out.report.dropped.at(-1)?.reason).toMatch(/adds seniority/);
  });
});

// ---------------------------------------------------------------------------
// 6. text normalisation: the same function is applied to both sides
// ---------------------------------------------------------------------------
describe("6. text normalisation", () => {
  it("cleanText keeps € and bullets, drops soft hyphens and zero width chars", () => {
    expect(cleanText("€921k­quota​")).toBe("€921kquota");
    expect(cleanText("• item")).toBe("• item");
  });
  it("normalize makes NBSP, curly quotes, dashes and bullets irrelevant for matching", () => {
    expect(normalize("• Cut forecast error from 18% to 7% – ‘fast’")).toBe("cut forecast error from 18% to 7% - 'fast'");
  });
  it("ligatures are not folded: a model quote written with 'fi' does not match CV text with 'ﬁ' (low)", () => {
    expect(normalize("ﬁnance")).not.toBe(normalize("finance"));
  });
  it("kindFor: uppercase extension and mismatched mime", () => {
    expect(kindFor("", "CV.PDF")).toBe("pdf");
    expect(kindFor("application/octet-stream", "cv.docx")).toBe("docx");
    expect(kindFor("application/msword", "cv.doc")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. run.ts failure paths
// ---------------------------------------------------------------------------
function fakeDb(file: Uint8Array | null, opts: { updateError?: { message: string } | null; rpcError?: { message: string } | null; mime?: string; name?: string } = {}) {
  const updates: Record<string, unknown>[] = [];
  const chain = (table: string) => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: { id: "u1", storage_path: "user/cv", file_name: opts.name ?? "cv.pdf", mime_type: opts.mime ?? "application/pdf" },
          error: null,
        }),
      }),
      then: (res: (v: unknown) => void) => res({ data: [], error: null }),
    }),
    update: (row: Record<string, unknown>) => {
      updates.push({ table, ...row });
      return { eq: async () => ({ error: opts.updateError ?? null }) };
    },
  });
  const db = {
    from: chain,
    storage: {
      from: () => ({
        download: async () => (file ? { data: new Blob([file as BlobPart]), error: null } : { data: null, error: { message: "Object not found" } }),
      }),
    },
    rpc: async () => ({ error: opts.rpcError ?? null }),
  } as unknown as SupabaseClient;
  return { db, updates };
}
const fakeModel: ModelCall = async () => ({ raw, model: "fake", usage: { input_tokens: 1, output_tokens: 1 } });

describe("4. runParse always leaves a terminal status", () => {
  it("missing storage object -> failed with a user message", async () => {
    const { db, updates } = fakeDb(null);
    await runParse(db, "u1", fakeModel);
    expect(updates.at(-1)).toMatchObject({ parse_status: "failed", error: expect.stringContaining("could not open") });
  });

  it("a renamed file (docx bytes with a .pdf name) -> failed, not stuck", async () => {
    const { db, updates } = fakeDb(new Uint8Array(readFileSync(fx("fictional-cv.docx"))), { mime: "application/pdf", name: "cv.pdf" });
    const log = console.error;
    console.error = () => {};
    await runParse(db, "u1", fakeModel);
    console.error = log;
    expect(updates.at(-1)?.parse_status).toBe("failed");
  });

  it("apply_cv_parse error -> failed", async () => {
    const { db, updates } = fakeDb(new Uint8Array(readFileSync(fx("fictional-cv.pdf"))), { rpcError: { message: "boom" } });
    const log = console.error;
    console.error = () => {};
    await runParse(db, "u1", fakeModel);
    console.error = log;
    expect(updates.at(-1)?.parse_status).toBe("failed");
  });

  it("when the final 'failed' update itself fails (e.g. expired token) something is logged", async () => {
    const { db } = fakeDb(new Uint8Array(readFileSync(fx("fictional-cv.pdf"))), {
      rpcError: { message: "JWT expired" },
      updateError: { message: "JWT expired" },
    });
    const logged: unknown[][] = [];
    const log = console.error;
    console.error = (...a: unknown[]) => void logged.push(a);
    await runParse(db, "u1", fakeModel);
    console.error = log;
    // BUG: the failure to mark the row failed is swallowed; the upload stays 'parsing' with no trace
    expect(logged.some((l) => l.join(" ").includes("JWT expired") && l.join(" ").toLowerCase().includes("status"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5g. Results limit truncates silently
// ---------------------------------------------------------------------------
describe("5g. limits are reported", () => {
  it("results over the 15 per role limit appear in the report", () => {
    const r = clone(raw);
    const base = r.experiences[0] as RawExperience;
    const bullet = base.results[0];
    base.results = Array.from({ length: 20 }, () => ({ ...bullet }));
    r.experiences = [base];
    r.suggestions = [];
    const out = verifyParse(r, pdfText, [], "m", NOW);
    expect(out.experiences[0].results).toHaveLength(15);
    // BUG: 5 bullets vanish with no line in "What we left out"
    expect(out.report.dropped.some((d) => /too many/.test(d.reason))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stuck uploads are recognised server-side
// ---------------------------------------------------------------------------
import { parseLooksStuck, STUCK_AFTER_MS } from "@/lib/cv/status";
describe("stuck parse detection", () => {
  const t0 = Date.parse("2026-10-18T10:00:00Z");
  const base = { parse_status: "parsing", parse_started_at: "2026-10-18T10:00:00Z", created_at: "2026-10-18T09:59:00Z" };
  it("a fresh parse is not stuck", () => expect(parseLooksStuck(base, t0 + 60_000)).toBe(false));
  it("a parse older than the limit is stuck", () => expect(parseLooksStuck(base, t0 + STUCK_AFTER_MS + 1)).toBe(true));
  it("only the parsing state can be stuck", () => expect(parseLooksStuck({ ...base, parse_status: "parsed" }, t0 + 1e9)).toBe(false));
  it("falls back to created_at when no start time was recorded", () =>
    expect(parseLooksStuck({ ...base, parse_started_at: null }, t0 + STUCK_AFTER_MS + 61_000)).toBe(true));
});
