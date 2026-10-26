import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/supabase/user";
import { kindFor } from "@/lib/cv/text";

const TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

// Serves one of the signed in user's own uploaded CVs from this site, so the profile page can show it next to
// what was read. Row level security on the table and the storage folder means nobody can open another
// user's file. The content type is set from the file kind we accept, never from what the browser sent.
export async function GET(_req: NextRequest, ctx: RouteContext<"/app/cv/[id]">) {
  const { id } = await ctx.params;
  const { supabase } = await requireUser();
  const { data: upload } = await supabase
    .from("cv_uploads")
    .select("storage_path, file_name, mime_type")
    .eq("id", id)
    .maybeSingle();
  if (!upload) return new Response("Not found", { status: 404 });

  const kind = kindFor(upload.mime_type ?? "", upload.file_name);
  if (!kind) return new Response("Not found", { status: 404 });
  const { data: file } = await supabase.storage.from("cv-uploads").download(upload.storage_path);
  if (!file) return new Response("Not found", { status: 404 });

  // PDFs open in the page; Word files download, because browsers cannot show them.
  const disposition = kind === "pdf" ? "inline" : "attachment";
  const safeName = upload.file_name.replace(/[^\w.\- ]/g, "_");
  return new Response(file, {
    headers: {
      "Content-Type": TYPES[kind],
      "Content-Disposition": `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(upload.file_name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
