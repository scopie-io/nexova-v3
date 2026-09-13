import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@nexova/db";
import { publicEnv } from "@/lib/env";

/**
 * Supabase client with the secret key. It bypasses RLS, so use it only for work no user can do
 * for themselves: webhooks, the build pipeline, claiming a guest build, admin actions.
 * Always scope its queries by store id yourself.
 */
export function createAdminClient() {
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("SUPABASE_SECRET_KEY is not set.");
  }
  return createClient<Database>(publicEnv.supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
