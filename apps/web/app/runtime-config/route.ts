/**
 * Public settings for the browser, read from the server's environment at request
 * time (so one Docker image works on any host). Only values that are safe to be
 * public belong here: never secrets.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  const env = {
    API_URL: process.env.ORBIT_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? '',
    SUPABASE_URL: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    // Supabase's publishable ("anon") key is designed to be public.
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    AUTH_GOOGLE: process.env.AUTH_GOOGLE ?? 'true',
  };
  return new Response(`window.__ORBIT_ENV=${JSON.stringify(env).replace(/</g, '\\u003c')};`, {
    headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=60' },
  });
}
