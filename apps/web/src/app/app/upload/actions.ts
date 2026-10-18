"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/supabase/user";
import { scheduleParse } from "@/lib/cv/start";
import { MAX_BYTES, kindFor } from "@/lib/cv/text";

// The browser has already put the file in the user's own storage folder. This records it and starts reading it.
export async function registerUpload(input: { path: string; fileName: string; mime: string; size: number; consent: boolean }) {
  const { supabase, userId } = await requireUser();
  if (!input.consent) return { error: "Please agree to how we store your CV first." };
  if (!input.path.startsWith(`${userId}/`)) return { error: "That upload does not belong to you." };
  if (!kindFor(input.mime, input.fileName)) return { error: "Only PDF and Word (.docx) files can be read." };
  if (input.size > MAX_BYTES) return { error: "The file is larger than 5 MB." };

  const { data, error } = await supabase
    .from("cv_uploads")
    .insert({
      user_id: userId,
      storage_path: input.path,
      file_name: input.fileName.slice(0, 200),
      mime_type: input.mime,
      consent_at: new Date().toISOString(),
      parse_status: "pending",
    })
    .select("id")
    .single();
  if (error || !data) return { error: "We could not save the upload. Try again." };

  await scheduleParse(supabase, data.id);
  redirect("/app/profile");
}
