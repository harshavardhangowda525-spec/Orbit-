'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { explainTrace, type DecisionTrace, type TraceFact } from '@orbit/shared';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AgentDot } from '@/components/bridge/Hero';
import './trust.css';

/** Any "Why?" link opens the one sheet on the page. `null` = an older action with no recorded reasons. */
type WhyState = { open: boolean; traceId: string | null };
let state: WhyState = { open: false, traceId: null };
const listeners = new Set<() => void>();
export function openWhy(traceId: string | null) {
  state = { open: true, traceId };
  listeners.forEach((l) => l());
}
const close = () => {
  state = { open: false, traceId: null };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

interface WhyData { trace: DecisionTrace; timezone: string; canException: boolean; exceptionId: string | null; feedback: string[] }

/** Where a fact leads when tapped: the customer, the chat, the booking or the invoice. */
function factHref(f: TraceFact): string | null {
  if (!f.ref) return null;
  if (f.ref.type === 'conversation') return `/inbox/${f.ref.id}`;
  if (f.ref.type === 'invoice') return '/bridge?view=money';
  if (f.ref.type === 'customer' || f.ref.type === 'lead' || f.ref.type === 'booking') return '/bridge?view=people';
  return null;
}

/**
 * "Why did you do that?": one plain sentence phrased from the reasons stored
 * when the action happened, the facts it was based on (each tappable), and
 * three ways to respond. With no stored reasons it says so; it never guesses.
 */
export function WhySheetHost() {
  const { t, lang, ts } = useI18n();
  const router = useRouter();
  const s = useSyncExternalStore(subscribe, () => state, () => state);
  const [data, setData] = useState<WhyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setData(null);
    setError(null);
    setDone(null);
    if (!s.open || !s.traceId) return;
    let live = true;
    api<WhyData>(`/trust/traces/${s.traceId}`).then((d) => live && setData(d)).catch((e) => live && setError((e as ApiError).message));
    return () => { live = false; };
  }, [s.open, s.traceId]);

  useEffect(() => {
    if (!s.open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [s.open]);

  if (!s.open) return null;

  async function feedback(verdict: 'good' | 'change_rule' | 'exception') {
    if (!s.traceId || !data) return;
    setBusy(true);
    try {
      const r = await api<{ setting: string | null }>(`/trust/traces/${s.traceId}/feedback`, { method: 'POST', body: { verdict } });
      if (verdict === 'change_rule') {
        const to = r.setting ?? data.trace.rule?.setting ?? '/bridge?view=crew';
        close();
        router.push(`${to}${to.includes('?') ? '&' : '?'}highlight=${encodeURIComponent(data.trace.rule?.code ?? '')}`);
        return;
      }
      setDone(verdict === 'exception' ? t('why.exception_done', { customer: data.trace.customer?.name ?? '' }) : t('why.thanks'));
      if (verdict === 'exception') setData({ ...data, exceptionId: 'new' });
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  const tr = data?.trace;
  const fmt = { timeZone: data?.timezone };
  const go = (href: string) => { close(); router.push(href); };

  return (
    <div className="why-sheet" role="dialog" aria-modal="true" aria-labelledby="why-h" onClick={(e) => e.target === e.currentTarget && close()} data-testid="why-sheet">
      <div className="why-card">
        <div className="why-grab" aria-hidden />
        <div className="why-head">
          {tr && <AgentDot agent={tr.agent} />}
          <h2 id="why-h">{t('why.title')}</h2>
          <button className="undo-x" aria-label={t('common.close')} onClick={close}>×</button>
        </div>

        {!s.traceId ? (
          <p className="why-sentence muted" data-testid="why-none">{t('why.no_details')}</p>
        ) : error ? (
          <p className="error small">{error}</p>
        ) : !tr ? (
          <div className="why-skel" aria-hidden><i /><i /></div>
        ) : (
          <>
            <p className="why-sentence pop" data-testid="why-sentence">{explainTrace(lang, tr, fmt)}</p>
            <div className="why-label">{t('why.based_on')}</div>
            <ul className="why-facts">
              {tr.facts.map((f, i) => {
                const href = factHref(f);
                const label = ts(f.text);
                return (
                  <li key={i}>
                    {href ? <button className="why-fact" onClick={() => go(href)}>{label}<span aria-hidden>›</span></button> : <span className="why-fact plain">{label}</span>}
                  </li>
                );
              })}
              {tr.rule && (
                <li>
                  <button className="why-fact rule" onClick={() => feedback('change_rule')} disabled={busy}>
                    <span><small>{t('why.rule_label')}</small>{ts(tr.rule.label)}</span><span aria-hidden>›</span>
                  </button>
                </li>
              )}
              <li><span className="why-fact plain approver">{t(`why.approved.${tr.approver.kind}`)}</span></li>
            </ul>

            {done ? (
              <p className="why-done pop" role="status">{done}</p>
            ) : (
              <div className="why-actions">
                {tr.rule && <button className="btn" disabled={busy} onClick={() => feedback('change_rule')}>{t('why.change_rule')}</button>}
                {data!.canException && !data!.exceptionId && tr.customer && (
                  <button className="btn" disabled={busy} onClick={() => feedback('exception')} data-testid="why-exception">{t('why.dont_again', { customer: tr.customer.name })}</button>
                )}
                {data!.exceptionId && tr.customer && <span className="why-chip">{t('why.exception_active', { customer: tr.customer.name })}</span>}
                <button className="btn primary" disabled={busy} onClick={() => feedback('good')}>{t('why.looks_good')}</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
