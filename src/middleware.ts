import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Skip static assets and the self-hosted engine/pieces/sounds — the
  // engine worker fetches must never detour through auth refresh.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|engine/|pieces/|sounds/).*)",
  ],
};
