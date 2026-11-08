'use client';

declare global {
  interface Window {
    __ORBIT_ENV?: Record<string, string>;
  }
}

const BUILD: Record<string, string | undefined> = {
  API_URL: process.env.NEXT_PUBLIC_API_URL,
  SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  AUTH_GOOGLE: process.env.NEXT_PUBLIC_AUTH_GOOGLE,
};

/** A public setting: from /runtime-config (hosting) first, then build-time NEXT_PUBLIC_* (local dev). */
export function publicEnv(key: 'API_URL' | 'SUPABASE_URL' | 'SUPABASE_ANON_KEY' | 'AUTH_GOOGLE'): string {
  const runtime = typeof window !== 'undefined' ? window.__ORBIT_ENV?.[key] : undefined;
  return runtime || BUILD[key] || '';
}
