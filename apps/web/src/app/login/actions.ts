"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Only same-site paths are allowed after login, so the link can't bounce people to another site.
function safeNext(value: FormDataEntryValue | null) {
  const next = typeof value === "string" ? value : "";
  return next.startsWith("/app") ? next : "/app";
}

export async function sendMagicLink(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect("/login?error=email");

  // Prefer the configured site address; Supabase also only accepts redirect URLs on its allow list.
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? (await headers()).get("origin") ?? "";
  const next = safeNext(formData.get("next"));
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  if (error) {
    const limited = error.code === "over_email_send_rate_limit" || error.status === 429;
    redirect(limited ? "/login?error=limit" : "/login?error=send");
  }
  redirect("/login?sent=1");
}

// TEMPORARY (Yuval's testing shortcut). Delete this function, the button on the login page and the two
// QUICK_SIGNIN_* variables in Vercel before the site is opened to anyone else. The password lives only in
// Vercel's server settings; the button never sees it.
export function quickSignInEnabled() {
  return Boolean(process.env.QUICK_SIGNIN_EMAIL && process.env.QUICK_SIGNIN_PASSWORD);
}

export async function quickSignIn(formData: FormData) {
  const email = process.env.QUICK_SIGNIN_EMAIL;
  const password = process.env.QUICK_SIGNIN_PASSWORD;
  if (!email || !password) redirect("/login");
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect("/login?error=quick");
  redirect(safeNext(formData.get("next")));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
