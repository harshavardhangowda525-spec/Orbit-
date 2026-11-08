'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { apiUrl } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/** Customer's own booking: see it, move it or cancel it within the business's policy. */
export default function ManageBooking() {
  const { token } = useParams<{ token: string }>();
  const { t, lang } = useI18n();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState<{ start: string }[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const call = useCallback(async (path: string, body?: object) => {
    const res = await fetch(`${apiUrl()}/public/manage/${encodeURIComponent(token)}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d?.error?.message ?? t('chat.error'));
    return d;
  }, [token, t]);
  const load = useCallback(() => call('').then(setData).catch((e) => setError(e.message)), [call]);
  useEffect(() => {
    load();
  }, [load]);

  const tz = data?.business.timezone;
  const fmt = (iso: string) => new Intl.DateTimeFormat(lang === 'en' ? 'en-IN' : `${lang}-IN`, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(done);
      setSlots(null);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      {error && <div className="card empty">{error}</div>}
      {data && (
        <section className="stack" data-testid="manage">
          <div className="label" style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' }}>{data.business.name}</div>
          <h1>{data.booking.service}</h1>
          <div className="card stack" style={{ gap: 6 }}>
            <b>{fmt(data.booking.start)}</b>
            {data.booking.staff && <span className="muted">{t('manage.with', { name: data.booking.staff })}</span>}
            <span className="small muted">{t(`manage.status.${data.booking.status}`)}</span>
          </div>
          {msg && <p className="note">{msg}</p>}
          {data.canChange ? (
            <>
              {!slots ? (
                <button className="btn block" disabled={busy} onClick={() => call('/slots').then(setSlots)}>{t('manage.reschedule')}</button>
              ) : (
                <div className="card stack">
                  <b>{t('book.pick_time')}</b>
                  <div className="slot-grid">
                    {slots.slice(0, 18).map((s) => (
                      <button key={s.start} className="btn small" disabled={busy} onClick={() => act(() => call('/reschedule', { start: s.start }), t('manage.moved'))}>
                        {new Intl.DateTimeFormat(lang, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(s.start))}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button className="btn block" disabled={busy} onClick={() => confirm(t('manage.confirm_cancel')) && act(() => call('/cancel', {}), t('manage.cancelled'))}>{t('manage.cancel')}</button>
            </>
          ) : (
            ['pending', 'confirmed'].includes(data.booking.status) && <p className="muted small">{t('manage.too_late', { hours: data.policyHours })}</p>
          )}
          <a className="link-btn" href={`/${data.business.slug}`}>{t('manage.back', { business: data.business.name })}</a>
        </section>
      )}
    </main>
  );
}
