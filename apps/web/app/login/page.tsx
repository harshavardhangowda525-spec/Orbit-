'use client';

import './space.css';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, session } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { homeFor, useSession } from '@/lib/session';
import { getSupabase } from '@/lib/supabase';
import { publicEnv } from '@/lib/env';
import { usePageVisible } from '@/lib/motion';
import { SpaceBackdrop } from '@/components/SpaceBackdrop';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PASSWORD_MIN = 8;

type Mode = 'login' | 'signup' | 'reset';

/**
 * Log in or sign up with email + password, or with Google.
 * Hosted: Supabase Auth (it emails the confirmation and reset links).
 * Local development: Orbit's own API.
 */
export default function Login() {
  const { t, lang, setLang, languages } = useI18n();
  const { signIn, me, loading } = useSession();
  const router = useRouter();
  const visible = usePageVisible();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
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

  // Coming back from an email link: "?reset=1" opens the new-password form; an expired link says so.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const h = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (q.get('reset') === '1') setMode('reset');
    if (q.get('error') || h.get('error')) setError(t('login.link_expired'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loading && me && mode !== 'reset') router.replace(homeFor(me));
  }, [loading, me, mode, router]);

  function switchTo(m: Mode) {
    setMode(m);
    setError(null);
    setInfo(null);
  }

  async function done(token: string) {
    // Ask the API first, so a reason such as "confirm your email first" is shown here.
    session.setToken(token);
    await api('/auth/me', { business: false });
    const m = await signIn(token);
    router.replace(homeFor(m));
  }

  function check(): string | null {
    const addr = email.trim().toLowerCase();
    if (!EMAIL_RE.test(addr)) return t('login.email_invalid');
    if (password.length < PASSWORD_MIN) return t('login.password_short');
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = check();
    if (problem) return setError(problem);
    const addr = email.trim().toLowerCase();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (sb) {
        if (mode === 'signup') {
          const { data, error: e2 } = await sb.auth.signUp({ email: addr, password, options: { emailRedirectTo: `${window.location.origin}/login` } });
          if (e2) throw new Error(e2.status === 429 ? t('login.wait_minute') : /registered|exists/i.test(e2.message) ? t('login.account_exists') : e2.message);
          if (data.session) return await done(data.session.access_token);
          // Email confirmation is on: Supabase sent a link.
          setInfo(t('login.confirm_sent', { email: addr }));
          setMode('login');
          setPassword('');
          return;
        }
        const { data, error: e2 } = await sb.auth.signInWithPassword({ email: addr, password });
        if (e2) {
          if (/confirm/i.test(e2.message)) throw new Error(t('login.not_confirmed'));
          throw new Error(e2.status === 429 ? t('login.wait_minute') : t('login.wrong_password'));
        }
        return await done(data.session!.access_token);
      }
      const r = await api<{ token: string }>(mode === 'signup' ? '/auth/signup' : '/auth/login', { body: { email: addr, password }, business: false });
      await done(r.token);
    } catch (err) {
      const e2 = err as ApiError;
      setError(e2.code === 'wrong_password' ? t('login.wrong_password') : e2.code === 'account_exists' ? t('login.account_exists') : e2.message);
    } finally {
      setBusy(false);
    }
  }

  async function forgot() {
    const addr = email.trim().toLowerCase();
    if (!EMAIL_RE.test(addr)) return setError(t('login.reset_email_first'));
    setError(null);
    const { error: e2 } = await sb!.auth.resetPasswordForEmail(addr, { redirectTo: `${window.location.origin}/login?reset=1` });
    if (e2?.status === 429) return setError(t('login.wait_minute'));
    // Same answer whether or not the account exists.
    setInfo(t('login.reset_sent', { email: addr }));
  }

  async function saveNewPassword(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < PASSWORD_MIN) return setError(t('login.password_short'));
    setBusy(true);
    setError(null);
    try {
      const { data, error: e2 } = await sb!.auth.updateUser({ password });
      if (e2) throw new Error(/session/i.test(e2.message) ? t('login.link_expired') : e2.message);
      const { data: s } = await sb!.auth.getSession();
      window.history.replaceState(null, '', '/login');
      if (s.session && data.user) await done(s.session.access_token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
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

          {mode === 'reset' ? (
            <>
              <h1>{t('login.new_password_title')}</h1>
              <form onSubmit={saveNewPassword} noValidate>
                <label htmlFor="new-password">{t('login.new_password')}</label>
                <input id="new-password" className="glass-input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <p className="hint">{t('login.password_hint')}</p>
                <button className="glass-btn" disabled={busy || !password}>{busy ? t('common.wait') : t('login.save_password')}</button>
              </form>
            </>
          ) : (
            <>
              <h1>{mode === 'signup' ? t('login.signup_title') : t('login.welcome')}</h1>
              <p className="sub">{t('login.tagline')}</p>
              <div className="tabs" role="tablist">
                <button role="tab" aria-selected={mode === 'login'} onClick={() => switchTo('login')}>{t('login.tab_login')}</button>
                <button role="tab" aria-selected={mode === 'signup'} onClick={() => switchTo('signup')}>{t('login.tab_signup')}</button>
              </div>
              <form onSubmit={submit} noValidate>
                <label htmlFor="email">{t('login.email')}</label>
                <input
                  id="email" className="glass-input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
                  placeholder="you@yourbusiness.com" value={email} onChange={(e) => setEmail(e.target.value)} required
                />
                <label htmlFor="password" className="gap">{t('login.password')}</label>
                <input
                  id="password" className="glass-input" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  value={password} onChange={(e) => setPassword(e.target.value)} required
                />
                {mode === 'signup' && <p className="hint">{t('login.password_hint')}</p>}
                <button className="glass-btn" disabled={busy || !email.includes('@') || !password}>
                  {busy ? t('common.wait') : mode === 'signup' ? t('login.create_account') : t('login.log_in')}
                </button>
              </form>
              {mode === 'login' && sb && <button className="link" onClick={forgot}>{t('login.forgot')}</button>}
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
              <button className="link small" onClick={() => switchTo(mode === 'login' ? 'signup' : 'login')}>
                {mode === 'login' ? t('login.no_account') : t('login.have_account')}
              </button>
            </>
          )}
          {info && <p className="info" role="status">{info}</p>}
          {(error || setupProblem) && <p className="msg" role="alert">{error ?? setupProblem}</p>}
          <p className="terms">{t('login.terms')}</p>
        </section>
      </div>
    </main>
  );
}
