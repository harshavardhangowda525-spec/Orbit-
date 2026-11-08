'use client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

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
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; business?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = session.token();
  if (token) headers.authorization = `Bearer ${token}`;
  const biz = session.businessId();
  if (opts.business !== false && biz) headers['x-business-id'] = biz;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new ApiError(0, 'offline', 'No internet connection. Please check your network and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) session.setToken(null);
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Something went wrong. Please try again.');
  }
  return data as T;
}
