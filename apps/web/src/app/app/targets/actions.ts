"use server";

import { requireUser } from "@/lib/supabase/user";

const lines = (v: FormDataEntryValue | null, max = 40) =>
  String(v ?? "").split(/\n|,/).map((s) => s.trim()).filter(Boolean).slice(0, max).map((s) => s.slice(0, 120));

export type TargetsState = { error: string | null; saved: boolean };

export async function saveTargets(_prev: TargetsState, formData: FormData): Promise<TargetsState> {
  const { supabase, userId } = await requireUser();
  const titles = String(formData.get("titles") ?? "")
    .split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 20)
    .map((title, i) => ({ title: title.slice(0, 120), priority: i + 1 }));
  const floorRaw = String(formData.get("salary_min") ?? "").replace(/[^\d]/g, "");
  const floor = floorRaw ? Number(floorRaw) : null;
  if (floor != null && (floor < 1000 || floor > 1_000_000)) return { error: "Enter the salary floor as a yearly number, for example 70000.", saved: false };
  const currency = String(formData.get("salary_currency") ?? "EUR").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { error: "Choose a currency.", saved: false };
  const { error } = await supabase.from("targets").upsert({
    user_id: userId,
    titles,
    seniority: String(formData.get("seniority") ?? "").trim().slice(0, 120) || null,
    salary_min: floor,
    salary_currency: currency,
    keep_no_salary: formData.get("keep_no_salary") === "on",
    industries: lines(formData.get("industries")),
    company_blocklist: lines(formData.get("company_blocklist"), 200),
    exclude_terms: lines(formData.get("exclude_terms")),
    required_language_skip: lines(formData.get("required_language_skip"), 20),
    open_to_relocation: lines(formData.get("open_to_relocation"), 30),
    updated_at: new Date().toISOString(),
  });
  if (error) return { error: "Saving failed. Try again.", saved: false };
  return { error: null, saved: true };
}
