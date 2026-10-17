import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { extractCvText, normalize, kindFor } from "@/lib/cv/text";
import { conflictingClaim, numbersIn, toDate, verifyParse, type ParsePayload } from "@/lib/cv/verify";
import type { RawParse } from "@/lib/cv/schema";

const fx = (name: string) => join(__dirname, "fixtures", name);
const raw = JSON.parse(readFileSync(fx("fictional-cv.model-output.json"), "utf8")) as RawParse;
let pdfText = "";
let docxText = "";

beforeAll(async () => {
  pdfText = await extractCvText(new Uint8Array(readFileSync(fx("fictional-cv.pdf"))), "pdf");
  docxText = await extractCvText(new Uint8Array(readFileSync(fx("fictional-cv.docx"))), "docx");
});

describe("reading files", () => {
  it("gets the full text out of a PDF and a Word file", () => {
    for (const text of [pdfText, docxText]) {
      expect(text).toContain("Mara Lindqvist");
      expect(normalize(text)).toContain(normalize("cut forecast error from 18% to 7% in two quarters"));
      expect(text).toContain("commission planning");
    }
  });
  it("accepts PDF and Word only", () => {
    expect(kindFor("application/pdf", "a.pdf")).toBe("pdf");
    expect(kindFor("", "cv.DOCX")).toBe("docx");
    expect(kindFor("image/png", "scan.png")).toBeNull();
  });
});

describe("small helpers", () => {
  it("reads numbers the way CVs write them", () => {
    expect(numbersIn("€1.1M upsell, 2.4x, 1,200 accounts, 42%")).toEqual(["1.1", "2.4", "1200", "42"]);
  });
  it("turns model dates into real dates and rejects nonsense", () => {
    expect(toDate("2024-11")).toBe("2024-11-01");
    expect(toDate("2019")).toBe("2019-01-01");
    expect(toDate("Nov 2024")).toBeNull();
    expect(toDate("2024-13")).toBeNull();
    expect(toDate("1890")).toBeNull();
  });
  it("matches not on record claims without false alarms", () => {
    const claims = ["SQL or a data warehouse", "churn or health scoring", "ZoomInfo", "a built from scratch CRM data model"];
    expect(conflictingClaim("SQL", claims)).toBe("SQL or a data warehouse");
    expect(conflictingClaim("data warehouse", claims)).toBe("SQL or a data warehouse");
    expect(conflictingClaim("ZoomInfo SalesOS", claims)).toBe("ZoomInfo");
    expect(conflictingClaim("health scoring", claims)).toBe("churn or health scoring");
    expect(conflictingClaim("lead scoring", claims)).toBeNull();
    expect(conflictingClaim("scoring", claims)).toBeNull();
    expect(conflictingClaim("HubSpot", claims)).toBeNull();
  });
});

describe("checking what the model read (fictional CV with planted mistakes)", () => {
  let out: ParsePayload;
  const reasons = () => out.report.dropped.map((d) => `${d.item} => ${d.reason}`).join("\n");

  beforeAll(() => {
    out = verifyParse(raw, pdfText, [], "test-model", new Date("2026-10-18"));
  });

  it("keeps the real roles and drops the invented one", () => {
    expect(out.experiences.map((e) => e.company)).toEqual(["Northwind Analytics", "Blue Harbor Software", "Delta Retail Group"]);
    expect(reasons()).toMatch(/Head of Revenue Operations at Acme Cloud => title not found/);
  });

  it("drops a bullet the CV does not contain", () => {
    const quotes = out.experiences[0].results.map((r) => r.quote);
    expect(quotes).toHaveLength(4);
    expect(quotes.join(" ")).not.toContain("five analysts");
  });

  it("removes a metric whose number is not in the bullet, keeps the bullet", () => {
    const reporting = out.experiences[0].results.find((r) => r.title === "Reporting")!;
    expect(reporting.metric).toBe("");
    expect(reporting.text).toContain("14 manual spreadsheets");
    expect(out.report.metrics_removed.map((m) => m.metric)).toEqual(["replaced 20 spreadsheets"]);
    expect(out.experiences[0].results[0].metric).toBe("forecast error cut from 18% to 7%");
  });

  it("keeps correct dates, marks current roles, leaves missing dates empty", () => {
    expect(out.experiences[0]).toMatchObject({ start_date: "2022-03-01", end_date: "", is_current: true });
    expect(out.experiences[2]).toMatchObject({ start_date: "", end_date: "", is_current: false });
  });

  it("drops a date whose year is not on the role's line (2021 vs the CV's 2022)", () => {
    expect(out.experiences[1].start_date).toBe("2019-01-01");
    expect(out.experiences[1].end_date).toBe("");
    expect(reasons()).toMatch(/end date 2021-02 => year not found/);
  });

  it("drops an invented skill and an invented link", () => {
    expect(out.skills.map((s) => s.name)).not.toContain("Tableau");
    expect(out.skills).toHaveLength(7);
    expect(out.profile.links.map((l) => l.url)).toEqual(["linkedin.com/in/mara-lindqvist-example"]);
  });

  it("keeps a real skill suggestion, skips duplicates, blocks a title that adds seniority", () => {
    expect(out.suggestions.map((s) => s.fingerprint)).toEqual([
      "skill:snowflake",
      "title:delta retail group:junior analyst:junior sales analyst",
    ]);
    expect(reasons()).toMatch(/Senior Revenue Operations Manager => adds seniority not in the CV \(senior\)/);
    const title = out.suggestions[1].payload;
    expect(title).toMatchObject({ experience_index: 2, original_title: "Junior Analyst" });
  });

  it("works the same on the Word version of the CV", () => {
    const fromDocx = verifyParse(raw, docxText, [], "test-model", new Date("2026-10-18"));
    expect(fromDocx.report.counts).toEqual(out.report.counts);
  });

  it("keeps not on record items out and reports the conflict", () => {
    const withClaims = verifyParse(raw, pdfText, ["HubSpot"], "test-model", new Date("2026-10-18"));
    expect(withClaims.skills.map((s) => s.name)).not.toContain("HubSpot");
    expect(withClaims.report.conflicts).toEqual([{ item: "HubSpot", claim: "HubSpot" }]);
  });

  it("counts what was kept", () => {
    expect(out.report.counts).toEqual({ experiences: 3, results: 7, skills: 7, suggestions: 2 });
  });
});
