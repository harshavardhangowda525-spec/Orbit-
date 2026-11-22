'use client';

import { useEffect, useState } from 'react';
import type { TeachAffectedChoice, TeachPreview } from '@orbit/shared';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import './teach.css';

type Loaded = TeachPreview & { appliedAt?: string | null };

/**
 * What a Teach instruction will change: each line before → after, from which
 * date, the bookings it touches (keep, or message the customer), and anything
 * that did not add up. Nothing is saved until Save; Undo puts it all back.
 */
export function TeachCard({ id, initial, onDone }: { id: string; initial?: TeachPreview; onDone?: () => void }) {
  const { t, ts, lang } = useI18n();
  const [p, setP] = useState<Loaded | null>(initial ?? null);
  const [choices, setChoices] = useState<Record<string, TeachAffectedChoice>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!initial) api<Loaded>(`/teach/${id}`).then(setP).catch((e) => setError((e as ApiError).message));
  }, [id, initial]);

  const loc = lang === 'en' ? 'en-IN' : `${lang}-IN`;
  const day = (d: string) => new Intl.DateTimeFormat(loc, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
  const when = (iso: string) => new Intl.DateTimeFormat(loc, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Loaded & { messaged?: number }>(`/teach/${id}/confirm`, { body: { choices } });
      setP(r);
      setMsg(r.status === 'needs_owner' ? t('teach.sent_to_owner') : r.messaged ? t('teach.saved_messaged', { count: r.messaged }) : t('teach.saved'));
      onDone?.();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    await api(`/teach/${id}/cancel`, { method: 'POST' }).catch(() => null);
    setP((x) => (x ? { ...x, status: 'cancelled' } : x));
  }
  async function undo() {
    setBusy(true);
    try {
      await api(`/teach/${id}/undo`, { method: 'POST' });
      setP((x) => (x ? { ...x, status: 'cancelled' } : x));
      setMsg(t('teach.undone'));
      onDone?.();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !p) return <p className="error small">{error}</p>;
  if (!p) return <div className="teach-card thinking">{t('teach.thinking')}</div>;
  if (p.status === 'question') return <div className="teach-card" data-testid="teach-question"><b>{p.question}</b>{p.conflicts.map((c, i) => <p key={i} className="small teach-conflict">{ts(c)}</p>)}</div>;
  if (p.status === 'not_teach') return <div className="teach-card small muted" data-testid="teach-not">{t('teach.not_teach')}</div>;

  const open = p.status === 'preview';
  const allMessage = p.affected.length > 0 && p.affected.every((a) => choices[a.bookingId] === 'message');
  return (
    <div className="teach-card" data-testid="teach-card" data-status={p.status}>
      <b className="teach-title">{t('teach.preview_title')}</b>
      <ul className="teach-lines">
        {p.lines.map((l, i) => (
          <li key={i} data-testid="teach-line">
            {(l.from || l.to) && (
              <span className="teach-when">{l.to ? t('teach.from_to', { from: day(l.from!), to: day(l.to) }) : l.type === 'add_closure' || l.type === 'staff_leave' ? t('teach.on', { date: day(l.from!) }) : t('teach.from', { date: day(l.from!) })}</span>
            )}
            {l.before && <span className="teach-before"><small>{t('teach.now')}</small> {ts(l.before)}</span>}
            <span className="teach-after"><small>{t('teach.new')}</small> {ts(l.after)}</span>
          </li>
        ))}
      </ul>
      {p.conflicts.length > 0 && (
        <div className="teach-conflicts">
          <b className="small">{t('teach.check')}</b>
          {p.conflicts.map((c, i) => <p key={i} className="small teach-conflict">{ts(c)}</p>)}
        </div>
      )}
      {p.affected.length > 0 && (
        <div className="teach-affected" data-testid="teach-affected">
          <div className="row between">
            <b className="small">{t('teach.affected', { count: p.affected.length })}</b>
            {open && (
              <button className="link-btn small" onClick={() => setChoices(Object.fromEntries(p.affected.map((a) => [a.bookingId, allMessage ? 'keep' : 'message'])))}>
                {allMessage ? t('teach.keep') : t('teach.message_all')}
              </button>
            )}
          </div>
          {p.affected.map((a) => (
            <div key={a.bookingId} className="teach-booking">
              <div className="grow small"><b>{when(a.start)}</b> · {a.customer} · {a.service}{a.staff ? ` · ${a.staff}` : ''}<div className="muted">{t(`teach.reason.${a.reason}`)}</div></div>
              {open && (
                <div className="seg" role="group">
                  {(['keep', 'message'] as const).map((c) => (
                    <button key={c} type="button" className="chip small" aria-pressed={(choices[a.bookingId] ?? 'keep') === c} onClick={() => setChoices((x) => ({ ...x, [a.bookingId]: c }))}>{t(`teach.${c}`)}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {p.needsOwner && open && <p className="small muted">{t('teach.needs_owner')}</p>}
      {error && <p className="error small">{error}</p>}
      {msg && <p className="small teach-msg" data-testid="teach-saved">{msg}</p>}
      <div className="row" style={{ gap: 8 }}>
        {open && <button className="btn primary small" disabled={busy || !p.changes.length} onClick={save} data-testid="teach-save">{p.needsOwner ? t('teach.send_owner') : t('teach.save')}</button>}
        {open && <button className="btn ghost small" disabled={busy} onClick={cancel}>{t('teach.cancel')}</button>}
        {p.status === 'applied' && <button className="btn small" disabled={busy} onClick={undo} data-testid="teach-undo">{t('teach.undo')}</button>}
      </div>
    </div>
  );
}
