// Cold-read review (2026-10-18, after the Gate 1 audit). Each test asserts the behaviour we WANT.
// A failing test is a confirmed finding; a passing one is a cleared suspicion kept as a regression guard.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractCvText } from "@/lib/cv/text";
import { numbersIn, verifyParse } from "@/lib/cv/verify";
import { CV_PARSE_SYSTEM } from "@/lib/cv/prompt";
import type { RawParse } from "@/lib/cv/schema";

const fx = (n: string) => join(__dirname, "fixtures", n);
const raw = JSON.parse(readFileSync(fx("fictional-cv.model-output.json"), "utf8")) as RawParse;
const NOW = new Date("2026-10-18");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
let pdfText = "";

beforeAll(async () => {
  pdfText = await extractCvText(new Uint8Array(readFileSync(fx("fictional-cv.pdf"))), "pdf");
});

// ---------------------------------------------------------------------------
// R1. The prompt lets the model quote "the CV line that holds the title OR the dates". When it quotes the
// title line (valid, in the CV) and the dates sit on the next line, the date window is only that quote.
// ---------------------------------------------------------------------------
describe("R1. dates when header_quote is the title line and the dates are on the next line", () => {
  it("keeps a start date whose year is on the line right after the quoted title line", () => {
    const r = clone(raw);
    // In the fixture PDF: "Revenue Operations Manager, Northwind Analytics" \n "Amsterdam, hybrid | March 2022 to present"
    r.experiences = [{ ...r.experiences[0], header_quote: "Revenue Operations Manager, Northwind Analytics" }];
    r.suggestions = [];
    const out = verifyParse(r, pdfText, [], "m", NOW);
    expect(out.experiences).toHaveLength(1);
    expect(out.experiences[0].quote).toBe("Revenue Operations Manager, Northwind Analytics");
    // BUG: start 2022-03 is dropped as "year not found in the role's line of the CV" although it is on the next line
    expect(out.experiences[0].start_date).toBe("2022-03-01");
    expect(out.report.dropped.map((d) => d.reason).join("\n")).not.toMatch(/year not found/);
  });

  it("the prompt allows exactly that quote (title line without dates)", () => {
    expect(CV_PARSE_SYSTEM).toMatch(/line that holds the title or the dates/);
  });
});

// ---------------------------------------------------------------------------
// R2. A "not on record" name that appears as a skill AND as a suggestion is reported twice
// (duplicate React keys on the "Worth fixing" list, duplicate line for the user)
// ---------------------------------------------------------------------------
describe("R2. conflict report has one line per name", () => {
  it("Looker in the skills section and in a skill suggestion gives one conflict entry", () => {
    const out = verifyParse(raw, pdfText, ["Looker"], "m", NOW);
    const items = out.report.conflicts.map((c) => c.item);
    expect(items).toContain("Looker");
    expect(new Set(items).size).toBe(items.length);
  });
});

// ---------------------------------------------------------------------------
// R3. The same title at the same company twice (two stints) must survive verification as two roles;
// the database side is tested in supabase/tests/review.test.mjs
// ---------------------------------------------------------------------------
describe("R3. two stints with the same title at the same company", () => {
  it("verifyParse keeps both and the title suggestion index points at the second", () => {
    const r = clone(raw);
    const first = r.experiences[1];
    r.experiences = [first, { ...first, header_quote: first.header_quote, results: [first.results[1]] }, r.experiences[2]];
    r.suggestions = [{ kind: "title", name: "Junior Analyst", category: "other", experience_index: 2, ats_title: "Junior Sales Analyst", reason: "r", quote: "Junior Analyst, Delta Retail Group" }];
    const out = verifyParse(r, pdfText, [], "m", NOW);
    expect(out.experiences.map((e) => e.company)).toEqual(["Blue Harbor Software", "Blue Harbor Software", "Delta Retail Group"]);
    expect(out.suggestions[0].payload.experience_index).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// R4. Number words: hyphenated compounds and the words the regex does not know
// ---------------------------------------------------------------------------
describe("R4. numbersIn with compound number words (low)", () => {
  it("'twenty-five' is one number, 25, not 20 and 5", () => {
    expect(numbersIn("twenty-five sellers")).toEqual(["25"]);
  });
  it("'hundred', 'thousand', 'million' are not read (documented limit)", () => {
    // Recorded, not asserted as a bug: 'two million' -> ['2'] which happens to match a metric of '$2M'.
    expect(numbersIn("two million in pipeline")).toEqual(["2"]);
  });
});

// ---------------------------------------------------------------------------
// R5. A result quote that is in the CV but whose metric has a number only in the label
// ---------------------------------------------------------------------------
describe("R5. metric with no number at all is reported like a wrong number", () => {
  it("a metric without digits is removed and reported", () => {
    const r = clone(raw);
    r.experiences = [{ ...r.experiences[0], results: [{ ...r.experiences[0].results[3], metric: "quarterly process" }] }];
    r.suggestions = [];
    const out = verifyParse(r, pdfText, [], "m", NOW);
    expect(out.experiences[0].results[0].metric).toBe("");
    expect(out.report.metrics_removed).toEqual([{ item: expect.any(String), metric: "quarterly process" }]);
  });
});
