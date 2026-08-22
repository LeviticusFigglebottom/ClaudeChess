import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseUrl } from "./env";

/**
 * Session refresh for @supabase/ssr: keeps the auth token cookie fresh so
 * server components and route handlers always see a valid session. When the
 * Supabase env is absent (offline/local dev without accounts) this is a
 * clean pass-through — the app runs in local-only mode.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const url = supabaseUrl();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let response = NextResponse.next({ request });
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Refreshes the token if expired; the result itself is not needed here.
  await supabase.auth.getUser();
  return response;
}
