'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Script from 'next/script';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { homeFor, useSession } from '@/lib/session';
import { LanguagePicker } from '@/components/LanguagePicker';
import { getSupabase } from '@/lib/supabase';
import { publicEnv } from '@/lib/env';

/** Supabase expects +<country><number>. Ten-digit numbers are taken as Indian mobiles. */
function toPlusNumber(raw: string) {
  const d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.length === 10) return `+91${d}`;
  if (d.length === 12 && d.startsWith('91')) return `+${d}`;
  return `+${d}`;
}

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';

declare global {
  interface Window {
    google?: any;
  }
}

export default function Login() {
  const { t } = useI18n();
  const { signIn, me, loading } = useSession();
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const googleBtn = useRef<HTMLDivElement>(null);
  const [sb, setSb] = useState<ReturnType<typeof getSupabase>>(null);
  useEffect(() => setSb(getSupabase()), []);
  const googleViaSupabase = !!sb && publicEnv('AUTH_GOOGLE') !== 'false';

  useEffect(() => {
    if (!loading && me) router.replace(homeFor(me));
  }, [loading, me, router]);

  async function done(token: string) {
    const m = await signIn(token);
    router.replace(homeFor(m));
  }

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (sb) {
        const plus = toPlusNumber(phone);
        const { error: e2 } = await sb.auth.signInWithOtp({ phone: plus });
        if (e2) throw new Error(e2.status === 429 ? t('login.wait_minute') : t('login.code_failed'));
        setSentTo(plus);
        setDevCode(null);
        return;
      }
      const r = await api<{ phone: string; devCode?: string }>('/auth/otp/request', { body: { phone }, business: false });
      setSentTo(r.phone);
      setDevCode(r.devCode ?? null);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (sb) {
        const { data, error: e2 } = await sb.auth.verifyOtp({ phone: sentTo!, token: code, type: 'sms' });
        if (e2 || !data.session) throw new Error(t('login.code_wrong'));
        await done(data.session.access_token);
        return;
      }
      const r = await api<{ token: string }>('/auth/otp/verify', { body: { phone: sentTo, code }, business: false });
      await done(r.token);
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  }

  function initGoogle() {
    if (!GOOGLE_CLIENT_ID || !window.google || !googleBtn.current) return;
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async (resp: { credential: string }) => {
        try {
          const r = await api<{ token: string }>('/auth/google', { body: { idToken: resp.credential }, business: false });
          await done(r.token);
        } catch (err) {
          setError((err as ApiError).message);
        }
      },
    });
    window.google.accounts.id.renderButton(googleBtn.current, { theme: 'outline', size: 'large', shape: 'pill', width: 320 });
  }

  return (
    <main className="page">
      <div className="row between">
        <strong>Orbit</strong>
        <LanguagePicker compact />
      </div>
      <div className="center stack">
        <h1>{sentTo ? t('login.enter_code') : t('login.title')}</h1>
        {!sentTo ? (
          <form className="stack" onSubmit={requestCode}>
            <div className="field">
              <label htmlFor="phone">{t('login.phone')}</label>
              <input id="phone" className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder="98450 12345" value={phone} onChange={(e) => setPhone(e.target.value)} required />
            </div>
            <button className="btn primary big block" disabled={busy || phone.trim().length < 6}>
              {busy ? t('common.wait') : t('login.send_code')}
            </button>
          </form>
        ) : (
          <form className="stack" onSubmit={verify}>
            <p className="muted">{t('login.code_sent', { phone: sentTo })}</p>
            {devCode && <p className="note">{t('login.dev_code', { code: devCode })}</p>}
            <input aria-label={t('login.code')} className="input code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            <button className="btn primary big block" disabled={busy || code.length !== 6}>
              {busy ? t('common.wait') : t('login.verify')}
            </button>
            <button type="button" className="link-btn" onClick={() => { setSentTo(null); setCode(''); }}>
              {t('login.change_number')}
            </button>
          </form>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {googleViaSupabase && !sentTo && (
          <>
            <p className="muted small" style={{ textAlign: 'center' }}>{t('login.or')}</p>
            <button
              className="btn big block"
              onClick={async () => {
                const { error: e2 } = await sb!.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${window.location.origin}/login` } });
                if (e2) setError(t('login.google_failed'));
              }}
            >
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.3-.4-3.5z"/></svg>
              {t('login.google')}
            </button>
          </>
        )}
        {!sb && GOOGLE_CLIENT_ID && !sentTo && (
          <>
            <p className="muted small" style={{ textAlign: 'center' }}>{t('login.or')}</p>
            <div ref={googleBtn} style={{ display: 'flex', justifyContent: 'center' }} />
            <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onLoad={initGoogle} />
          </>
        )}
        <p className="small muted">{t('login.terms')}</p>
      </div>
    </main>
  );
}
