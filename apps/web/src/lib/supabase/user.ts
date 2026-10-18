import "server-only";
import { redirect } from "next/navigation";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "./server";
import { supabaseEnv } from "./env";

// The signed in user, or a redirect to sign in. Every query through `supabase` is limited by row level security.
export async function requireUser() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) redirect("/login");
  return { supabase, userId: String(userId), email: String(data.claims.email ?? "") };
}

// A client that keeps acting as this user after the response has been sent (background CV reading).
// It carries the user's own access token, so it can only reach this user's rows and files.
// If the token would expire within `minSecondsLeft`, it is refreshed first, so a long job does not lose access halfway.
export async function backgroundClientFor(supabase: SupabaseClient, minSecondsLeft = 0): Promise<SupabaseClient> {
  let { data } = await supabase.auth.getSession();
  const expiresAt = data.session?.expires_at ?? 0;
  if (data.session && expiresAt - Math.floor(Date.now() / 1000) < minSecondsLeft) {
    const refreshed = await supabase.auth.refreshSession();
    if (refreshed.data.session) data = refreshed.data;
  }
  const token = data.session?.access_token;
  if (!token) throw new Error("No session token for background work");
  const { url, key } = supabaseEnv();
  return createSupabaseClient(url, key, { accessToken: async () => token });
}
