import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Browser/RSC-safe client. Returns `null` when env is unset so the dashboard
// can gracefully fall back to local-first JSON mode.
export const supabase: SupabaseClient | null =
  supabaseUrl && supabasePublishableKey
    ? createClient(supabaseUrl, supabasePublishableKey, {
        auth: { persistSession: false },
      })
    : null;

export function isSupabaseConfigured(): boolean {
  return supabase !== null;
}
