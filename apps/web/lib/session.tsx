'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, session } from './api';
import { getSupabase } from './supabase';

export interface MeBusiness {
  id: string;
  name: string;
  slug: string;
  type: string;
  status: string;
  onboarding_step: number;
  role: 'owner' | 'manager' | 'staff';
}
export interface Me {
  user: { id: string; name: string | null; phone: string | null; email: string | null; language: string; isPlatformAdmin: boolean };
  businesses: MeBusiness[];
  impersonation: { adminId: string; businessId: string } | null;
}

interface SessionCtx {
  me: Me | null;
  loading: boolean;
  business: MeBusiness | null;
  refresh: () => Promise<Me | null>;
  signIn: (token: string) => Promise<Me | null>;
  signOut: () => void;
  chooseBusiness: (id: string) => void;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [businessId, setBusinessId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!session.token()) {
      setMe(null);
      setLoading(false);
      return null;
    }
    try {
      const m = await api<Me>('/auth/me', { business: false });
      setMe(m);
      let id = session.businessId();
      if (!id || !m.businesses.some((b) => b.id === id)) {
        id = m.impersonation?.businessId ?? m.businesses[0]?.id ?? null;
        session.setBusinessId(id);
      }
      setBusinessId(id);
      return m;
    } catch {
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) {
      refresh();
      return;
    }
    // Supabase Auth: mirror the access token for the API and live updates; refresh on every sign-in change.
    sb.auth.getSession().then(({ data }) => {
      session.setToken(data.session?.access_token ?? null);
      refresh();
    });
    const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
      session.setToken(s?.access_token ?? null);
      if (event !== 'TOKEN_REFRESHED') refresh();
    });
    return () => sub.subscription.unsubscribe();
  }, [refresh]);

  const value: SessionCtx = {
    me,
    loading,
    business: me?.businesses.find((b) => b.id === businessId) ?? null,
    refresh,
    signIn: async (token) => {
      session.setToken(token);
      return refresh();
    },
    signOut: () => {
      getSupabase()?.auth.signOut().catch(() => undefined);
      session.clear();
      setMe(null);
      setBusinessId(null);
      window.location.href = '/login';
    },
    chooseBusiness: (id) => {
      session.setBusinessId(id);
      setBusinessId(id);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** Where a signed-in owner should land. */
export function homeFor(m: Me | null): string {
  if (!m) return '/login';
  if (m.impersonation) return '/bridge';
  const b = m.businesses.find((x) => x.id === session.businessId()) ?? m.businesses[0];
  if (!b) return '/onboarding';
  return b.status === 'onboarding' ? '/onboarding' : '/bridge';
}
