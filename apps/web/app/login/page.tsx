'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Script from 'next/script';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { homeFor, useSession } from '@/lib/session';
import { LanguagePicker } from '@/components/LanguagePicker';

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
        {GOOGLE_CLIENT_ID && !sentTo && (
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
