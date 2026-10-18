import { Suspense } from "react";
import { quickSignIn, sendMagicLink } from "./actions";

// TEMPORARY: the Skip sign in button shows only while both server settings exist (see quickSignIn).
const quickSignInEnabled = () => Boolean(process.env.QUICK_SIGNIN_EMAIL && process.env.QUICK_SIGNIN_PASSWORD);

const messages: Record<string, string> = {
  email: "Enter a valid email address.",
  send: "We couldn't send the link. Try again in a minute.",
  limit: "Too many sign in emails were sent in the last hour. Use the link in your most recent email, or try again later.",
  link: "That sign in link has expired or was already used. Request a new one.",
  quick: "Skip sign in did not work. Use the email link instead.",
};

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to Shortlist</h1>
        <Suspense fallback={<p className="mt-4 text-muted">Loading…</p>}>
          <LoginForm searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

async function LoginForm({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? messages[params.error] : undefined;
  const next = typeof params.next === "string" ? params.next : "/app";

  if (params.sent === "1") {
    return <p className="mt-4 text-muted">Check your inbox. The link signs you in on this device.</p>;
  }
  return (
    <form action={sendMagicLink} className="mt-6 flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-1.5 text-sm text-muted">
        Email
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          className="rounded-lg border border-line px-3 py-2.5 text-base text-foreground"
        />
      </label>
      {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
      <button type="submit" className="rounded-lg bg-accent px-4 py-3 font-medium text-white">
        Email me a sign in link
      </button>
      {/* TEMPORARY: testing shortcut, see quickSignIn in actions.ts */}
      {quickSignInEnabled() && (
        <button formAction={quickSignIn} formNoValidate className="rounded-lg border border-line px-4 py-3 text-sm">
          Skip sign in (temporary)
        </button>
      )}
    </form>
  );
}
