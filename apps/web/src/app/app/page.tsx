import { Suspense } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/supabase/user";
import { Card, PageTitle, Tag } from "@/components/ui";

export default function AppHome() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <Home />
      </Suspense>
    </div>
  );
}

async function Home() {
  const { supabase, email } = await requireUser();
  const [{ data: upload }, { count: stories }, { count: withNumber }, { count: claims }] = await Promise.all([
    supabase.from("cv_uploads").select("parse_status").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("stories").select("id", { count: "exact", head: true }).eq("status", "confirmed"),
    supabase.from("stories").select("id", { count: "exact", head: true }).eq("status", "confirmed").not("result_metric", "is", null),
    supabase.from("not_on_record").select("id", { count: "exact", head: true }),
  ]);
  const status = upload?.parse_status as string | undefined;
  const items = [
    { href: "/app/upload", title: "Upload your CV", done: Boolean(status), note: status ? `Last upload: ${status}` : "Not done yet" },
    { href: "/app/profile", title: "Check your profile", done: status === "confirmed", note: status === "parsed" ? "Waiting for your review" : status === "confirmed" ? "Confirmed" : "After the upload" },
    { href: "/app/proof", title: "Complete your proof bank", done: (stories ?? 0) > 0 && withNumber === stories, note: `${withNumber ?? 0} of ${stories ?? 0} results have a number` },
    { href: "/app/proof", title: "Not on your record", done: (claims ?? 0) > 0, note: `${claims ?? 0} items` },
  ];
  return (
    <>
      <PageTitle sub={`Signed in as ${email}. Job targets, scoring and the daily queue arrive in the next gates.`}>Set up your profile</PageTitle>
      <div className="grid gap-4 sm:grid-cols-2">
        {items.map((i) => (
          <Link key={i.title} href={i.href}>
            <Card className="flex h-full flex-col gap-2 hover:border-accent">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold">{i.title}</h2>
                {i.done ? <Tag tone="ok">DONE</Tag> : <Tag tone="muted">TO DO</Tag>}
              </div>
              <p className="text-sm text-muted">{i.note}</p>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
