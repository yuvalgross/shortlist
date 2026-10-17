import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runParse } from "@/lib/cv/run";
import type { ModelCall } from "@/lib/cv/model";
import type { RawParse } from "@/lib/cv/schema";

const fx = (n: string) => join(__dirname, "fixtures", n);
const raw = JSON.parse(readFileSync(fx("fictional-cv.model-output.json"), "utf8")) as RawParse;

// A tiny stand-in for the Supabase client: records every update and the final save.
function fakeDb(file: Uint8Array, opts: { claims?: string[]; mime?: string; name?: string } = {}) {
  const updates: Record<string, unknown>[] = [];
  let saved: { p_upload: string; p: Record<string, unknown> } | null = null;
  const chain = (table: string) => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: { id: "u1", storage_path: "user/cv", file_name: opts.name ?? "cv.pdf", mime_type: opts.mime ?? "application/pdf" },
          error: null,
        }),
      }),
      then: (res: (v: unknown) => void) => res({ data: (opts.claims ?? []).map((claim) => ({ claim })), error: null }),
    }),
    update: (row: Record<string, unknown>) => {
      updates.push({ table, ...row });
      return { eq: async () => ({ error: null }) };
    },
  });
  const db = {
    from: chain,
    storage: { from: () => ({ download: async () => ({ data: new Blob([file as BlobPart]), error: null }) }) },
    rpc: async (_name: string, args: { p_upload: string; p: Record<string, unknown> }) => {
      saved = args;
      return { error: null };
    },
  } as unknown as SupabaseClient;
  return { db, updates, saved: () => saved };
}

const fakeModel: ModelCall = async () => ({ raw, model: "fake", usage: { input_tokens: 1000, output_tokens: 500 } });

describe("reading an upload end to end", () => {
  it("extracts, checks and saves the result through the database function", async () => {
    const { db, updates, saved } = fakeDb(new Uint8Array(readFileSync(fx("fictional-cv.pdf"))));
    await runParse(db, "u1", fakeModel);
    const s = saved()!;
    expect(s.p_upload).toBe("u1");
    expect((s.p.report as { counts: unknown }).counts).toEqual({ experiences: 3, results: 7, skills: 7, suggestions: 2 });
    expect((s.p.report as { usage: unknown }).usage).toEqual({ input_tokens: 1000, output_tokens: 500 });
    expect(updates.some((u) => u.parse_status === "failed")).toBe(false);
    expect(updates.find((u) => "text_chars" in u)?.text_chars).toBeGreaterThan(300);
  });

  it("applies the user's not on record list while reading", async () => {
    const { db, saved } = fakeDb(new Uint8Array(readFileSync(fx("fictional-cv.docx"))), {
      claims: ["Looker"], mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: "cv.docx",
    });
    await runParse(db, "u1", fakeModel);
    const skills = (saved()!.p.skills as { name: string }[]).map((x) => x.name);
    expect(skills).not.toContain("Looker");
  });

  it("explains clearly when the matching model is not switched on", async () => {
    const { db, updates, saved } = fakeDb(new Uint8Array(readFileSync(fx("fictional-cv.pdf"))));
    await runParse(db, "u1", null);
    expect(saved()).toBeNull();
    expect(updates.at(-1)).toMatchObject({ parse_status: "failed", error: expect.stringContaining("not switched on yet") });
  });

  it("refuses a file with no readable text, before spending money on the model", async () => {
    let called = false;
    const spy: ModelCall = async (t) => {
      called = true;
      return fakeModel(t);
    };
    const { db, updates } = fakeDb(new Uint8Array(readFileSync(fx("scanned-image-only.pdf"))));
    await runParse(db, "u1", spy);
    expect(called).toBe(false);
    expect(updates.at(-1)).toMatchObject({ parse_status: "failed", error: expect.stringContaining("scanned image") });
  });

  it("hides technical errors from the user but marks the upload failed", async () => {
    const broken: ModelCall = async () => {
      throw new Error("529 overloaded_error internal detail");
    };
    const { db, updates } = fakeDb(new Uint8Array(readFileSync(fx("fictional-cv.pdf"))));
    const log = console.error;
    console.error = () => {};
    await runParse(db, "u1", broken);
    console.error = log;
    const last = updates.at(-1)!;
    expect(last.parse_status).toBe("failed");
    expect(String(last.error)).not.toContain("overloaded");
  });
});
