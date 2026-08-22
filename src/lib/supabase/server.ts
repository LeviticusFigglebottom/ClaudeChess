import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseUrl } from "./env";

/** Server-side Supabase client for route handlers and server components. */
export async function createClient() {
  const url = supabaseUrl();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set — see .env.example");
  }
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — session refresh is handled by middleware.
        }
      },
    },
  });
}
