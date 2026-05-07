import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
// Service-role key is REQUIRED to use the Supabase backend — without it we
// can't do writes anyway, so fall back to the local-JSON store. This means a
// publishable key in .env.local doesn't accidentally route writes to a
// not-yet-provisioned database. NEVER expose SERVICE_ROLE_KEY to the browser.
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let client: SupabaseClient | null = null;
if (url && serviceKey) {
  client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function getServerSupabase(): SupabaseClient | null {
  return client;
}

export function hasServerSupabase(): boolean {
  return client !== null;
}
