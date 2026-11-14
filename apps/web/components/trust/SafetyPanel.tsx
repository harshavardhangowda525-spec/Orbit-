'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Sentence } from '@orbit/shared';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import './trust.css';

interface Safety { holdSeconds: Record<string, number>; reviewBeforeSend: Record<string, boolean>; maxSeconds: number }
interface Change { id: string; entity: string; label: Sentence; createdAt: string; undoUntil: string; revertedAt: string | null }
interface Exception { id: string; rule: string; customer: string; createdAt: string }

const HOLD_TYPES = ['message', 'bulk_message', 'booking_change', 'calls'] as const;
const STEPS = [0, 10, 30, 60, 120, 180, 300];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Channels the owner can review Aria's replies on. Website chat and chat links are one switch. */
const REVIEW: { key: string; channels: string[] }[] = [
  { key: 'whatsapp', channels: ['whatsapp'] },
  { key: 'website_chat', channels: ['website_chat', 'chat_link'] },
  { key: 'instagram', channels: ['instagram'] },
  { key: 'messenger', channels: ['messenger'] },
  { key: 'gmail', channels: ['gmail', 'outlook'] },
  { key: 'sms', channels: ['sms'] },
];

/**
 * Crew → Safety: how long Orbit waits before sending (so Undo is possible),
 * whether Aria's replies need the owner's OK first, the last 24 hours of
 * settings changes (each undoable), and customers the owner switched things off for.
 */
export function SafetyPanel({ highlight }: { highlight?: string | null }) {
  const { t, ts } = useI18n();
  const [s, setS] = useState<Safety | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [exceptions, setExceptions] = useState<Exception[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Safety>('/trust/safety').then(setS).catch(() => undefined);
    api<Change[]>('/trust/changes').then(setChanges).catch(() => undefined);
    api<Exception[]>('/trust/exceptions').then(setExceptions).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  const save = async (body: object) => {
    setErr(null);
    setMsg(null);
    try {
      setS(await api<Safety>('/trust/safety', { method: 'PATCH', body }));
      setMsg(t('safety.saved'));
      api<Change[]>('/trust/changes').then(setChanges).catch(() => undefined);
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };
  const act = async (path: string, method: string) => {
    setErr(null);
    try {
      await api(path, { method });
      load();
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };
  const label = (secs: number) => (secs === 0 ? t('safety.off') : secs < 60 ? t('safety.seconds', { count: secs }) : t('safety.minutes', { count: secs / 60 }));

  return (
    <section id="safety" className={`card safety ${highlight === 'safety.review_before_send' || highlight === 'safety' ? 'highlight-flash' : ''}`} data-testid="safety">
      <div>
        <h3 style={{ margin: 0 }}>{t('safety.title')}</h3>
        <p className="muted small" style={{ margin: '4px 0 0' }}>{t('safety.sub')}</p>
      </div>
      {s && (
        <div className="safety-holds">
          {HOLD_TYPES.map((k) => (
            <label key={k}>
              <span>{t(`safety.hold.${k}`)}</span>
              <select className="input" value={s.holdSeconds[k] ?? 0} onChange={(e) => save({ holdSeconds: { [k]: Number(e.target.value) } })} data-hold={k}>
                {STEPS.filter((v) => v <= s.maxSeconds).map((v) => <option key={v} value={v}>{label(v)}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}

      {s && (
        <div>
          <b className="small">{t('safety.review_title')}</b>
          <p className="muted small" style={{ margin: '2px 0 8px' }}>{t('safety.review_sub')}</p>
          <div className="safety-toggles">
            {REVIEW.map((r) => {
              const on = r.channels.some((c) => s.reviewBeforeSend[c]);
              return (
                <label key={r.key} className="check-line">
                  <input type="checkbox" checked={on} onChange={(e) => save({ reviewBeforeSend: Object.fromEntries(r.channels.map((c) => [c, e.target.checked])) })} data-review={r.key} />
                  <span>{cap(t(`channel.${r.key}`))}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <b className="small">{t('safety.changes_title')}</b>
        <p className="muted small" style={{ margin: '2px 0 8px' }}>{t('safety.changes_sub')}</p>
        {changes.length === 0 ? (
          <p className="muted small">{t('safety.changes_empty')}</p>
        ) : (
          <ul className="safety-list" data-testid="changes">
            {changes.map((c) => (
              <li key={c.id}>
                <span>{ts(c.label)}<small>{new Date(c.createdAt).toLocaleString()}</small></span>
                {c.revertedAt ? <span className="muted small">{t('safety.undone')}</span> : new Date(c.undoUntil) > new Date() && (
                  <button className="btn small" onClick={() => act(`/trust/changes/${c.id}/undo`, 'POST')}>{t('safety.undo')}</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <b className="small">{t('safety.exceptions_title')}</b>
        {exceptions.length === 0 ? (
          <p className="muted small" style={{ margin: '4px 0 0' }}>{t('safety.exceptions_empty')}</p>
        ) : (
          <ul className="safety-list" style={{ marginTop: 8 }}>
            {exceptions.map((x) => (
              <li key={x.id}>
                <span>{x.customer}<small>{t(`why.rule.${x.rule}`)}</small></span>
                <button className="btn small" onClick={() => act(`/trust/exceptions/${x.id}`, 'DELETE')}>{t('safety.remove')}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {err && <p className="error small">{err}</p>}
      {msg && !err && <p className="small muted" role="status">{msg}</p>}
    </section>
  );
}
