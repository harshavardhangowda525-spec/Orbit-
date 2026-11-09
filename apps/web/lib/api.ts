'use client';

import { publicEnv } from './env';
import { getSupabase, supabaseToken } from './supabase';

/** API address: runtime setting on hosted deployments, localhost in development. */
export function apiUrl(): string {
  return publicEnv('API_URL') || 'http://localhost:4000';
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const TOKEN = 'orbit.token';
const BUSINESS = 'orbit.business';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    /* private mode: session-only */
  }
}

export const session = {
  token: () => read(TOKEN),
  setToken: (t: string | null) => write(TOKEN, t),
  businessId: () => read(BUSINESS),
  setBusinessId: (id: string | null) => write(BUSINESS, id),
  clear: () => {
    write(TOKEN, null);
    write(BUSINESS, null);
  },
};

/** Call the Orbit API. Errors come back as ApiError with a plain-language message. */
async function authHeaders(business = true): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // With Supabase Auth, always send a fresh access token (supabase-js refreshes it).
  if (getSupabase()) {
    const fresh = await supabaseToken();
    if (fresh && fresh !== session.token()) session.setToken(fresh);
  }
  const token = session.token();
  if (token) headers.authorization = `Bearer ${token}`;
  const biz = session.businessId();
  if (business && biz) headers['x-business-id'] = biz;
  return headers;
}

/**
 * POST and read the answer line by line (NDJSON) as the server writes it, so the
 * screen can show each step while it happens.
 */
export async function apiStream(path: string, body: unknown, onEvent: (e: any) => void): Promise<void> {
  const headers = { ...(await authHeaders()), accept: 'application/x-ndjson' };
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'unreachable', 'Orbit could not reach its server. If it was asleep, wait about a minute and try again.');
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Something went wrong. Please try again.');
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
    if (done) break;
  }
  if (buf.trim()) onEvent(JSON.parse(buf));
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; business?: boolean } = {}): Promise<T> {
  const headers = await authHeaders(opts.business !== false);
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}${path}`, { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  } catch {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ApiError(0, 'offline', 'No internet connection. Please check your network and try again.');
    // Online but the API did not answer: asleep (free hosting), restarting, or not set up yet.
    throw new ApiError(0, 'unreachable', 'Orbit could not reach its server. If it was asleep, wait about a minute and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !getSupabase()) session.setToken(null);
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Something went wrong. Please try again.');
  }
  return data as T;
}
