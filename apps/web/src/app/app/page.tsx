import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "../login/actions";

// Signed in home. Gate 0 only proves login and data isolation work end to end;
// onboarding (Gate 1) and the review queue come later.
export default function AppHome() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-12">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Shortlist</h1>
        <form action={signOut}>
          <button type="submit" className="rounded-lg border border-line px-4 py-2.5 text-sm">
            Sign out
          </button>
        </form>
      </div>
      <Suspense fallback={<section className="rounded-xl border border-line bg-surface p-6 text-muted">Loading…</section>}>
        <Account />
      </Suspense>
    </main>
  );
}

async function Account() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) redirect("/login");

  // Reads through row level security: returns this user's row or nothing.
  const { data: profile } = await supabase.from("profiles").select("full_name").maybeSingle();

  return (
    <section className="rounded-xl border border-line bg-surface p-6">
      <p className="text-muted">Signed in as {String(claims.email ?? "")}</p>
      <p className="mt-2">
        {profile?.full_name ? `Profile found for ${profile.full_name}.` : "No profile yet. Onboarding arrives in Gate 1."}
      </p>
    </section>
  );
}
