'use client';

import { useEffect, useState } from 'react';
import type { Sentence } from '@orbit/shared';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AgentDot } from '@/components/bridge/Hero';
import { openWhy } from './WhySheet';
import './trust.css';

export interface HeldAction {
  id: string;
  agent: string;
  type: string;
  summary: Sentence;
  audience: number;
  holdUntil: string;
  createdAt: string;
  status: 'holding' | 'executing' | 'executed' | 'cancelled' | 'failed';
  executedAt: string | null;
  cancelledAt: string | null;
  traceId: string | null;
  correctionCardId: string | null;
  sent: number;
  text: string | null;
}

/** How long a finished line stays: "Cancelled" briefly, "Sent" long enough to ask for a correction. */
const SHOW_CANCELLED_MS = 8_000;
const SHOW_SENT_MS = 45_000;

/**
 * The Undo window: a slim bar just above Ask Orbit while the Crew is about to
 * send something. A line shrinks as the time runs out; Undo cancels it and
 * nothing is sent. Afterwards it can only be followed by a correction.
 */
export function UndoBar({ held, onChanged, onEditAgain }: { held: HeldAction[]; onChanged: () => void; onEditAgain?: (text: string) => void }) {
  const { t, ts } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const visible = held.filter((h) => {
    if (hidden.has(h.id)) return false;
    if (h.status === 'holding' || h.status === 'executing') return true;
    if (h.status === 'cancelled') return now - new Date(h.cancelledAt ?? h.createdAt).getTime() < SHOW_CANCELLED_MS;
    if (h.status === 'executed') return now - new Date(h.executedAt ?? h.createdAt).getTime() < SHOW_SENT_MS;
    return h.status === 'failed' && now - new Date(h.createdAt).getTime() < SHOW_SENT_MS;
  });

  // Tick while something is on screen; refresh The Bridge when a hold ends so the row turns to "Sent".
  useEffect(() => {
    if (!visible.length) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [visible.length]);
  const ended = held.some((h) => h.status === 'holding' && new Date(h.holdUntil).getTime() + 1500 < now);
  useEffect(() => {
    if (!ended) return;
    const id = setTimeout(onChanged, 1200);
    return () => clearTimeout(id);
  }, [ended, onChanged]);

  if (!visible.length) return null;

  async function undo(h: HeldAction) {
    setBusy(h.id);
    try {
      await api(`/trust/held/${h.id}/undo`, { method: 'POST' });
      onChanged();
    } catch (e) {
      setNote((n) => ({ ...n, [h.id]: (e as ApiError).message }));
      onChanged();
    } finally {
      setBusy(null);
    }
  }
  async function correct(h: HeldAction) {
    setBusy(h.id);
    try {
      await api(`/trust/held/${h.id}/correction`, { method: 'POST' });
      setNote((n) => ({ ...n, [h.id]: t('held.correction_ready') }));
      onChanged();
    } catch (e) {
      setNote((n) => ({ ...n, [h.id]: (e as ApiError).message }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="undo-stack" role="status" aria-live="polite" data-testid="undo-bar">
      {visible.slice(0, 3).map((h) => {
        const total = Math.max(1, new Date(h.holdUntil).getTime() - new Date(h.createdAt).getTime());
        const left = Math.max(0, new Date(h.holdUntil).getTime() - now);
        const quiet = h.status === 'holding' && left > 6 * 60_000; // waiting for quiet hours to end
        const done = h.status === 'executed' || h.status === 'cancelled' || h.status === 'failed';
        return (
          <div key={h.id} className={`undo-row ${h.status} ${done ? 'pop' : ''}`} data-held={h.status}>
            <AgentDot agent={h.agent} />
            <div className="undo-main">
              {h.status === 'cancelled' ? (
                <b>{t('held.cancelled')}</b>
              ) : h.status === 'executed' ? (
                <b>{t('held.sent', { count: h.sent })}</b>
              ) : h.status === 'failed' ? (
                <b>{t('held.failed')}</b>
              ) : (
                <span className="undo-text">{ts(h.summary)}</span>
              )}
              {quiet && <small>{t('held.waiting_quiet', { time: `~t:${h.holdUntil}` })}</small>}
              {note[h.id] && <small>{note[h.id]}</small>}
              {h.status === 'holding' && !quiet && (
                <span className="undo-line" aria-hidden><i style={{ transform: `scaleX(${left / total})` }} /></span>
              )}
            </div>
            <div className="undo-actions">
              {h.status === 'holding' && !quiet && <span className="undo-secs">{t('held.seconds_left', { count: Math.ceil(left / 1000) })}</span>}
              {h.status === 'executing' && <span className="undo-secs">{t('held.sending')}</span>}
              {h.traceId && <button className="link-btn small" onClick={() => openWhy(h.traceId)}>{t('why.link')}</button>}
              {h.status === 'holding' && (
                <button className="btn small undo-btn" disabled={busy === h.id} onClick={() => undo(h)} data-testid="undo">{t('held.undo')}</button>
              )}
              {h.status === 'cancelled' && h.text && onEditAgain && (
                <button className="btn small" onClick={() => { setHidden((s) => new Set(s).add(h.id)); onEditAgain(h.text!); }}>{t('held.edit_again')}</button>
              )}
              {h.status === 'executed' && h.sent > 0 && !h.correctionCardId && !note[h.id] && (
                <button className="btn small" disabled={busy === h.id} onClick={() => correct(h)}>{t('held.send_correction')}</button>
              )}
              {done && <button className="undo-x" aria-label={t('common.close')} onClick={() => setHidden((s) => new Set(s).add(h.id))}>×</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
