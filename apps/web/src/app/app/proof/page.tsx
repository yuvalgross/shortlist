import { Suspense } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/supabase/user";
import { Card, PageTitle, Steps, Tag, btn, field, label } from "@/components/ui";
import { addClaims, deleteStory, removeClaim, saveStory } from "./actions";

type Story = {
  id: string; experience_id: string | null; title: string; situation: string | null; task: string | null;
  action: string | null; result: string | null; result_metric: string | null; result_confidence: string | null;
  tags: string[]; status: string; source_quote: string | null;
};
type Exp = { id: string; title: string; company: string };

export default function ProofPage({ searchParams }: PageProps<"/app/proof">) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <Steps current={2} />
      <Suspense fallback={<p className="text-muted">Loading your proof bank…</p>}>
        <Proof searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Proof({ searchParams }: { searchParams: PageProps<"/app/proof">["searchParams"] }) {
  const { supabase } = await requireUser();
  const params = await searchParams;
  const [{ data: s }, { data: e }, { data: c }] = await Promise.all([
    supabase.from("stories").select("id, experience_id, title, situation, task, action, result, result_metric, result_confidence, tags, status, source_quote").order("created_at"),
    supabase.from("experiences").select("id, title, company").eq("status", "confirmed").order("sort_order"),
    supabase.from("not_on_record").select("id, claim").order("claim"),
  ]);
  const stories = (s ?? []) as Story[];
  const exps = (e ?? []) as Exp[];
  const claims = (c ?? []) as { id: string; claim: string }[];
  const selectedId = typeof params.story === "string" ? params.story : stories[0]?.id ?? "new";
  const selected = stories.find((x) => x.id === selectedId) ?? null;
  const expName = (id: string | null) => {
    const x = exps.find((y) => y.id === id);
    return x ? `${x.title} · ${x.company}` : "No role";
  };

  return (
    <div className="flex flex-col gap-8">
      {params.confirmed === "1" && (
        <p className="rounded-lg bg-accent-soft px-4 py-3 text-[#0a3f35]">Profile confirmed. Now make your results specific: each one you complete here can be used in tailored CVs and interview prep.</p>
      )}
      <div className="grid gap-8 lg:grid-cols-[300px_1fr]">
        <aside className="flex flex-col gap-3">
          <PageTitle sub="Tailored CVs only use claims from here and your confirmed roles. Nothing else gets written for you.">Your proof bank</PageTitle>
          <ul className="flex flex-col gap-2">
            {stories.map((x) => (
              <li key={x.id}>
                <Link
                  href={`/app/proof?story=${x.id}`}
                  aria-current={x.id === selected?.id ? "true" : undefined}
                  className={`block rounded-lg border bg-surface p-3 ${x.id === selected?.id ? "border-2 border-accent" : "border-line"}`}
                >
                  <span className="block font-medium">{x.title}</span>
                  <span className={`text-xs ${x.result_metric ? "text-muted" : "text-[#8a3f06]"}`}>
                    {x.result_metric ? x.result_metric : "Needs a result"}{x.status === "suggested" ? " · to review" : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <Link href="/app/proof?story=new" className={`${btn.secondary} border-dashed`}>+ Add a story</Link>
        </aside>

        <Card className="flex flex-col gap-4">
          {params.saved === "1" && <p className="text-sm text-[#0a4a3e]" aria-live="polite">Saved.</p>}
          {params.error === "save" && <p role="alert" className="text-sm text-red-800">Saving failed. Try again.</p>}
          {selected?.source_quote && <p className="font-mono text-xs text-muted">From your CV: &ldquo;{selected.source_quote}&rdquo;</p>}
          <form action={saveStory} className="flex flex-col gap-4" key={selected?.id ?? "new"}>
            <input type="hidden" name="id" value={selected?.id ?? ""} />
            <div className="grid gap-4 sm:grid-cols-2">
              <label className={label}>Story name<input name="title" required defaultValue={selected?.title ?? ""} className={field} /></label>
              <label className={label}>Role
                <select name="experience_id" defaultValue={selected?.experience_id ?? ""} className={field}>
                  <option value="">No role</option>
                  {exps.map((x) => <option key={x.id} value={x.id}>{expName(x.id)}</option>)}
                </select>
              </label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className={label}>Situation<textarea name="situation" rows={3} defaultValue={selected?.situation ?? ""} className={field} /></label>
              <label className={label}>Task<textarea name="task" rows={3} defaultValue={selected?.task ?? ""} className={field} /></label>
            </div>
            <label className={label}>What you did<textarea name="action" rows={3} defaultValue={selected?.action ?? ""} className={field} /></label>
            <label className={label}>Result in words<textarea name="result" rows={2} defaultValue={selected?.result ?? ""} className={field} /></label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className={label}>Result with a number
                <input name="result_metric" defaultValue={selected?.result_metric ?? ""} placeholder="e.g. MQL rate up 42% in two quarters" className={`${field} ${selected?.result_metric ? "" : "border-[#c26a12]"}`} />
              </label>
              <label className={label}>How sure are you of it
                <select name="confidence" defaultValue={selected?.result_confidence ?? "verified"} className={field}>
                  <option value="verified">From a report or the CRM</option>
                  <option value="estimate">My own estimate</option>
                </select>
              </label>
            </div>
            <label className={label}>What this story proves (comma separated)<input name="tags" defaultValue={(selected?.tags ?? []).join(", ")} placeholder="pipeline generation, automation" className={field} /></label>
            <div className="flex flex-wrap justify-end gap-3">
              <button className={btn.primary}>Save story</button>
            </div>
          </form>
          {selected && (
            <form action={deleteStory} className="self-end">
              <input type="hidden" name="id" value={selected.id} />
              <button className="text-sm text-muted underline">Delete this story</button>
            </form>
          )}
        </Card>
      </div>

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Not on your record</h2>
        <p className="text-sm text-muted">
          Tools, skills or claims that must never appear on a CV written for you, even if a job asks for them. They are also kept out when your CV is read.
        </p>
        {claims.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {claims.map((x) => (
              <li key={x.id}>
                <form action={removeClaim} className="flex items-center gap-1 rounded-full border border-line py-1 pl-3 pr-1 text-sm">
                  <input type="hidden" name="id" value={x.id} />
                  {x.claim}
                  <button aria-label={`Remove ${x.claim}`} className="rounded-full px-2 text-muted hover:text-foreground">×</button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form action={addClaims} className="flex flex-col gap-2">
          <label className={label}>Add items, one per line<textarea name="claims" rows={3} placeholder={"ZoomInfo\nSQL or a data warehouse"} className={field} /></label>
          <button className={`${btn.small} self-end`}>Add to the list</button>
        </form>
        <div className="flex gap-2 text-sm text-muted"><Tag tone="muted">TIP</Tag>Add these before uploading a CV, so they are filtered out while it is read.</div>
      </Card>
    </div>
  );
}
