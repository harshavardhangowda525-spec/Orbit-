'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

interface Plan { code: string; name: string; prices: { INR: number; USD: number }; limits: Record<string, any>; features: { agents: string[] } }
interface Billing {
  plan: Plan; plans: Plan[]; usage: { aiConversations: number; staff: number; tasks: number };
  subscription: { planCode: string; status: string; url: string | null; currentEnd: string | null; cancelAtCycleEnd: boolean } | null; billing: boolean;
}

/** Plan: what the business is on, this month's use, and upgrading (Razorpay subscription). */
export function PlanView() {
  const { t, money } = useI18n();
  const { business } = useSession();
  const owner = business?.role === 'owner';
  const [b, setB] = useState<Billing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api<Billing>('/billing').then(setB).catch((e) => setMsg((e as ApiError).message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const upgrade = async (code: string) => {
    setBusy(code);
    setMsg(null);
    try {
      const r = await api<{ url: string }>('/billing/upgrade', { body: { plan: code } });
      window.location.href = r.url;
    } catch (e) {
      setMsg((e as ApiError).message);
      setBusy(null);
    }
  };
  const cancel = async () => {
    if (!confirm(t('plan.cancel_confirm'))) return;
    try {
      await api('/billing/cancel', { body: {} });
      load();
    } catch (e) {
      setMsg((e as ApiError).message);
    }
  };
  if (!b) return <p className="muted">{msg ?? t('common.loading')}</p>;
  const lim = b.plan.limits;
  const bar = (used: number, cap: number | null) => (cap == null ? null : <div className="bar"><i style={{ width: `${Math.min(100, (used / Math.max(1, cap)) * 100)}%` }} className={used >= cap ? 'full' : ''} /></div>);
  return (
    <section className="stack plan" data-testid="plan">
      <div>
        <h2>{t('view.plan')}</h2>
        <p className="muted small">{t('plan.current', { plan: b.plan.name })}{b.subscription?.status === 'active' && b.subscription.currentEnd ? ` · ${t(b.subscription.cancelAtCycleEnd ? 'plan.ends' : 'plan.renews', { date: new Date(b.subscription.currentEnd).toLocaleDateString() })}` : ''}</p>
      </div>
      {msg && <p className="error">{msg}</p>}
      <div className="card stack">
        <h3>{t('plan.usage')}</h3>
        <div className="usage-row"><span>{t('plan.ai')}</span><b>{b.usage.aiConversations}{lim.aiConversationsPerMonth != null ? ` / ${lim.aiConversationsPerMonth}` : ''}</b></div>
        {bar(b.usage.aiConversations, lim.aiConversationsPerMonth)}
        <div className="usage-row"><span>{t('plan.staff')}</span><b>{b.usage.staff}{lim.staffCalendars != null ? ` / ${lim.staffCalendars}` : ''}</b></div>
        {bar(b.usage.staff, lim.staffCalendars)}
      </div>
      <div className="plan-grid">
        {b.plans.map((p) => {
          const current = p.code === b.plan.code;
          return (
            <div key={p.code} className={`card plan-card ${current ? 'current' : ''}`} data-plan={p.code}>
              <b className="plan-name">{p.name}</b>
              <div className="plan-price"><>{money(p.prices.INR)}<span>{t('plan.per_month')}</span></></div>
              <ul className="small">
                <li>{p.limits.aiConversationsPerMonth == null ? t('plan.ai_unlimited') : t('plan.ai_n', { n: p.limits.aiConversationsPerMonth })}</li>
                <li>{p.limits.staffCalendars == null ? t('plan.staff_unlimited') : t('plan.staff_n', { n: p.limits.staffCalendars })}</li>
                <li>{t('plan.crew', { names: p.features.agents.filter((a) => a !== 'orbit').map((a) => t(`agent.${a}.name`)).join(', ') })}</li>
              </ul>
              {current ? <span className="chip">{t('plan.your_plan')}</span> : p.prices.INR > 0 && owner ? (
                <button className="btn primary" disabled={!!busy} onClick={() => upgrade(p.code)}>{busy === p.code ? t('common.wait') : t('plan.choose', { plan: p.name })}</button>
              ) : null}
            </div>
          );
        })}
      </div>
      {!b.billing && <p className="note small">{t('plan.no_billing')}</p>}
      {owner && b.subscription?.status === 'active' && !b.subscription.cancelAtCycleEnd && <button className="link-btn small" onClick={cancel}>{t('plan.cancel')}</button>}
    </section>
  );
}

interface CrewRow { agent: string; name: string; personality: string; enabled: boolean; permissions: Record<string, boolean> }
const PERMS: Record<string, string[]> = { nudge: ['reviewRequests', 'renewals', 'followUps'], ledger: ['invoiceReminders'] };

/** One Crew member's settings: on/off, name, tone, and what it may do on its own. */
export function CrewSettings({ agent }: { agent: string }) {
  const { t } = useI18n();
  const [s, setS] = useState<{ reviewUrl: string | null; crew: CrewRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [planAgents, setPlanAgents] = useState<string[] | null>(null);
  const load = useCallback(() => {
    api<any>('/crew/settings').then(setS).catch(() => undefined);
    api<Billing>('/billing').then((b) => setPlanAgents(b.plan.features.agents)).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const row = s?.crew.find((c) => c.agent === agent);
  const onPlan = !planAgents || planAgents.includes(agent);
  if (!row) return null;
  const patch = async (body: object) => {
    setErr(null);
    setSaved(false);
    try {
      const r = await api<CrewRow>(`/crew/${agent}`, { method: 'PATCH', body });
      setS((x) => (x ? { ...x, crew: x.crew.map((c) => (c.agent === agent ? r : c)) } : x));
      setSaved(true);
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };
  const saveLink = async (url: string) => {
    setErr(null);
    try {
      await api('/crew/settings/review-link', { method: 'PATCH', body: { url } });
      setSaved(true);
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };
  return (
    <div className="crew-settings stack" data-testid={`crew-settings-${agent}`}>
      {agent !== 'orbit' && (
        <label className="check-line">
          <input type="checkbox" checked={row.enabled} disabled={!onPlan && !row.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span>{row.enabled ? t('crew.on_label', { name: row.name }) : t('crew.off_label', { name: row.name })}{!onPlan ? ` (${t('powers.upgrade')})` : ''}</span>
        </label>
      )}
      <div className="grid2">
        <label className="field"><span>{t('crew.name')}</span><input className="input" defaultValue={row.name} maxLength={40} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== row.name && patch({ displayName: e.target.value.trim() })} /></label>
        <label className="field"><span>{t('crew.tone')}</span>
          <select className="input" value={row.personality} onChange={(e) => patch({ personality: e.target.value })}>
            {['friendly', 'formal', 'energetic'].map((p) => <option key={p} value={p}>{t(`crew.tone.${p}`)}</option>)}
          </select>
        </label>
      </div>
      {(PERMS[agent] ?? []).map((k) => (
        <label key={k} className="check-line">
          <input type="checkbox" checked={row.permissions?.[k] !== false} disabled={!row.enabled} onChange={(e) => patch({ permissions: { [k]: e.target.checked } })} />
          <span>{t(`crew.perm.${k}`)}</span>
        </label>
      ))}
      {agent === 'nudge' && (
        <label className="field"><span>{t('crew.review_link')}</span>
          <input className="input" type="url" placeholder="https://g.page/r/…/review" defaultValue={s?.reviewUrl ?? ''} onBlur={(e) => e.target.value !== (s?.reviewUrl ?? '') && saveLink(e.target.value.trim())} />
          <small className="muted">{t('crew.review_link_hint')}</small>
        </label>
      )}
      {err && <p className="error small">{err}</p>}
      {saved && !err && <p className="small muted">{t('crew.saved')}</p>}
    </div>
  );
}
