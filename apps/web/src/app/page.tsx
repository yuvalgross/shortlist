import Link from "next/link";

// Placeholder front page. The real landing and How it works pages come from the approved mockups later.
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 px-4 py-16">
      <h1 className="text-5xl font-semibold leading-tight tracking-tight">Apply to fewer jobs. Land more interviews.</h1>
      <p className="max-w-xl text-lg text-muted">
        Shortlist scores new roles against your real experience and only tailors a CV when the fit is worth your time.
      </p>
      <Link href="/login" className="self-start rounded-lg bg-accent px-6 py-3.5 font-medium text-white">
        Sign in
      </Link>
    </main>
  );
}
