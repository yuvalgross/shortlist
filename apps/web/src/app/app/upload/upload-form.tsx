"use client";

import { useState, useTransition } from "react";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { registerUpload } from "./actions";
import { btn } from "@/components/ui";

const MAX = 5 * 1024 * 1024;

export function UploadForm({ userId }: { userId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) return setError("Choose a file first.");
    if (!/\.(pdf|docx)$/i.test(file.name)) return setError("Only PDF and Word (.docx) files can be read.");
    if (file.size > MAX) return setError("The file is larger than 5 MB.");
    if (!consent) return setError("Please agree to how we store your CV first.");

    startTransition(async () => {
      setStatus("Uploading…");
      const safe = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80);
      const path = `${userId}/${Date.now()}-${safe}`;
      const mime = /\.pdf$/i.test(file.name)
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const supabase = createBrowserSupabase();
      const { error: upErr } = await supabase.storage.from("cv-uploads").upload(path, file, { contentType: mime });
      if (upErr) {
        setStatus(null);
        return setError("The upload failed. Check your connection and try again.");
      }
      setStatus("Starting to read your CV…");
      const res = await registerUpload({ path, fileName: file.name, mime, size: file.size, consent });
      if (res?.error) {
        setStatus(null);
        setError(res.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label htmlFor="cv" className="flex min-h-56 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-[#b9b5ac] bg-surface p-8 text-center">
        <span className="text-lg font-medium">{file ? file.name : "Choose your CV"}</span>
        <span className="text-sm text-muted">PDF or Word (.docx), up to 5 MB</span>
        <input id="cv" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
      </label>
      <div className="flex items-start gap-3 text-sm leading-relaxed">
        <input id="consent" type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 h-5 w-5" />
        <label htmlFor="consent">
          I agree that Shortlist stores my CV and the profile built from it in the EU, to find and score jobs for me. I can delete it at any time.
        </label>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {status && !error && <p className="text-sm text-muted" aria-live="polite">{status}</p>}
      <div className="flex justify-end">
        <button type="submit" className={btn.primary} disabled={pending}>
          {pending ? "Working…" : "Upload and read my CV"}
        </button>
      </div>
    </form>
  );
}
