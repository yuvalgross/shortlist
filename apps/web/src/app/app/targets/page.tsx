import { Suspense } from "react";
import { requireUser } from "@/lib/supabase/user";
import { Card, PageTitle } from "@/components/ui";
import { TargetsForm } from "./targets-form";

export default function TargetsPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageTitle sub="What you are looking for. Scores read the salary floor; the job search in the next gate reads the rest.">Targets</PageTitle>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <Targets />
      </Suspense>
    </div>
  );
}

const join = (a: unknown, sep = ", ") => (Array.isArray(a) ? a.join(sep) : "");

async function Targets() {
  const { supabase } = await requireUser();
  const { data: t } = await supabase.from("targets").select("*").maybeSingle();
  const titles = Array.isArray(t?.titles)
    ? [...t.titles].sort((a, b) => a.priority - b.priority).map((x: { title: string }) => x.title).join("\n")
    : "";
  return (
    <Card>
      <TargetsForm v={{
        titles,
        seniority: t?.seniority ?? "",
        salary_min: t?.salary_min ? String(t.salary_min) : "",
        salary_currency: t?.salary_currency ?? "EUR",
        keep_no_salary: t?.keep_no_salary ?? true,
        industries: join(t?.industries),
        company_blocklist: join(t?.company_blocklist, "\n"),
        exclude_terms: join(t?.exclude_terms),
        required_language_skip: join(t?.required_language_skip),
        open_to_relocation: join(t?.open_to_relocation),
      }} />
    </Card>
  );
}
