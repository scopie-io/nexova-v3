import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@nexova/db";
import { publicEnv } from "@/lib/env";

/** Supabase client for Client Components. Acts as the signed-in user, so RLS applies. */
export function createClient() {
  return createBrowserClient<Database>(publicEnv.supabaseUrl, publicEnv.supabasePublishableKey);
}
