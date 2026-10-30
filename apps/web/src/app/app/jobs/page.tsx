import { Suspense } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/supabase/user";
import { Card, PageTitle, Tag, btn } from "@/components/ui";
import { fitLine } from "@/lib/score/rules";
import { ScoreForm } from "./score-form";
import { removePastedJob } from "./actions";

export const maxDuration = 120; // scoring waits for the matching model on this page

type Match = {
  id: string;
  role_fit: number;
  location_points: number;
  total_fit: number;
  factor_points: Record<string, number>;
  factors: Record<string, unknown>;
  flags: string[];
  reasons: { plus?: string[]; minus?: string[] };
  location_note: string | null;
  factor_scores: {
    summary?: string; pay_note?: string; languages?: string[]; dropped?: string[]; location_label?: string | null; shape?: string;
  };
  cv_threshold_applied: number | null;
  created_at: string;
  jobs: { title: string; url: string; location_text: string | null; added_by: string | null; companies: { id: string; name: string; headcount: number | null } | null } | null;
};

const FLAG_WORDS: Record<string, string> = {
  pay_not_stated: "pay not stated",
  pay_below_floor: "pay below your floor",
  pay_likely_below_floor: "pay likely below your floor",
  team_size_unknown: "team size unknown",
  rejected_here_recently: "rejected you in the last 60 days",
};

export default function JobsPage({ searchParams }: PageProps<"/app/jobs">) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <PageTitle sub="Paste one job ad and see how it scores with your profile, targets and rules. Every deduction quotes the ad; anything it cannot quote is dropped.">
        Score a job
      </PageTitle>
      <Card><ScoreForm /></Card>
      <Suspense fallback={<p className="text-muted">Loading your scored jobs…</p>}>
        <Scored searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Scored({ searchParams }: { searchParams: PageProps<"/app/jobs">["searchParams"] }) {
  const { supabase } = await requireUser();
  const params = await searchParams;
  const { data } = await supabase
    .from("job_matches")
    .select("id, role_fit, location_points, total_fit, factor_points, factors, flags, reasons, location_note, factor_scores, cv_threshold_applied, created_at, jobs(title, url, location_text, added_by, companies(id, name, headcount))")
    .order("created_at", { ascending: false })
    .limit(50);
  const matches = (data ?? []) as unknown as Match[];
  const scored = typeof params.scored === "string" ? params.scored : null;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold">Scored jobs</h2>
        <p className="text-sm text-muted">
          Change how scores work in <Link href="/app/targets" className={btn.link}>Targets</Link> and <Link href="/app/rules" className={btn.link}>Rules</Link>. New rules apply to the next score.
        </p>
      </div>
      {params.error === "remove" && <p role="alert" className="text-red-800">Removing failed. Try again.</p>}
      {matches.length === 0 && <p className="text-muted">Nothing scored yet.</p>}
      {matches.map((m) => <MatchCard key={m.id} m={m} highlight={m.id === scored} />)}
    </section>
  );
}

function MatchCard({ m, highlight }: { m: Match; highlight: boolean }) {
  const job = m.jobs;
  const fs = m.factor_scores ?? {};
  const bar = m.cv_threshold_applied;
  const line = fitLine({
    total_fit: Number(m.total_fit), role_fit: Number(m.role_fit), location_points: Number(m.location_points),
    location_label: fs.location_label ?? null, factor_points: m.factor_points ?? {}, factors: m.factors,
  });
  const link = job?.url && /^https?:\/\//.test(job.url) ? job.url : null;
  return (
    <Card className={`flex flex-col gap-3 ${highlight ? "border-accent" : ""}`}>
      <div id={`m-${m.id}`} className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-lg font-semibold">
            {link ? <a href={link} target="_blank" rel="noreferrer" className="hover:underline">{job?.title}</a> : job?.title}
          </h3>
          <p className="text-sm text-muted">
            {job?.companies?.name}{job?.location_text ? ` · ${job.location_text}` : ""}{job?.companies?.headcount ? ` · ${job.companies.headcount} people` : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-semibold tabular-nums">{Number(m.total_fit)}</p>
          {bar != null && (
            Number(m.total_fit) >= Number(bar)
              ? <Tag tone="ok">CLEARS CV BAR {Number(bar)}</Tag>
              : <Tag tone="muted">BELOW CV BAR {Number(bar)}</Tag>
          )}
        </div>
      </div>
      <p className="font-mono text-sm">{line}</p>
      {fs.summary && <p>{fs.summary}</p>}
      <div className="flex flex-wrap gap-2">
        {(m.flags ?? []).map((f) => <Tag key={f} tone="warn">{FLAG_WORDS[f] ?? f.replace(/_/g, " ")}</Tag>)}
        {(fs.languages ?? []).map((l) => <Tag key={l} tone="warn">{l} required</Tag>)}
      </div>
      {(fs.pay_note || m.location_note) && (
        <ul className="text-sm text-muted">
          {m.location_note && <li>Location: {m.location_note}</li>}
          {fs.pay_note && <li>Pay: {fs.pay_note}</li>}
        </ul>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Reasons title="Matches" items={m.reasons?.plus ?? []} />
        <Reasons title="Gaps" items={m.reasons?.minus ?? []} />
      </div>
      {(fs.dropped ?? []).length > 0 && (
        <details className="text-sm text-muted">
          <summary className="cursor-pointer">What the checks removed ({fs.dropped!.length})</summary>
          <ul className="mt-2 list-disc pl-5">{fs.dropped!.map((d) => <li key={d}>{d}</li>)}</ul>
        </details>
      )}
      {job?.added_by && job.companies && (
        <form action={removePastedJob}>
          <input type="hidden" name="company_id" value={job.companies.id} />
          <button type="submit" className={btn.small}>Remove</button>
        </form>
      )}
    </Card>
  );
}

function Reasons({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h4 className="text-sm font-semibold">{title}</h4>
      <ul className="mt-1 list-disc pl-5 text-sm">{items.map((x) => <li key={x}>{x}</li>)}</ul>
    </div>
  );
}
