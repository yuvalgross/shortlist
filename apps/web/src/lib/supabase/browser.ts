import { createBrowserClient } from "@supabase/ssr";

// Browser client, used only to upload the CV file straight into the user's own storage folder.
export function createBrowserSupabase() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
}
