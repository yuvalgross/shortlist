"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/supabase/user";

const str = (f: FormData, k: string, max = 2000) => String(f.get(k) ?? "").trim().slice(0, max);

export async function saveStory(formData: FormData) {
  const { supabase, userId } = await requireUser();
  const id = str(formData, "id");
  const metric = str(formData, "result_metric", 200);
  // A story may only point at one of the user's own roles. Anything else becomes "no role".
  let experienceId: string | null = str(formData, "experience_id") || null;
  if (experienceId) {
    const { data: own } = await supabase.from("experiences").select("id").eq("id", experienceId).maybeSingle();
    if (!own) experienceId = null;
  }
  const row = {
    title: str(formData, "title", 120) || "Untitled story",
    experience_id: experienceId,
    situation: str(formData, "situation") || null,
    task: str(formData, "task") || null,
    action: str(formData, "action") || null,
    result: str(formData, "result") || null,
    result_metric: metric || null,
    result_confidence: metric ? (str(formData, "confidence") === "estimate" ? "estimate" : "verified") : null,
    tags: str(formData, "tags", 400).split(",").map((t) => t.trim()).filter(Boolean).slice(0, 12),
  };
  if (id) {
    // Editing a story is the user's own statement of fact, so it counts as confirmed.
    const { error } = await supabase.from("stories").update({ ...row, status: "confirmed" }).eq("id", id);
    if (error) redirect(`/app/proof?story=${id}&error=save`);
    redirect(`/app/proof?story=${id}&saved=1`);
  }
  const { data, error } = await supabase
    .from("stories")
    .insert({ ...row, user_id: userId, status: "confirmed", source_type: "user" })
    .select("id")
    .single();
  if (error || !data) redirect("/app/proof?story=new&error=save");
  redirect(`/app/proof?story=${data.id}&saved=1`);
}

export async function deleteStory(formData: FormData) {
  const { supabase } = await requireUser();
  await supabase.from("stories").delete().eq("id", str(formData, "id"));
  redirect("/app/proof");
}

// One claim per line, so a whole list can be pasted at once.
export async function addClaims(formData: FormData) {
  const { supabase, userId } = await requireUser();
  const { data: existing } = await supabase.from("not_on_record").select("claim");
  const have = new Set((existing ?? []).map((c: { claim: string }) => c.claim.toLowerCase()));
  const rows = str(formData, "claims", 4000)
    .split("\n")
    .map((l) => l.replace(/^[-•*\s]+/, "").trim())
    .filter((l) => l && !have.has(l.toLowerCase()))
    .slice(0, 50)
    .map((claim) => ({ user_id: userId, claim: claim.slice(0, 200) }));
  if (rows.length) await supabase.from("not_on_record").insert(rows);
  refresh();
}

export async function removeClaim(formData: FormData) {
  const { supabase } = await requireUser();
  await supabase.from("not_on_record").delete().eq("id", str(formData, "id"));
  refresh();
}
