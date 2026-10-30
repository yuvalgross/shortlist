"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { requireUser } from "@/lib/supabase/user";
import { claudeScoreCall } from "@/lib/score/model";
import { scoreJob } from "@/lib/score/run";

const str = (f: FormData, k: string, max = 300) => String(f.get(k) ?? "").trim().slice(0, max);
const int = (f: FormData, k: string) => {
  const n = Number(str(f, k, 20).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

export type ScoreState = { error: string | null };

export async function scorePastedJob(_prev: ScoreState, formData: FormData): Promise<ScoreState> {
  const { supabase } = await requireUser();
  const url = str(formData, "url", 2000);
  if (url && !/^https?:\/\//i.test(url)) return { error: "The link must start with http:// or https://." };
  const callMin = int(formData, "call_min");
  const callMax = int(formData, "call_max");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const res = await scoreJob(
    supabase,
    {
      jobText: String(formData.get("job_text") ?? ""),
      title: str(formData, "title"),
      company: str(formData, "company", 200),
      url,
      location: str(formData, "location"),
      headcount: int(formData, "headcount") || null,
      callPay: callMin || callMax ? { min: callMin, max: callMax } : null,
    },
    apiKey ? claudeScoreCall(apiKey) : null,
  );
  if (!res.ok) return { error: res.error };
  redirect(`/app/jobs?scored=${res.matchId}#m-${res.matchId}`);
}

export async function removePastedJob(formData: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("companies").delete().eq("id", str(formData, "company_id"));
  if (error) redirect("/app/jobs?error=remove");
  refresh();
}
