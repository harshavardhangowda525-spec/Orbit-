'use client';

import './space.css';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { homeFor, useSession } from '@/lib/session';
import { getSupabase } from '@/lib/supabase';
import { publicEnv } from '@/lib/env';
import { usePageVisible } from '@/lib/motion';
import { SpaceBackdrop } from '@/components/SpaceBackdrop';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Sign in with an emailed 6-digit code (or Google).
 * Hosted: Supabase Auth sends and checks the code. Local development: Orbit's own
 * API does, and shows the code on screen in test mode.
 */
export default function Login() {
  const { t, lang, setLang, languages } = useI18n();
  const { signIn, me, loading } = useSession();
  const router = useRouter();
  const visible = usePageVisible();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sb, setSb] = useState<ReturnType<typeof getSupabase>>(null);
  useEffect(() => setSb(getSupabase()), []);
  const showGoogle = !!sb && publicEnv('AUTH_GOOGLE') !== 'false';
  // On a hosted site, sign-in needs Supabase and the API address; say which setting is missing instead of failing later.
  const [setupProblem, setSetupProblem] = useState<string | null>(null);
  useEffect(() => {
    if (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) return;
    const missing = [!publicEnv('SUPABASE_URL') && 'SUPABASE_URL', !publicEnv('SUPABASE_ANON_KEY') && 'SUPABASE_ANON_KEY', !publicEnv('API_URL') && 'ORBIT_API_URL'].filter(Boolean);
    if (missing.length) setSetupProblem(`Sign-in is not set up on this site yet. Add ${missing.join(', ')} in Render (orbit-web → Environment), then redeploy.`);
  }, []);

  useEffect(() => {
    if (!loading && me) router.replace(homeFor(me));
  }, [loading, me, router]);

  async function done(token: string) {
    const m = await signIn(token);
    router.replace(homeFor(m));
  }

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    const addr = email.trim().toLowerCase();
    if (!EMAIL_RE.test(addr)) return setError(t('login.email_invalid'));
    setBusy(true);
    setError(null);
    try {
      if (sb) {
        const { error: e2 } = await sb.auth.signInWithOtp({ email: addr, options: { shouldCreateUser: true } });
        if (e2) throw new Error(e2.status === 429 ? t('login.wait_minute') : t('login.email_failed'));
        setDevCode(null);
      } else {
        const r = await api<{ email: string; devCode?: string }>('/auth/email/request', { body: { email: addr }, business: false });
        setDevCode(r.devCode ?? null);
      }
      setSentTo(addr);
      setCode('');
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
        const { data, error: e2 } = await sb.auth.verifyOtp({ email: sentTo!, token: code, type: 'email' });
        if (e2 || !data.session) throw new Error(t('login.code_wrong'));
        await done(data.session.access_token);
        return;
      }
      const r = await api<{ token: string }>('/auth/email/verify', { body: { email: sentTo, code }, business: false });
      await done(r.token);
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  }

  return (
    <main className={`space-page ${visible ? '' : 'paused'}`}>
      <SpaceBackdrop />
      <div className="top">
        <div className="brand">Orbit</div>
        <select className="lang-glass" aria-label={t('common.language')} value={lang} onChange={(e) => setLang(e.target.value)}>
          {languages.map((l) => (
            <option key={l.code} value={l.code}>{l.nativeName}</option>
          ))}
        </select>
      </div>

      <div className="glass-wrap">
        <section className="glass">
          <div className="mark" aria-hidden>
            <div className="ring" />
            <div className="core" />
            <div className="spin"><i /></div>
          </div>

          {!sentTo ? (
            <>
              <h1>{t('login.welcome')}</h1>
              <p className="sub">{t('login.tagline')}</p>
              <form onSubmit={requestCode} noValidate>
                <label htmlFor="email">{t('login.email')}</label>
                <input
                  id="email" className="glass-input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
                  placeholder="you@yourbusiness.com" value={email} onChange={(e) => setEmail(e.target.value)} required
                />
                <button className="glass-btn" disabled={busy || !email.includes('@')}>{busy ? t('common.wait') : t('login.send_code')}</button>
              </form>
              {showGoogle && (
                <>
                  <div className="or">{t('login.or')}</div>
                  <button
                    className="glass-btn ghost"
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
            </>
          ) : (
            <>
              <h1>{t('login.check_email')}</h1>
              <p className="sub">{t('login.code_sent_email', { email: sentTo })}</p>
              {devCode && <p className="info">{t('login.dev_code', { code: devCode })}</p>}
              <form onSubmit={verify}>
                <label htmlFor="code">{t('login.code')}</label>
                <input
                  id="code" className="glass-input code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
                  value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
                <button className="glass-btn" disabled={busy || code.length !== 6}>{busy ? t('common.wait') : t('login.verify')}</button>
              </form>
              <button className="link" onClick={() => { setSentTo(null); setCode(''); setError(null); }}>{t('login.change_email')}</button>
            </>
          )}
          {(error || setupProblem) && <p className="msg" role="alert">{error ?? setupProblem}</p>}
          <p className="terms">{t('login.terms')}</p>
        </section>
      </div>
    </main>
  );
}
