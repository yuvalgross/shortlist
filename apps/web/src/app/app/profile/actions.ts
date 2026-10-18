"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/supabase/user";
import { scheduleParse } from "@/lib/cv/start";

const str = (f: FormData, k: string, max = 300) => String(f.get(k) ?? "").trim().slice(0, max);
const month = (v: string) => (/^\d{4}-\d{2}$/.test(v) ? `${v}-01` : null);
const UNIQUE_VIOLATION = "23505";

// Every change below is limited to the signed in user's own rows by row level security.
// When the database refuses a change, the user gets a message instead of a page that silently looks the same.
function done(error: { message: string; code?: string } | null, ignoreCode?: string) {
  if (error && error.code !== ignoreCode) redirect("/app/profile?error=save");
  refresh();
}

export async function retryParse(formData: FormData) {
  const { supabase } = await requireUser();
  const result = await scheduleParse(supabase, str(formData, "upload_id"));
  // "already_running" is fine: the page keeps showing the reading in progress
  done(result === "refused" ? { message: "upload cannot be read" } : null);
}

export async function updateBasics(formData: FormData) {
  const { supabase, userId } = await requireUser();
  const { error } = await supabase.from("profiles").upsert({
    user_id: userId,
    full_name: str(formData, "full_name") || null,
    headline: str(formData, "headline") || null,
    location: str(formData, "location") || null,
  });
  done(error);
}

export async function updateExperience(formData: FormData) {
  const { supabase } = await requireUser();
  const current = formData.get("is_current") === "on";
  const { error } = await supabase
    .from("experiences")
    .update({
      title: str(formData, "title") || "Untitled role",
      company: str(formData, "company") || "Unknown company",
      // only touch fields the form actually sent, so a form without a location box keeps the location
      ...(formData.has("location") ? { location: str(formData, "location") || null } : {}),
      start_date: month(str(formData, "start")),
      end_date: current ? null : month(str(formData, "end")),
      is_current: current,
      source_type: "user",
    })
    .eq("id", str(formData, "id"));
  done(error);
}

export async function deleteExperience(formData: FormData) {
  const { supabase } = await requireUser();
  const id = str(formData, "id");
  // unreviewed results go with the role; confirmed ones stay (the database unlinks them)
  await supabase.from("stories").delete().eq("experience_id", id).eq("status", "suggested");
  const { error } = await supabase.from("experiences").delete().eq("id", id);
  done(error);
}

export async function deleteStory(formData: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("stories").delete().eq("id", str(formData, "id"));
  done(error);
}

export async function addSkill(formData: FormData) {
  const { supabase, userId } = await requireUser();
  const name = str(formData, "name", 80);
  if (!name) return refresh();
  // A duplicate (same name, any capitalisation) is refused by the database and simply ignored here.
  const { error } = await supabase.from("skills").insert({ user_id: userId, name, status: "confirmed", source_type: "user" });
  done(error, UNIQUE_VIOLATION);
}

export async function removeSkill(formData: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("skills").delete().eq("id", str(formData, "id"));
  done(error);
}

export async function acceptSuggestion(formData: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("accept_suggestion", { p_id: str(formData, "id") });
  done(error);
}

export async function rejectSuggestion(formData: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase
    .from("suggestions")
    .update({ status: "rejected", decided_at: new Date().toISOString() })
    .eq("id", str(formData, "id"))
    .eq("status", "pending");
  done(error);
}

export async function confirmProfile(formData: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("confirm_cv_upload", { p_upload: str(formData, "upload_id") });
  if (error) redirect("/app/profile?error=confirm");
  redirect("/app/proof?confirmed=1");
}
