import { Suspense } from "react";
import { requireUser } from "@/lib/supabase/user";
import { PageTitle, Steps } from "@/components/ui";
import { UploadForm } from "./upload-form";

// Reading a CV can take a minute or two; the background work inherits this limit.
export const maxDuration = 300;

export default function UploadPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <Steps current={0} />
      <div className="grid gap-10 md:grid-cols-[1fr_1.3fr]">
        <div className="flex flex-col gap-4">
          <PageTitle sub="We read it into a structured profile: roles, dates, tools and results. You check everything on the next screen before anything is used.">
            Start with the CV you already have
          </PageTitle>
          <ul className="list-disc pl-5 text-sm leading-7 text-muted">
            <li>Your most complete version works best, not a one page cut</li>
            <li>Every fact we keep shows the line of your CV it came from</li>
            <li>Nothing is added that your CV does not say</li>
          </ul>
        </div>
        <Suspense fallback={<p className="text-muted">Loading…</p>}>
          <Form />
        </Suspense>
      </div>
    </div>
  );
}

async function Form() {
  const { userId } = await requireUser();
  return <UploadForm userId={userId} />;
}
