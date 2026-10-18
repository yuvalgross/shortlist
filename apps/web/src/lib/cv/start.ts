import "server-only";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { backgroundClientFor } from "@/lib/supabase/user";
import { claudeModelCall } from "./model";
import { runParse } from "./run";
import { STUCK_AFTER_MS } from "./status";

export type ScheduleResult = "started" | "already_running" | "refused";

// Marks the upload as being read and finishes the work after the response, so the page can show progress.
// Only one reading per upload at a time: a double click on "Try again" must not start (and pay for) two.
export async function scheduleParse(supabase: SupabaseClient, uploadId: string): Promise<ScheduleResult> {
  const { data: upload } = await supabase.from("cv_uploads").select("parse_status").eq("id", uploadId).maybeSingle();
  if (!upload || upload.parse_status === "confirmed") return "refused";

  // The reading can take a few minutes. Make sure the sign in token outlives it.
  const background = await backgroundClientFor(supabase, 10 * 60);

  // Claim the upload in one statement: it succeeds only if no reading is running,
  // or the one that was running is older than the stuck limit.
  const staleBefore = new Date(Date.now() - STUCK_AFTER_MS).toISOString();
  const { data: claimed } = await supabase
    .from("cv_uploads")
    .update({ parse_status: "parsing", error: null, parse_started_at: new Date().toISOString() })
    .eq("id", uploadId)
    .neq("parse_status", "confirmed")
    .or(`parse_status.neq.parsing,parse_started_at.is.null,parse_started_at.lt.${staleBefore}`)
    .select("id");
  if (!claimed?.length) return "already_running";

  const apiKey = process.env.ANTHROPIC_API_KEY;
  after(() => runParse(background, uploadId, apiKey ? claudeModelCall(apiKey) : null));
  return "started";
}
