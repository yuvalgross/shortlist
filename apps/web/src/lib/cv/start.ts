import "server-only";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { backgroundClientFor } from "@/lib/supabase/user";
import { claudeModelCall } from "./model";
import { runParse } from "./run";

// Marks the upload as being read and finishes the work after the response, so the page can show progress.
export async function scheduleParse(supabase: SupabaseClient, uploadId: string) {
  const background = await backgroundClientFor(supabase);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  await supabase
    .from("cv_uploads")
    .update({ parse_status: "parsing", error: null, parse_started_at: new Date().toISOString() })
    .eq("id", uploadId);
  after(() => runParse(background, uploadId, apiKey ? claudeModelCall(apiKey) : null));
}
