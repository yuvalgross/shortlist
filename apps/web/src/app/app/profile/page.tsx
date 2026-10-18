import { Suspense } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/supabase/user";
import { parseLooksStuck } from "@/lib/cv/status";
import { Card, PageTitle, Steps, SuggestionCard, Tag, btn, field, label } from "@/components/ui";
import type { ParseReport } from "@/lib/cv/verify";
import { Poller } from "./poller";
import {
  acceptSuggestion, addSkill, confirmProfile, deleteExperience, deleteStory, rejectSuggestion,
  removeSkill, retryParse, updateBasics, updateExperience,
} from "./actions";

export const maxDuration = 300; // "Try again" restarts the background reading from this page

type Upload = {
  id: string; file_name: string; parse_status: string; error: string | null; created_at: string;
  parse_started_at: string | null; parsed_at: string | null; parse_report: Partial<ParseReport> | null;
};
type Experience = {
  id: string; title: string; ats_title: string | null; company: string; location: string | null;
  start_date: string | null; end_date: string | null; is_current: boolean; status: string; source_quote: string | null;
};
type Story = { id: string; experience_id: string | null; title: string; action: string | null; result_metric: string | null; status: string };
type Skill = { id: string; name: string; status: string };
type Suggestion = { id: string; kind: string; payload: Record<string, string>; source_quote: string | null };

export default function ProfilePage({ searchParams }: PageProps<"/app/profile">) {
  return (
    <>
      <Steps current={1} />
      <Suspense fallback={<p className="text-muted">Loading your profile…</p>}>
        <Profile searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Profile({ searchParams }: { searchParams: PageProps<"/app/profile">["searchParams"] }) {
  const { supabase } = await requireUser();
  const params = await searchParams;
  const { data: upload } = await supabase
    .from("cv_uploads")
    .select("id, file_name, parse_status, error, created_at, parse_started_at, parsed_at, parse_report")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<Upload>();

  if (!upload) {
    return (
      <Card>
        <p>No CV yet.</p>
        <Link href="/app/upload" className={`${btn.primary} mt-4`}>Upload your CV</Link>
      </Card>
    );
  }

  // The latest upload's state. When the user already has a confirmed profile, the state is shown above it
  // instead of hiding it (a failed second upload must not make the confirmed profile disappear).
  const { count: confirmedRoles } = await supabase
    .from("experiences")
    .select("id", { count: "exact", head: true })
    .eq("status", "confirmed");
  let status: React.ReactNode = null;

  // Reading is capped at 5 minutes on the server. Past that the function was stopped before it could
  // record a failure, so the page treats the upload as failed and offers a retry.
  if (parseLooksStuck(upload)) {
    status = (
      <Card className="flex flex-col gap-3">
        <PageTitle>Reading {upload.file_name} took too long</PageTitle>
        <p role="alert" className="text-red-800">The reading did not finish in time. Try again, or upload a different file.</p>
        <div className="flex flex-wrap gap-3">
          <RetryForm id={upload.id} />
          <Link href="/app/upload" className={btn.secondary}>Upload a different file</Link>
        </div>
      </Card>
    );
  } else if (upload.parse_status === "pending" || upload.parse_status === "parsing") {
    status = (
      <Card className="flex flex-col gap-3">
        <PageTitle>Reading {upload.file_name}</PageTitle>
        <Poller startedAt={upload.parse_started_at ?? upload.created_at}>
          <RetryForm id={upload.id} />
        </Poller>
      </Card>
    );
  } else if (upload.parse_status === "failed") {
    status = (
      <Card className="flex flex-col gap-3">
        <PageTitle>We could not read {upload.file_name}</PageTitle>
        <p role="alert" className="text-red-800">{upload.error}</p>
        <div className="flex flex-wrap gap-3">
          <RetryForm id={upload.id} />
          <Link href="/app/upload" className={btn.secondary}>Upload a different file</Link>
        </div>
      </Card>
    );
  }
  if (status && !confirmedRoles) return status;

  const [{ data: profile }, { data: exps }, { data: stories }, { data: skills }, { data: suggestions }] = await Promise.all([
    supabase.from("profiles").select("full_name, headline, location, languages, education, certifications").maybeSingle(),
    supabase.from("experiences").select("id, title, ats_title, company, location, start_date, end_date, is_current, status, source_quote").order("status", { ascending: false }).order("sort_order"),
    supabase.from("stories").select("id, experience_id, title, action, result_metric, status").order("created_at"),
    supabase.from("skills").select("id, name, status").order("name"),
    supabase.from("suggestions").select("id, kind, payload, source_quote").eq("status", "pending").order("created_at"),
  ]);
  const experiences = (exps ?? []) as Experience[];
  const allStories = (stories ?? []) as Story[];
  const allSkills = (skills ?? []) as Skill[];
  // a title suggestion whose role was deleted can no longer be applied, so it is not offered
  const roleIds = new Set(experiences.map((e) => e.id));
  const pending = ((suggestions ?? []) as Suggestion[]).filter(
    (s) => s.kind !== "title" || roleIds.has(String(s.payload.experience_id ?? "")),
  );
  const report = upload.parse_report ?? {};

  const missingDates = experiences.filter((e) => !e.start_date);
  const noNumber = allStories.filter((s) => s.experience_id && !s.result_metric);
  const toReview = upload.parse_status === "parsed";

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-5">
        {status}
        <PageTitle sub="Every CV we write later starts from this profile, so wrong dates or titles here end up everywhere. Edit or delete anything that is off.">
          {toReview ? "Here is what we read. Fix anything that is off." : "Your profile"}
        </PageTitle>
        {(params.error === "confirm" || params.error === "save") && <p role="alert" className="text-red-800">Saving failed. Try again.</p>}

        <Card>
          <form action={updateBasics} className="grid gap-3 sm:grid-cols-3">
            <label className={label}>Name<input name="full_name" defaultValue={profile?.full_name ?? ""} className={field} /></label>
            <label className={label}>Headline<input name="headline" defaultValue={profile?.headline ?? ""} className={field} /></label>
            <label className={label}>Location<input name="location" defaultValue={profile?.location ?? ""} className={field} /></label>
            <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
              <span>
                Languages: {(profile?.languages ?? []).map((l: { language: string; level: string }) => `${l.language}${l.level ? ` (${l.level})` : ""}`).join(", ") || "none found"}
                {" · "}Education: {(profile?.education ?? []).map((e: { school: string }) => e.school).join(", ") || "none found"}
              </span>
              <button className={btn.small}>Save</button>
            </div>
          </form>
        </Card>

        {experiences.map((e) => (
          <ExperienceCard key={e.id} exp={e} stories={allStories.filter((s) => s.experience_id === e.id)} />
        ))}

        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Skills and tools</h2>
          <ul className="flex flex-wrap gap-2">
            {allSkills.map((s) => (
              <li key={s.id}>
                <form action={removeSkill} className="flex items-center gap-1 rounded-full border border-line py-1 pl-3 pr-1 text-sm">
                  <input type="hidden" name="id" value={s.id} />
                  {s.name}
                  {s.status === "suggested" && <span className="sr-only"> (to review)</span>}
                  <button aria-label={`Remove ${s.name}`} className="rounded-full px-2 text-muted hover:text-foreground">×</button>
                </form>
              </li>
            ))}
          </ul>
          <form action={addSkill} className="flex gap-2">
            <label className="sr-only" htmlFor="new-skill">Add a skill</label>
            <input id="new-skill" name="name" placeholder="Add a skill" className={`${field} flex-1`} />
            <button className={btn.small}>Add</button>
          </form>
        </Card>

        {toReview && (
          <form action={confirmProfile} className="flex flex-wrap items-center justify-between gap-3">
            <input type="hidden" name="upload_id" value={upload.id} />
            <Link href="/app/upload" className="text-muted">Upload a different CV</Link>
            <button className={btn.primary}>Looks right, continue</button>
          </form>
        )}
      </div>

      <aside className="flex flex-col gap-4">
        {pending.length > 0 && (
          <SuggestionCard>
            <h2 className="font-semibold text-[#0a3f35]">{pending.length} suggestion{pending.length > 1 ? "s" : ""} from your CV</h2>
            <p className="mt-1 text-sm text-[#2f4f47]">Things your CV says that the profile does not use yet. Each shows the line it came from.</p>
            <ul className="mt-3 flex flex-col gap-3">
              {pending.map((s) => (
                <li key={s.id} className="rounded-lg border border-[#d3e7df] bg-surface p-3">
                  <p className="text-sm">
                    {s.kind === "skill" ? <>Add <strong>{s.payload.name}</strong> to your skills</> : <>Use the standard title <strong>{s.payload.ats_title}</strong> for &ldquo;{s.payload.original_title}&rdquo;</>}
                  </p>
                  {s.source_quote && <p className="mt-1 font-mono text-xs text-muted">&ldquo;{s.source_quote}&rdquo;</p>}
                  <div className="mt-2 flex gap-2">
                    <form action={acceptSuggestion}><input type="hidden" name="id" value={s.id} /><button className={btn.smallPrimary}>{s.kind === "title" ? "Apply" : "Add"}</button></form>
                    <form action={rejectSuggestion}><input type="hidden" name="id" value={s.id} /><button className={btn.small}>Not accurate</button></form>
                  </div>
                </li>
              ))}
            </ul>
          </SuggestionCard>
        )}

        {(missingDates.length > 0 || noNumber.length > 0 || (report.conflicts?.length ?? 0) > 0) && (
          <section className="rounded-xl border border-[#ebd3b4] bg-[#fbf3e8] p-5 text-sm leading-relaxed text-[#5c2d04]">
            <h2 className="mb-1 font-semibold">Worth fixing</h2>
            <ul className="list-disc pl-4">
              {missingDates.length > 0 && <li>{missingDates.length} role{missingDates.length > 1 ? "s have" : " has"} no start date. ATS filters often skip CVs with dates they cannot read.</li>}
              {noNumber.length > 0 && <li>{noNumber.length} result{noNumber.length > 1 ? "s have" : " has"} no number. <Link href="/app/proof" className="underline">Add them in the proof bank</Link>.</li>}
              {report.conflicts?.map((c) => <li key={c.item}>Your CV lists <strong>{c.item}</strong>, but you marked &ldquo;{c.claim}&rdquo; as not on your record, so we left it out.</li>)}
            </ul>
          </section>
        )}

        <ReportBox report={report} />
      </aside>
    </div>
  );
}

function RetryForm({ id }: { id: string }) {
  return (
    <form action={retryParse} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="upload_id" value={id} />
      <button className={btn.primary}>Try again</button>
    </form>
  );
}

function ExperienceCard({ exp, stories }: { exp: Experience; stories: Story[] }) {
  const m = (d: string | null) => (d ? d.slice(0, 7) : "");
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{exp.title} · {exp.company}</h2>
        {exp.status === "suggested" ? <Tag tone="warn">TO REVIEW</Tag> : <Tag tone="ok">CONFIRMED</Tag>}
        {exp.ats_title && <span className="text-sm text-muted">ATS title: {exp.ats_title}</span>}
      </div>
      {exp.source_quote && <p className="font-mono text-xs text-muted">From your CV: &ldquo;{exp.source_quote}&rdquo;</p>}
      <form action={updateExperience} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <input type="hidden" name="id" value={exp.id} />
        <label className={label}>Job title<input name="title" defaultValue={exp.title} className={field} /></label>
        <label className={label}>Company<input name="company" defaultValue={exp.company} className={field} /></label>
        <label className={label}>Start<input type="month" name="start" defaultValue={m(exp.start_date)} className={`${field} ${exp.start_date ? "" : "border-[#c26a12]"}`} /></label>
        <label className={label}>End<input type="month" name="end" defaultValue={m(exp.end_date)} className={field} /></label>
        <div className="flex flex-col justify-end gap-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_current" defaultChecked={exp.is_current} className="h-4 w-4" />Current role</label>
          <button className={btn.small}>Save role</button>
        </div>
      </form>
      {stories.length > 0 && (
        <ul className="flex flex-col gap-2">
          {stories.map((s) => (
            <li key={s.id} className="flex items-start gap-3 text-sm leading-relaxed">
              {s.result_metric ? <Tag tone="ok">NUMBER</Tag> : <Tag tone="warn">NO NUMBER</Tag>}
              <span className="flex-1">
                {s.action ?? s.title}
                {!s.result_metric && <> <Link className="underline" href={`/app/proof?story=${s.id}`}>Add the result</Link></>}
              </span>
              <form action={deleteStory}>
                <input type="hidden" name="id" value={s.id} />
                <button aria-label="Remove this result" className="px-2 text-muted hover:text-foreground">×</button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <form action={deleteExperience} className="self-end">
        <input type="hidden" name="id" value={exp.id} />
        <button className="text-sm text-muted underline">Delete this role</button>
      </form>
    </Card>
  );
}

function ReportBox({ report }: { report: Partial<ParseReport> }) {
  const dropped = report.dropped ?? [];
  const metrics = report.metrics_removed ?? [];
  if (!dropped.length && !metrics.length) return null;
  return (
    <details className="rounded-xl border border-line bg-surface p-4 text-sm">
      <summary className="cursor-pointer font-medium">What we left out, and why ({dropped.length + metrics.length})</summary>
      <p className="mt-2 text-muted">These could not be traced word for word to your CV, so they were not saved.</p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {dropped.map((d, i) => <li key={`d${i}`}><span className="text-foreground">{d.item}</span> <span className="text-muted">({d.reason})</span></li>)}
        {metrics.map((d, i) => <li key={`m${i}`}><span className="text-foreground">Number &ldquo;{d.metric}&rdquo;</span> <span className="text-muted">(not in that bullet; bullet kept without it)</span></li>)}
      </ul>
    </details>
  );
}
