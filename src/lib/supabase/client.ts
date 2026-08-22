import { createBrowserClient } from "@supabase/ssr";
import { supabaseUrl } from "./env";

/** Browser-side Supabase client (auth + realtime). */
export function createClient() {
  const url = supabaseUrl();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set — see .env.example");
  }
  return createBrowserClient(url, anonKey);
}
