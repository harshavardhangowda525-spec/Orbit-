'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { publicEnv } from './env';

let client: SupabaseClient | null | undefined;

/** Supabase Auth client, or null when this deployment uses Orbit's own sign-in. */
export function getSupabase(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = publicEnv('SUPABASE_URL');
  const key = publicEnv('SUPABASE_ANON_KEY');
  client = url && key ? createClient(url, key, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }) : null;
  return client;
}

/** The current Supabase access token (refreshed automatically by supabase-js). */
export async function supabaseToken(): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}
