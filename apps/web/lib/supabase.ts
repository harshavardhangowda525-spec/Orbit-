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

/**
 * A Supabase access token that is valid for at least another minute. supabase-js
 * refreshes on a timer, but a tab that slept (phone locked, laptop closed) can wake
 * with an expired token, so refresh here when it is about to run out.
 */
export async function supabaseToken(force = false): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  const s = data.session;
  if (!s) return null;
  const expiresAt = (s.expires_at ?? 0) * 1000;
  if (!force && expiresAt - Date.now() > 60_000) return s.access_token;
  const { data: r, error } = await sb.auth.refreshSession();
  if (error || !r.session) return null;
  return r.session.access_token;
}
