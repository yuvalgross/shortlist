import "server-only";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { backgroundClientFor } from "@/lib/supabase/user";
import { claudeModelCall } from "./model";
import { runParse } from "./run";

// Marks the upload as being read and finishes the work after the response, so the page can show progress.
// Returns false when the upload is not in a state that can be read (already confirmed, or not the user's).
export async function scheduleParse(supabase: SupabaseClient, uploadId: string): Promise<boolean> {
  const { data: upload } = await supabase.from("cv_uploads").select("parse_status").eq("id", uploadId).maybeSingle();
  if (!upload || upload.parse_status === "confirmed") return false;

  // The reading can take a few minutes. Make sure the sign in token outlives it.
  const background = await backgroundClientFor(supabase, 10 * 60);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  await supabase
    .from("cv_uploads")
    .update({ parse_status: "parsing", error: null, parse_started_at: new Date().toISOString() })
    .eq("id", uploadId);
  after(() => runParse(background, uploadId, apiKey ? claudeModelCall(apiKey) : null));
  return true;
}
