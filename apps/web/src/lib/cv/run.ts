// Runs one CV upload through: download, text extraction, the matching model, the code checks, and the save.
// Works with a Supabase client that acts as the signed in user, so row level security applies throughout.
import type { SupabaseClient } from "@supabase/supabase-js";
import { MIN_TEXT_CHARS, extractCvText, kindFor } from "./text";
import { verifyParse } from "./verify";
import type { ModelCall } from "./model";

import { UserFacingError } from "./errors";
export { UserFacingError };

// Problems with the matching model account rather than with the CV: retrying will not help until they are fixed.
const PAUSED = "Reading CVs is paused right now because of a problem with the matching model account. Your file is saved; try again later.";
export function accountProblem(err: unknown, paused = PAUSED): string | null {
  const e = err as { status?: number; message?: string } | null;
  const text = String(e?.message ?? "").toLowerCase();
  if (e?.status === 401 || e?.status === 403) return paused;
  if (e?.status === 400 && /credit balance|billing/.test(text)) return paused;
  return null;
}

export async function runParse(db: SupabaseClient, uploadId: string, modelCall: ModelCall | null): Promise<void> {
  try {
    const { data: upload, error } = await db
      .from("cv_uploads")
      .select("id, storage_path, file_name, mime_type")
      .eq("id", uploadId)
      .single();
    if (error || !upload) throw new UserFacingError("We could not find this upload.");

    await db.from("cv_uploads").update({ parse_status: "parsing", error: null }).eq("id", uploadId);

    if (!modelCall) {
      throw new UserFacingError("Reading CVs is not switched on yet. The matching model key still needs to be added.");
    }

    const kind = kindFor(upload.mime_type ?? "", upload.file_name);
    if (!kind) throw new UserFacingError("Only PDF and Word (.docx) files can be read.");

    const { data: file, error: dlError } = await db.storage.from("cv-uploads").download(upload.storage_path);
    if (dlError || !file) throw new UserFacingError("We could not open the uploaded file. Try uploading it again.");

    const text = await extractCvText(new Uint8Array(await file.arrayBuffer()), kind);
    await db.from("cv_uploads").update({ parsed_text: text, text_chars: text.length }).eq("id", uploadId);
    if (text.length < MIN_TEXT_CHARS) {
      throw new UserFacingError(
        "This file has almost no readable text, which usually means it is a scanned image. Applicant tracking systems cannot read it either. Upload a PDF exported from Word or Google Docs instead.",
      );
    }

    const { data: claims } = await db.from("not_on_record").select("claim");
    const notOnRecord = (claims ?? []).map((c: { claim: string }) => c.claim);

    const { raw, model, usage } = await modelCall(text);
    const payload = verifyParse(raw, text, notOnRecord, model);
    const { error: saveError } = await db.rpc("apply_cv_parse", {
      p_upload: uploadId,
      p: { ...payload, report: { ...payload.report, usage, text_chars: text.length } },
    });
    if (saveError) throw new Error(`Saving the parse failed: ${saveError.message}`);
  } catch (err) {
    const known = err instanceof UserFacingError ? err.message : accountProblem(err);
    const message = known ?? "Something went wrong while reading your CV. Try again in a minute.";
    if (!(err instanceof UserFacingError)) console.error("CV parse failed", uploadId, err);
    const { error: markError } = await db.from("cv_uploads").update({ parse_status: "failed", error: message }).eq("id", uploadId);
    if (markError) console.error("CV parse failed and the status could not be updated", uploadId, markError.message);
  }
}
