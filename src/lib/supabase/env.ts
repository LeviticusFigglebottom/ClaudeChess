/**
 * NEXT_PUBLIC_SUPABASE_URL, normalized. The Supabase dashboard shows the
 * project's REST endpoint as "https://<ref>.supabase.co/rest/v1/", and that
 * exact string routinely ends up pasted into the env var — supabase-js then
 * builds paths like /rest/v1/auth/v1/signup and every auth call fails with
 * "Invalid path specified in request URL" (found live on the first Vercel
 * deployment). The client wants the bare project origin, so trim any
 * accidental service suffix and trailing slashes here, in the one place the
 * URL is read.
 *
 * Kept as a full static `process.env.NEXT_PUBLIC_SUPABASE_URL` expression so
 * Next.js inlines the value into client bundles.
 */
export function supabaseUrl(): string | undefined {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return undefined;
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(rest|auth|realtime|storage|functions)\/v1$/, "")
    .replace(/\/+$/, "") || undefined;
}
