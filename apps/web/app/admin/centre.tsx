'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminSession, api, apiDownload, ApiError, session } from '@/lib/api';

/** Admin control centre screens (internal tool, English). */
type OnError = (e: string | null) => void;
const inr = (n: number | null | undefined) => (n == null ? '—' : `₹${Math.round(Number(n)).toLocaleString('en-IN')}`);
const when = (s?: string | null) => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const trend = (n: number | null | undefined) => (n == null ? '' : `${n > 0 ? '▲' : n < 0 ? '▼' : '•'} ${Math.abs(n)}%`);
const useLoad = <T,>(path: string | null, onError: OnError, deps: unknown[] = []) => {
  const [data, setData] = useState<T | null>(null);
  const load = useCallback(() => {
    if (path) api<T>(path, { business: false }).then(setData).catch((e) => onError((e as ApiError).message));
  }, [path, onError]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [load, ...deps]);
  return { data, load };
};

// ------------------------------------------------------------ the gate: authenticator code

export function AdminGate({ children }: { children: (role: string) => React.ReactNode }) {
  const [role, setRole] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      if (adminSession.get()) {
        try {
          setRole((await api<{ role: string }>('/admin/team/me', { business: false })).role);
          return;
        } catch {
          adminSession.set(null);
        }
      }
      try {
        const s = await api<any>('/admin-auth/start', { body: {}, business: false });
        if (!cancelled && s.setup) setSetup({ secret: s.secret, qrSvg: s.qrSvg });
      } catch (e) {
        if (!cancelled) setErr((e as ApiError).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ token: string; role: string; expiresInSec: number }>('/admin-auth/verify', { body: { code: code.trim() }, business: false });
      adminSession.set(r.token, r.expiresInSec);
      setRole(r.role);
    } catch (x) {
      setErr((x as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  if (role) return <>{children(role)}</>;
  return (
    <section className="card stack" style={{ maxWidth: 460, margin: '40px auto' }} data-testid="admin-gate">
      <h2 style={{ margin: 0 }}>Admin centre</h2>
      {setup ? (
        <>
          <p className="small">First time here: scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), then enter the 6-digit code it shows.</p>
          <div style={{ background: '#fff', padding: 12, borderRadius: 12, width: 220 }} dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
          <p className="small muted">Can&apos;t scan? Enter this key: <span className="mono">{setup.secret.replace(/(.{4})/g, '$1 ')}</span></p>
        </>
      ) : (
        <p className="small">Enter the 6-digit code from your authenticator app.</p>
      )}
      <form className="row" onSubmit={verify}>
        <input className="input grow mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} data-testid="admin-code" />
        <button className="btn primary" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Open'}</button>
      </form>
      {err && <p className="error small">{err}</p>}
    </section>
  );
}

// ------------------------------------------------------------ overview

export function Overview({ onError, go }: { onError: OnError; go: (tab: string) => void }) {
  const { data: o } = useLoad<any>('/admin/overview', onError);
  const { data: feed } = useLoad<any[]>('/admin/feed?limit=8', onError);
  if (!o) return <p className="muted">Loading…</p>;
  const a = o.alerts;
  const alerts = [
    a.approvals && { t: `${a.approvals} waiting for approval`, tab: 'approvals' },
    a.failedPayments && { t: `${a.failedPayments} failed payments (7 days)`, tab: 'subscriptions' },
    a.budgetWarnings && { t: `${a.budgetWarnings} provider budget warnings`, tab: 'budgets' },
    a.pausedAi && { t: `${a.pausedAi} businesses with AI paused`, tab: 'businesses' },
    a.failedTasks && { t: `${a.failedTasks} failed tasks (24 h)`, tab: 'health' },
    a.failedMessages && { t: `${a.failedMessages} owner messages failed (24 h)`, tab: 'messaging' },
  ].filter(Boolean) as { t: string; tab: string }[];
  return (
    <section className="stack" data-testid="admin-overview">
      <div className="stat-grid">
        <div className="card stat"><b>{o.businesses.total}</b><span>businesses · {o.businesses.signups} new in {o.days} days {trend(o.businesses.signupsTrend)}</span></div>
        <div className="card stat"><b>{o.businesses.activeToday} / {o.businesses.activeWeek} / {o.businesses.activeMonth}</b><span>active today / week / month</span></div>
        <div className="card stat"><b>{inr(o.money.mrr)}</b><span>monthly recurring revenue</span></div>
        <div className="card stat"><b>{inr(o.money.revenueMonth)}</b><span>revenue this month {trend(o.money.revenueTrend)}</span></div>
        <div className="card stat"><b>{inr(o.ai.costMonth)}</b><span>AI cost this month (projected {inr(o.ai.projected)}) {trend(o.ai.costTrend)}</span></div>
        <div className={`card stat ${o.ai.grossMarginPct != null && o.ai.grossMarginPct < 50 ? 'bad' : ''}`}><b>{o.ai.grossMarginPct == null ? '—' : `${o.ai.grossMarginPct}%`}</b><span>gross margin after AI</span></div>
      </div>
      <div className="grid" style={{ alignItems: 'start' }}>
        <div className="card stack">
          <h3>Alerts</h3>
          {alerts.length ? alerts.map((x) => <button key={x.t} className="link-btn" style={{ textAlign: 'left' }} onClick={() => go(x.tab)}>⚠ {x.t}</button>) : <p className="small muted">All clear.</p>}
        </div>
        <div className="card stack">
          <h3>This month</h3>
          <div className="small">Upgrades {o.money.upgrades.this_month} (last month {o.money.upgrades.last_month}) · Downgrades {o.money.downgrades.this_month} · Cancellations {o.money.cancellations.this_month} · Failed payments {o.money.failedPayments.this_month}</div>
          <div className="small">{o.businesses.byPlan.map((p: any) => `${p.name} ${p.businesses}`).join(' · ')}</div>
        </div>
      </div>
      <div className="card stack">
        <div className="row between"><h3>Latest plan changes</h3><button className="link-btn small" onClick={() => go('subscriptions')}>See all</button></div>
        <FeedRows rows={feed ?? []} />
      </div>
    </section>
  );
}

function FeedRows({ rows }: { rows: any[] }) {
  if (!rows.length) return <p className="small muted">No plan changes yet.</p>;
  const label: Record<string, string> = { upgrade: 'upgraded', downgrade: 'downgraded', cancel: 'cancelled', payment_failed: 'payment failed', renewal: 'renewed', trial: 'trial', grace_ended: 'moved to Free (grace ended)' };
  return (
    <ul className="stack small" style={{ listStyle: 'none', padding: 0, margin: 0 }} data-testid="admin-feed">
      {rows.map((r) => (
        <li key={r.id}><b>{r.business}</b> {label[r.kind] ?? r.kind}{r.from || r.to ? ` ${r.from ?? '—'} → ${r.to ?? '—'}` : ''}{r.amount ? ` · ${inr(r.amount)}` : ''} <span className="muted">· {when(r.at)}</span></li>
      ))}
    </ul>
  );
}

export function Subscriptions({ onError }: { onError: OnError }) {
  const { data, load } = useLoad<any[]>('/admin/feed?limit=200', onError);
  useEffect(() => {
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);
  return <section className="card stack"><h3>Live subscriptions feed</h3><p className="small muted">Plans switch on the moment Razorpay confirms a payment; nothing to approve. Updates every 30 seconds.</p><FeedRows rows={data ?? []} /></section>;
}

export function AdminBell({ onError }: { onError: OnError }) {
  const [open, setOpen] = useState(false);
  const { data, load } = useLoad<any[]>('/admin/notifications', onError);
  const unread = (data ?? []).filter((n) => !n.read).length;
  return (
    <div style={{ position: 'relative' }}>
      <button className="chip" onClick={() => { setOpen(!open); if (!open && unread) api('/admin/notifications/read', { body: {}, business: false }).then(load).catch(() => undefined); }}>🔔 {unread || ''}</button>
      {open && (
        <div className="card stack" style={{ position: 'absolute', right: 0, top: 44, width: 360, maxHeight: 420, overflow: 'auto', zIndex: 40, background: 'rgba(20,18,52,0.98)' }}>
          {(data ?? []).length === 0 && <p className="small muted">No alerts.</p>}
          {(data ?? []).map((n) => <a key={n.id} href={n.link ?? '#'} className="small" style={{ color: 'inherit', fontWeight: n.read ? 400 : 800 }}>{n.title}<div className="muted">{when(n.created_at)}</div></a>)}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ approvals

export function Approvals({ onError, role }: { onError: OnError; role: string }) {
  const [status, setStatus] = useState('pending');
  const { data, load } = useLoad<any[]>(`/admin/approvals?status=${status}`, onError, [status]);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const canDecide = role === 'owner' || role === 'finance';
  const decide = async (a: any, decision: 'approve' | 'reject') => {
    try {
      const amount = edit[a.id];
      await api(`/admin/approvals/${a.id}/decide`, { body: { decision, edited: amount ? { amountInr: Number(amount) } : undefined }, business: false });
      load();
    } catch (e) {
      onError((e as ApiError).message);
    }
  };
  return (
    <section className="stack">
      <div className="seg">{['pending', 'approved', 'rejected', 'expired', 'all'].map((s) => <button key={s} className="chip" aria-current={status === s} onClick={() => setStatus(s)}>{s}</button>)}</div>
      {(data ?? []).length === 0 && <p className="muted">Nothing here.</p>}
      {(data ?? []).map((a) => (
        <div key={a.id} className="card stack" data-testid="approval">
          <div className="row between"><b>{a.title}</b><span className="chip">{a.kind.replace('_', ' ')}</span></div>
          <div className="small muted">{a.business ? `${a.business} · ` : ''}requested {when(a.created_at)}{a.requestedByName ? ` by ${a.requestedByName}` : ''}{a.status === 'pending' ? ` · safe default "${a.default_action}" at ${when(a.due_at)}` : ` · ${a.status}${a.decidedByName ? ` by ${a.decidedByName}` : ''}`}</div>
          <div className="small">Cost impact {inr(a.cost_impact)} · Margin impact {inr(a.margin_impact)}</div>
          {Object.keys(a.context ?? {}).length > 0 && <pre className="small mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(a.context, null, 1)}</pre>}
          {a.status === 'pending' && canDecide && (
            <div className="row">
              {a.payload?.amountInr != null && <input className="input" style={{ maxWidth: 140 }} type="number" placeholder={`₹${a.payload.amountInr}`} value={edit[a.id] ?? ''} onChange={(e) => setEdit({ ...edit, [a.id]: e.target.value })} />}
              <button className="btn primary small" onClick={() => decide(a, 'approve')}>{edit[a.id] ? 'Edit and approve' : 'Approve'}</button>
              <button className="btn small" onClick={() => decide(a, 'reject')}>Reject</button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

// ------------------------------------------------------------ budgets

export function Budgets({ onError, role }: { onError: OnError; role: string }) {
  const { data, load } = useLoad<any[]>('/admin/budgets', onError);
  const [amount, setAmount] = useState<Record<string, string>>({});
  const can = role === 'owner' || role === 'finance';
  const approve = async (p: any) => {
    try {
      const r = await api<any>(`/admin/budgets/${p.provider}/approve`, { body: { amountInr: Number(amount[p.provider] || p.recommended) }, business: false });
      if (r.status === 'pending') alert('This is more than last month, so it is waiting in Approvals.');
      load();
    } catch (e) {
      onError((e as ApiError).message);
    }
  };
  const confirmSet = async (p: any) => {
    await api(`/admin/budgets/${p.provider}/confirm`, { body: { month: p.month }, business: false }).catch((e) => onError(e.message));
    load();
  };
  return (
    <section className="stack">
      <p className="small muted">Orbit&apos;s own AI and speech providers. Providers are paid by the card saved in each provider&apos;s billing settings; none lets Orbit set a spend cap by API, so an approved budget is recorded and you set it in their billing page, then mark it done. Alerts at 70, 90 and 100%.</p>
      {(data ?? []).map((p) => (
        <div key={p.provider} className="card stack" data-testid={`budget-${p.provider}`}>
          <div className="row between"><h3>{p.name}</h3><a className="small" href={p.billingUrl} target="_blank" rel="noreferrer">Billing page ↗</a></div>
          <div className="stat-grid">
            <div className="stat"><b>{inr(p.spend)}</b><span>spent this month</span></div>
            <div className="stat"><b>{inr(p.projected)}</b><span>projected month end</span></div>
            <div className="stat"><b>{inr(p.recommended)}</b><span>recommended cap</span></div>
            <div className={`stat ${p.usedPct >= 90 ? 'bad' : ''}`}><b>{p.budget == null ? '—' : `${inr(p.budget)} (${p.usedPct}%)`}</b><span>approved budget {p.status ? `· ${p.status}` : ''}</span></div>
          </div>
          <div className="small muted">Last 3 months: {p.history.map((h: any) => `${h.month} ${inr(h.spend)}`).join(' · ')}</div>
          {p.byPlan.length > 0 && <div className="small muted">By plan: {p.byPlan.map((x: any) => `${x.plan} ${inr(x.inr)}`).join(' · ')}</div>}
          {p.topBusinesses.length > 0 && <div className="small muted">Top: {p.topBusinesses.slice(0, 5).map((x: any) => `${x.name} ${inr(x.inr)}`).join(' · ')}</div>}
          {can && (
            <div className="row">
              <input className="input" type="number" style={{ maxWidth: 160 }} placeholder={`₹${p.recommended}`} value={amount[p.provider] ?? ''} onChange={(e) => setAmount({ ...amount, [p.provider]: e.target.value })} />
              <button className="btn primary small" onClick={() => approve(p)}>Approve budget</button>
              {p.status === 'recorded' && <button className="btn small" onClick={() => confirmSet(p)}>I set it in their billing page</button>}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

// ------------------------------------------------------------ businesses

export function BusinessesCentre({ onError, role }: { onError: OnError; role: string }) {
  const [f, setF] = useState<Record<string, string>>({ sort: 'created' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, load } = useLoad<any[]>(`/admin/centre/businesses?${qs}`, onError, [qs]);
  const { data: plans } = useLoad<any[]>('/admin/plans', onError);
  const [sel, setSel] = useState<string | null>(new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('id'));
  return (
    <section className="stack">
      <div className="grid">
        <input className="input" placeholder="Search name or link" value={f.q ?? ''} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select className="input" value={f.plan ?? ''} onChange={(e) => setF({ ...f, plan: e.target.value })}><option value="">All plans</option>{(plans ?? []).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
        <select className="input" value={f.status ?? ''} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Any status</option>{['onboarding', 'live', 'paused', 'suspended'].map((s) => <option key={s}>{s}</option>)}</select>
        <select className="input" value={f.activeDays ?? ''} onChange={(e) => setF({ ...f, activeDays: e.target.value })}><option value="">Any activity</option><option value="1">Active today</option><option value="7">Active this week</option><option value="30">Active this month</option></select>
        <label className="field"><span>Signed up from</span><input className="input" type="date" value={f.from?.slice(0, 10) ?? ''} onChange={(e) => setF({ ...f, from: e.target.value ? new Date(e.target.value).toISOString() : '' })} /></label>
        <select className="input" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })}>{[['created', 'Newest'], ['active', 'Last active'], ['usage', 'Usage %'], ['revenue', 'Revenue'], ['cost', 'AI cost'], ['margin', 'Margin']].map(([v, l]) => <option key={v} value={v}>Sort: {l}</option>)}</select>
      </div>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>Business</th><th>Plan</th><th>Status</th><th>Signed up</th><th>Last active</th><th>Usage</th><th>Revenue</th><th>AI cost</th><th>Margin</th></tr></thead>
          <tbody>
            {(data ?? []).map((b) => (
              <tr key={b.id} onClick={() => setSel(b.id)} style={{ cursor: 'pointer' }} className={b.aiPaused ? 'flag' : ''}>
                <td><b>{b.name}</b><div className="small muted">/{b.slug} · {b.type}{b.aiPaused ? ' · AI paused' : ''}</div></td>
                <td>{b.plan}</td><td>{b.status}</td><td className="small">{when(b.createdAt)}</td><td className="small">{when(b.lastActiveAt)}</td>
                <td>{b.usage_pct == null ? `${b.conversations}` : `${b.usage_pct}%`}</td><td>{inr(b.revenue)}</td><td>{inr(b.ai_cost)}</td><td>{inr(b.margin)}</td>
              </tr>
            ))}
            {(data ?? []).length === 0 && <tr><td colSpan={9} className="muted">No businesses match.</td></tr>}
          </tbody>
        </table>
      </div>
      {sel && <BusinessDetail id={sel} role={role} plans={plans ?? []} onError={onError} onClose={() => { setSel(null); load(); }} />}
    </section>
  );
}

function BusinessDetail({ id, role, plans, onError, onClose }: { id: string; role: string; plans: any[]; onError: OnError; onClose: () => void }) {
  const { data: d, load } = useLoad<any>(`/admin/centre/businesses/${id}`, onError, [id]);
  const [note, setNote] = useState('');
  const money = role === 'owner' || role === 'finance';
  const act = async (path: string, body: object, okMsg?: string) => {
    onError(null);
    try {
      const r = await api<any>(`/admin/centre/businesses/${id}/${path}`, { body, business: false });
      if (r?.status === 'pending') alert('Sent for approval (see Approvals).');
      else if (okMsg) alert(okMsg);
      load();
    } catch (e) {
      onError((e as ApiError).message);
    }
  };
  const patch = async (body: object) => {
    try {
      await api(`/admin/businesses/${id}`, { method: 'PATCH', body, business: false });
      load();
    } catch (e) {
      onError((e as ApiError).message);
    }
  };
  const viewAs = async () => {
    const write = role === 'owner' && confirm('Allow changes while viewing? Cancel = read-only (recommended).');
    if (!confirm('View this business as its owner? This is recorded in the audit log.')) return;
    const r = await api<{ token: string }>(`/admin/businesses/${id}/impersonate`, { body: { write }, business: false });
    sessionStorage.setItem('orbit.admin.token', session.token() ?? '');
    session.setToken(r.token);
    session.setBusinessId(id);
    window.location.href = '/bridge';
  };
  const del = async () => {
    const slug = prompt(`Delete ${d.business.name} and all its data? Type its address name (${d.business.slug}) to confirm.`);
    if (!slug) return;
    try {
      await api(`/admin/centre/businesses/${id}?confirm=${encodeURIComponent(slug)}`, { method: 'DELETE', business: false });
      onClose();
    } catch (e) {
      onError((e as ApiError).message);
    }
  };
  if (!d) return <div className="card"><p className="muted">Loading…</p></div>;
  const b = d.business;
  const m = d.meters;
  return (
    <div className="card stack" data-testid="business-detail">
      <div className="row between"><h3>{b.name} <span className="muted small">/{b.slug} · {b.type}</span></h3><button className="link-btn" onClick={onClose}>Close</button></div>
      <div className="small">Plan <b>{b.planName}</b>{b.trial_ends_at ? ` · trial until ${when(b.trial_ends_at)}` : ''}{b.grace_until ? ` · payment grace until ${when(b.grace_until)}` : ''}{b.price_lock ? ` · price locked at ${inr(b.price_lock.INR)}` : ''}{b.applied_coupon ? ` · coupon ${b.applied_coupon}` : ''} · wallet {inr(b.ai_wallet_balance)}{b.ai_paused ? ' · AI PAUSED' : ''}</div>
      {m && <div className="small">Today {m.today.used}{m.today.cap != null ? ` of ${m.today.cap}` : ''} · Month {m.month.used}{m.month.cap != null ? ` of ${m.month.cap}` : ''} conversations · Owner questions today {m.assistantToday.used}</div>}
      <div className="small">Owners: {d.owners.map((o: any) => `${o.name ?? ''} ${o.email ?? o.phone ?? ''} (${o.role})`).join(', ')}</div>
      <div className="small">Powers: {d.powers.map((p: any) => `${p.type} (${p.status})`).join(', ') || 'none'} · Crew: {d.crew.map((c: any) => `${c.name}${c.enabled ? '' : ' off'}`).join(', ')}</div>

      <h4>Actions</h4>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select className="chip" value={b.status} onChange={(e) => patch({ status: e.target.value })}>{['onboarding', 'live', 'paused', 'suspended'].map((s) => <option key={s}>{s}</option>)}</select>
        {money && <select className="chip" value={b.plan} onChange={(e) => patch({ planCode: e.target.value })}>{plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>}
        <button className="btn small" onClick={() => act('ai', { paused: !b.ai_paused })}>{b.ai_paused ? 'Resume AI' : 'Pause AI'}</button>
        <button className="btn small" onClick={viewAs}>View as business</button>
        {money && <button className="btn small" onClick={() => { const p = prompt('Trial plan code (e.g. pro)', 'pro'); const days = Number(prompt('Days', '14')); if (p && days) act('trial', { plan: p, days }); }}>Trial / extend</button>}
        {money && <button className="btn small" onClick={() => { const a = Number(prompt('Credit amount (₹)')); if (a) act('credit', { amountInr: a, kind: 'credit', note: prompt('Note') ?? undefined }); }}>Add credit</button>}
        {money && <button className="btn small" onClick={() => { const a = Number(prompt('Refund amount (₹)')); const p = prompt('Razorpay payment id (optional)', d.payments[0]?.paymentId ?? ''); if (a) act('refund', { amountInr: a, paymentId: p || undefined }); }}>Refund</button>}
        <button className="btn small" onClick={() => { const raw = prompt('Custom limits as JSON, e.g. {"aiConversationsPerMonth": 3000}', JSON.stringify(b.limit_overrides ?? {})); if (raw) { try { act('limits', { limits: JSON.parse(raw) }); } catch { alert('That is not valid JSON.'); } } }}>Custom limits</button>
        {money && <button className="btn small" onClick={() => { const c = prompt('Coupon code (empty to remove)', b.applied_coupon ?? ''); if (c !== null) act('coupon', { code: c || null }); }}>Apply coupon</button>}
        {money && <button className="btn small" onClick={() => { const p = prompt('Plan for the founding price', b.plan); const a = prompt('Monthly price ₹ (empty to remove the lock)'); if (p) act('price-lock', a ? { plan: p, INR: Number(a) } : (null as any)); }}>Founding price</button>}
        {money && <button className="btn small" onClick={() => { const a = Number(prompt('Enterprise monthly price ₹')); if (a) act('enterprise', { priceInr: a }); }}>Enterprise deal</button>}
        {role === 'owner' && <button className="btn small" onClick={() => apiDownload(`/admin/centre/businesses/${id}/export`, `orbit-${b.slug}.json`).catch((e) => onError(e.message))}>Export data</button>}
        {role === 'owner' && <button className="btn small" style={{ color: '#ffb59e' }} onClick={del}>Delete…</button>}
      </div>

      <h4>Support notes</h4>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (note.trim()) act('notes', { body: note.trim() }).then(() => setNote('')); }}>
        <input className="input grow" placeholder="Add a note" value={note} onChange={(e) => setNote(e.target.value)} /><button className="btn small">Add</button>
      </form>
      {d.notes.map((n: any) => <div key={n.id} className="small">{n.body} <span className="muted">· {n.author} · {when(n.at)}</span></div>)}

      <h4>Plan history</h4>
      {d.planHistory.map((h: any, i: number) => <div key={i} className="small">{when(h.at)} · {h.kind} {h.from ?? '—'} → {h.to ?? '—'}{h.amount ? ` · ${inr(h.amount)}` : ''} ({h.source})</div>)}
      <h4>Payments</h4>
      {d.payments.length ? d.payments.map((p: any) => <div key={p.paymentId} className="small mono">{when(p.chargedAt)} · {p.plan} · {inr(p.amount)} · {p.paymentId}</div>) : <p className="small muted">No payments yet. Razorpay emails receipts and invoices to the owner.</p>}
      <h4>Wallet</h4>
      {d.wallet.map((w: any, i: number) => <div key={i} className="small">{when(w.at)} · {w.kind} {inr(w.amount)} {w.note ?? ''}</div>)}
      <h4>Messages from Orbit</h4>
      {d.messages.map((x: any, i: number) => <div key={i} className="small">{when(x.sentAt)} · {x.channel} · {x.subject} · {x.status}{x.readAt ? ' · read' : ''}</div>)}
    </div>
  );
}

// ------------------------------------------------------------ coupons and plan price changes

export function Coupons({ onError, role }: { onError: OnError; role: string }) {
  const { data, load } = useLoad<any[]>('/admin/coupons', onError);
  const { data: plans } = useLoad<any[]>('/admin/plans', onError);
  const [c, setC] = useState<any>({ code: '', kind: 'percent', value: 20, eligiblePlans: [], active: true });
  const can = role === 'owner' || role === 'finance';
  const save = async () => {
    try {
      await api('/admin/coupons', { body: { ...c, value: Number(c.value), maxUses: c.maxUses ? Number(c.maxUses) : null, validTo: c.validTo ? new Date(c.validTo).toISOString() : null }, business: false });
      load();
    } catch (e) {
      onError((e as ApiError).message);
    }
  };
  const applyPrice = async (code: string) => {
    const mode = prompt('After a price change, existing subscribers on this plan: keep (old terms), renewal (new price at next renewal) or now?', 'keep');
    if (!mode || !['keep', 'renewal', 'now'].includes(mode)) return;
    try {
      const r = await api<any>(`/admin/plans/${code}/apply-price`, { body: { mode }, business: false });
      alert(`${r.existing} existing subscriptions · moved ${r.moved}${r.failed.length ? ` · failed ${r.failed.length}` : ''}`);
    } catch (e) {
      onError((e as ApiError).message);
    }
  };
  return (
    <section className="stack">
      {can && (
        <div className="card stack">
          <h3>New or edit coupon</h3>
          <div className="grid">
            <label className="field"><span>Code</span><input className="input mono" value={c.code} onChange={(e) => setC({ ...c, code: e.target.value.toUpperCase() })} /></label>
            <label className="field"><span>Type</span><select className="input" value={c.kind} onChange={(e) => setC({ ...c, kind: e.target.value })}><option value="percent">% off</option><option value="amount">₹ off</option></select></label>
            <label className="field"><span>Value</span><input className="input" type="number" value={c.value} onChange={(e) => setC({ ...c, value: e.target.value })} /></label>
            <label className="field"><span>Valid until</span><input className="input" type="date" value={c.validTo ?? ''} onChange={(e) => setC({ ...c, validTo: e.target.value })} /></label>
            <label className="field"><span>Max uses</span><input className="input" type="number" value={c.maxUses ?? ''} onChange={(e) => setC({ ...c, maxUses: e.target.value })} /></label>
          </div>
          <div className="checks">{(plans ?? []).filter((p) => p.prices.INR > 0).map((p) => <label key={p.code} className="check-row"><input type="checkbox" checked={c.eligiblePlans.includes(p.code)} onChange={(e) => setC({ ...c, eligiblePlans: e.target.checked ? [...c.eligiblePlans, p.code] : c.eligiblePlans.filter((x: string) => x !== p.code) })} />{p.name}</label>)}</div>
          <button className="btn primary" disabled={!c.code} onClick={save}>Save coupon</button>
        </div>
      )}
      <div className="card table-wrap">
        <table className="table"><thead><tr><th>Code</th><th>Discount</th><th>Plans</th><th>Valid until</th><th>Used</th><th>Active</th></tr></thead>
          <tbody>{(data ?? []).map((x) => <tr key={x.code}><td className="mono">{x.code}</td><td>{x.kind === 'percent' ? `${x.value}%` : inr(x.value)}</td><td>{x.eligible_plans.join(', ') || 'all paid'}</td><td>{when(x.valid_to)}</td><td>{x.used}{x.max_uses ? ` / ${x.max_uses}` : ''}</td><td>{x.active ? 'yes' : 'no'}</td></tr>)}</tbody>
        </table>
      </div>
      {can && (
        <div className="card stack">
          <h3>After changing a plan&apos;s price</h3>
          <p className="small muted">New subscribers always get the new price. Choose what happens to people already on the plan (founding prices are never changed).</p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>{(plans ?? []).filter((p) => p.prices.INR > 0).map((p) => <button key={p.code} className="btn small" onClick={() => applyPrice(p.code)}>{p.name}: existing subscribers…</button>)}</div>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------ messaging centre

const SEGMENT_HELP = 'Plans (comma separated codes), renewal within N days, inactive for N days.';

export function Messaging({ onError, role }: { onError: OnError; role: string }) {
  const { data: templates, load: reloadT } = useLoad<any[]>('/admin/messaging/templates', onError);
  const { data: broadcasts, load: reloadB } = useLoad<any[]>('/admin/messaging/broadcasts', onError);
  const [sel, setSel] = useState<any>(null);
  const [lang, setLang] = useState<'en' | 'hi' | 'kn'>('en');
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const can = role !== 'viewer';
  const [b, setB] = useState<any>({ title: '', subject: '', body: '', plans: '', renewalWithinDays: '', inactiveDays: '', channels: ['inapp', 'email'], category: 'marketing', scheduledAt: '', link: '/bridge' });
  const [aud, setAud] = useState<any>(null);
  useEffect(() => {
    if (!sel) return;
    api<any>('/admin/messaging/preview', { body: { content: sel.content, lang }, business: false }).then(setPreview).catch(() => setPreview(null));
  }, [sel, lang]);
  const saveT = async () => {
    try {
      await api(`/admin/messaging/templates/${sel.key}`, { method: 'PUT', body: { content: sel.content, channels: sel.channels, enabled: sel.enabled }, business: false });
      reloadT();
    } catch (e) {
      onError((e as ApiError).message);
    }
  };
  const segment = () => ({
    ...(b.plans ? { plans: b.plans.split(',').map((x: string) => x.trim()).filter(Boolean) } : {}),
    ...(b.renewalWithinDays ? { renewalWithinDays: Number(b.renewalWithinDays) } : {}),
    ...(b.inactiveDays ? { inactiveDays: Number(b.inactiveDays) } : {}),
  });
  const audience = async () => setAud(await api('/admin/messaging/audience', { body: { segment: segment(), category: b.category }, business: false }).catch((e) => onError(e.message)));
  const create = async (sendNow: boolean) => {
    try {
      const r = await api<any>('/admin/messaging/broadcasts', { body: { title: b.title || b.subject, content: { en: { subject: b.subject, body: b.body } }, segment: segment(), channels: b.channels, category: b.category, link: b.link || undefined, scheduledAt: !sendNow && b.scheduledAt ? new Date(b.scheduledAt).toISOString() : undefined }, business: false });
      if (sendNow) await api(`/admin/messaging/broadcasts/${r.id}/send`, { body: {}, business: false });
      reloadB();
    } catch (e) {
      onError((e as ApiError).message);
    }
  };
  const statLine = (s: any) => (s ? `${s.total} messages · ${s.sent} sent · ${s.read} read · ${s.clicked} clicked${s.failed ? ` · ${s.failed} failed` : ''}${s.unavailable ? ` · ${s.unavailable} channel not available` : ''}${s.queued ? ` · ${s.queued} waiting (quiet hours)` : ''}` : '');
  return (
    <section className="stack">
      <p className="small muted">Messages from Orbit to business owners. In-app always works; email needs EMAIL_API_KEY on the server; WhatsApp and push to owners arrive with the Orbit Assistant number. Marketing respects opt-outs; email waits out quiet hours (9 pm to 9 am in the business&apos;s time).</p>
      <div className="card stack">
        <h3>Automatic messages</h3>
        <div className="card table-wrap"><table className="table"><thead><tr><th>Message</th><th>Channels</th><th>On</th><th>Stats</th></tr></thead>
          <tbody>{(templates ?? []).map((t) => <tr key={t.key} onClick={() => setSel(structuredClone(t))} style={{ cursor: 'pointer' }}><td><b>{t.name}</b><div className="small muted mono">{t.key}</div></td><td>{t.channels.join(', ')}</td><td>{t.enabled ? 'yes' : 'no'}</td><td className="small">{statLine(t.stats)}</td></tr>)}</tbody>
        </table></div>
        {sel && (
          <div className="stack">
            <div className="seg">{(['en', 'hi', 'kn'] as const).map((l) => <button key={l} className="chip" aria-current={lang === l} onClick={() => setLang(l)}>{l}</button>)}</div>
            <label className="field"><span>Subject</span><input className="input" value={sel.content[lang]?.subject ?? ''} onChange={(e) => setSel({ ...sel, content: { ...sel.content, [lang]: { ...(sel.content[lang] ?? { body: '' }), subject: e.target.value } } })} disabled={!can} /></label>
            <label className="field"><span>Text ({'{{owner}}, {{business}}, {{plan}}, {{date}}, {{amount}}, {{link}}'} …)</span><textarea className="input" rows={4} value={sel.content[lang]?.body ?? ''} onChange={(e) => setSel({ ...sel, content: { ...sel.content, [lang]: { ...(sel.content[lang] ?? { subject: '' }), body: e.target.value } } })} disabled={!can} /></label>
            <div className="checks">{['inapp', 'email', 'whatsapp', 'push'].map((ch) => <label key={ch} className="check-row"><input type="checkbox" disabled={!can} checked={sel.channels.includes(ch)} onChange={(e) => setSel({ ...sel, channels: e.target.checked ? [...sel.channels, ch] : sel.channels.filter((x: string) => x !== ch) })} />{ch}</label>)}<label className="check-row"><input type="checkbox" disabled={!can} checked={sel.enabled} onChange={(e) => setSel({ ...sel, enabled: e.target.checked })} />on</label></div>
            {preview && <div className="card small"><b>{preview.subject}</b><div style={{ whiteSpace: 'pre-wrap' }}>{preview.body}</div></div>}
            {can && <div className="row"><button className="btn primary small" onClick={saveT}>Save</button><button className="btn small" onClick={() => setSel(null)}>Close</button></div>}
          </div>
        )}
      </div>
      {can && (
        <div className="card stack">
          <h3>Send a message or broadcast</h3>
          <div className="grid">
            <label className="field"><span>Subject</span><input className="input" value={b.subject} onChange={(e) => setB({ ...b, subject: e.target.value })} /></label>
            <label className="field"><span>Kind</span><select className="input" value={b.category} onChange={(e) => setB({ ...b, category: e.target.value })}><option value="marketing">Announcement / offer (respects opt-out)</option><option value="transactional">Service notice</option></select></label>
            <label className="field"><span>Plans</span><input className="input" placeholder="pro, business" value={b.plans} onChange={(e) => setB({ ...b, plans: e.target.value })} /></label>
            <label className="field"><span>Renewal within (days)</span><input className="input" type="number" value={b.renewalWithinDays} onChange={(e) => setB({ ...b, renewalWithinDays: e.target.value })} /></label>
            <label className="field"><span>Inactive for (days)</span><input className="input" type="number" value={b.inactiveDays} onChange={(e) => setB({ ...b, inactiveDays: e.target.value })} /></label>
            <label className="field"><span>Schedule (optional)</span><input className="input" type="datetime-local" value={b.scheduledAt} onChange={(e) => setB({ ...b, scheduledAt: e.target.value })} /></label>
          </div>
          <label className="field"><span>Text ({'{{owner}}, {{business}}, {{link}}'})</span><textarea className="input" rows={4} value={b.body} onChange={(e) => setB({ ...b, body: e.target.value })} /></label>
          <div className="checks">{['inapp', 'email', 'whatsapp', 'push'].map((ch) => <label key={ch} className="check-row"><input type="checkbox" checked={b.channels.includes(ch)} onChange={(e) => setB({ ...b, channels: e.target.checked ? [...b.channels, ch] : b.channels.filter((x: string) => x !== ch) })} />{ch}</label>)}</div>
          <p className="small muted">{SEGMENT_HELP} Empty = every business.</p>
          <div className="row"><button className="btn small" onClick={audience}>Count audience</button>{aud && <span className="small">{aud.businesses} businesses · {aud.owners} owners</span>}</div>
          <div className="row"><button className="btn primary small" disabled={!b.subject || !b.body} onClick={() => create(!b.scheduledAt)}>{b.scheduledAt ? 'Schedule' : 'Send now'}</button><button className="btn small" disabled={!b.subject || !b.body} onClick={() => create(false)}>Save as draft</button></div>
        </div>
      )}
      <div className="card stack">
        <h3>Broadcasts</h3>
        {(broadcasts ?? []).map((x) => <div key={x.id} className="small"><b>{x.title}</b> · {x.status}{x.scheduled_at ? ` · ${when(x.scheduled_at)}` : ''} · {statLine(x.stats)}{can && x.status === 'draft' && <> · <button className="link-btn small" onClick={() => api(`/admin/messaging/broadcasts/${x.id}/send`, { body: {}, business: false }).then(reloadB)}>Send now</button></>}{can && ['draft', 'scheduled'].includes(x.status) && <> · <button className="link-btn small" onClick={() => api(`/admin/messaging/broadcasts/${x.id}/cancel`, { body: {}, business: false }).then(reloadB)}>Cancel</button></>}</div>)}
      </div>
    </section>
  );
}

// ------------------------------------------------------------ reports

export function Reports({ onError }: { onError: OnError }) {
  const { data: m } = useLoad<any>('/admin/reports/monthly?months=12', onError);
  const { data: cohorts } = useLoad<any[]>('/admin/reports/cohorts', onError);
  const [gstMonth, setGstMonth] = useState(new Date().toISOString().slice(0, 7));
  const { data: gst } = useLoad<any>(`/admin/reports/gst?month=${gstMonth}`, onError, [gstMonth]);
  const dl = (ds: string) => apiDownload(`/admin/export/${ds}`, `orbit-${ds}.csv`).catch((e) => onError(e.message));
  return (
    <section className="stack">
      <div className="card stack">
        <h3>Revenue, AI cost and margin by month</h3>
        <div className="table-wrap"><table className="table"><thead><tr><th>Month</th><th>Revenue (gross)</th><th>Net</th><th>AI cost</th><th>Margin</th><th>Signups</th><th>Paying</th><th>Upgrades</th><th>Upgrade rate</th><th>Churn rate</th></tr></thead>
          <tbody>{(m?.months ?? []).map((r: any) => <tr key={r.month}><td>{r.month}</td><td>{inr(r.gross)}</td><td>{inr(r.net)}</td><td>{inr(r.ai_cost)}</td><td>{inr(r.margin)}</td><td>{r.signups}</td><td>{r.paying}</td><td>{r.upgrades}</td><td>{r.upgradeRate == null ? '—' : `${r.upgradeRate}%`}</td><td>{r.churnRate == null ? '—' : `${r.churnRate}%`}</td></tr>)}</tbody>
        </table></div>
        <div className="small muted">By plan: {(m?.byPlan ?? []).map((r: any) => `${r.month} ${r.plan} ${inr(r.gross)}`).join(' · ') || '—'}</div>
        <div className="small muted">By provider: {(m?.byProvider ?? []).map((r: any) => `${r.month} ${r.provider} ${inr(r.inr)}`).join(' · ') || '—'}</div>
      </div>
      <div className="card stack">
        <h3>Cohorts (retention by signup month)</h3>
        <div className="table-wrap"><table className="table"><thead><tr><th>Signed up</th><th>Businesses</th><th>Active (30 days)</th><th>Paying now</th><th>Ever upgraded</th></tr></thead>
          <tbody>{(cohorts ?? []).map((c) => <tr key={c.cohort}><td>{c.cohort}</td><td>{c.businesses}</td><td>{c.active} ({Math.round((c.active / Math.max(1, c.businesses)) * 100)}%)</td><td>{c.paying}</td><td>{c.everUpgraded}</td></tr>)}</tbody>
        </table></div>
      </div>
      <div className="card stack">
        <div className="row between"><h3>GST summary for the accountant</h3><input className="input" type="month" style={{ maxWidth: 180 }} value={gstMonth} onChange={(e) => setGstMonth(e.target.value)} /></div>
        {gst && <div className="small">Gross {inr(gst.totals.gross)} · Taxable {inr(gst.totals.taxable)} · GST ({gst.rate}%) {inr(gst.totals.gst)} · {gst.rows.length} payments. <span className="muted">{gst.note}</span></div>}
        <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => dl('payments')}>Download payments CSV</button>
      </div>
      <div className="card stack">
        <h3>Exports (CSV, opens in Excel)</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>{['businesses', 'payments', 'plan_changes', 'ai_costs', 'approvals', 'owner_messages', 'audit'].map((d) => <button key={d} className="btn small" onClick={() => dl(d)}>{d.replace('_', ' ')}</button>)}</div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------ settings, feature switches, team

export function Settings({ onError, role }: { onError: OnError; role: string }) {
  const { data, load } = useLoad<Record<string, any>>('/admin/settings', onError);
  const { data: flags, load: reloadF } = useLoad<any[]>('/admin/features', onError);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const owner = role === 'owner';
  useEffect(() => {
    if (data) setDraft(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, JSON.stringify(v, null, 2)])));
  }, [data]);
  const save = async (key: string) => {
    try {
      await api(`/admin/settings/${key}`, { method: 'PUT', body: { value: JSON.parse(draft[key]) }, business: false });
      load();
    } catch (e) {
      onError(e instanceof SyntaxError ? 'That is not valid JSON.' : (e as ApiError).message);
    }
  };
  const m = data?.maintenance ?? { on: false, message: '', blockWrites: false };
  const setMaint = async (v: object) => {
    await api('/admin/settings/maintenance', { method: 'PUT', body: { value: { ...m, ...v } }, business: false }).catch((e) => onError(e.message));
    load();
  };
  const [flag, setFlag] = useState({ key: '', description: '', enabled: true });
  return (
    <section className="stack">
      <div className="card stack">
        <h3>Maintenance mode</h3>
        <label className="field"><span>Message to all owners</span><input className="input" disabled={!owner} defaultValue={m.message} onBlur={(e) => owner && e.target.value !== m.message && setMaint({ message: e.target.value })} /></label>
        <div className="checks">
          <label className="check-row"><input type="checkbox" disabled={!owner} checked={m.on} onChange={(e) => setMaint({ on: e.target.checked })} />Show the banner</label>
          <label className="check-row"><input type="checkbox" disabled={!owner} checked={m.blockWrites} onChange={(e) => setMaint({ blockWrites: e.target.checked })} />Pause changes (read-only for businesses)</label>
        </div>
      </div>
      <div className="card stack">
        <h3>Feature switches</h3>
        {(flags ?? []).map((f) => (
          <label key={f.key} className="check-row"><input type="checkbox" disabled={!owner} checked={f.enabled} onChange={(e) => api(`/admin/features/${f.key}`, { method: 'PUT', body: { enabled: e.target.checked, allow: f.allow, deny: f.deny }, business: false }).then(reloadF).catch((x) => onError(x.message))} /><b className="mono">{f.key}</b> <span className="small muted">{f.description}{f.allow.length ? ` · on for ${f.allow.length} businesses` : ''}{f.deny.length ? ` · off for ${f.deny.length}` : ''}</span></label>
        ))}
        {owner && (
          <div className="row"><input className="input mono" placeholder="feature.key" value={flag.key} onChange={(e) => setFlag({ ...flag, key: e.target.value })} /><input className="input grow" placeholder="What it does" value={flag.description} onChange={(e) => setFlag({ ...flag, description: e.target.value })} /><button className="btn small" disabled={!flag.key} onClick={() => api(`/admin/features/${flag.key}`, { method: 'PUT', body: { enabled: flag.enabled, description: flag.description }, business: false }).then(reloadF).catch((x) => onError(x.message))}>Add</button></div>
        )}
      </div>
      <div className="card stack">
        <h3>Thresholds and rules</h3>
        <p className="small muted">approval.rules: which cases need approval, the daily AI cost that pauses a business (ai_cost.dailyInr), top-ups above an amount, and the hours before the safe default applies. admin.notify: channels per alert type. costs.units: speech and messaging unit costs and the budget safety margin. billing.grace_days: days after a failed payment before Free. AI tiers and free/paid limits live in AI &amp; margins and Plans.</p>
        {['approval.rules', 'admin.notify', 'costs.units', 'billing.grace_days', 'addons'].map((k) => (
          <label key={k} className="field"><span className="mono">{k}</span>
            <textarea className="input mono" rows={k === 'billing.grace_days' ? 1 : 6} disabled={!owner} value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
            {owner && <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => save(k)}>Save {k}</button>}
          </label>
        ))}
      </div>
    </section>
  );
}

export function Team({ onError }: { onError: OnError }) {
  const { data, load } = useLoad<any[]>('/admin/team', onError);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('support');
  const call = (fn: () => Promise<unknown>) => fn().then(load).catch((e) => onError((e as ApiError).message));
  return (
    <section className="stack">
      <p className="small muted">Owner: everything. Finance: billing, costs, refunds, prices, approvals. Support: businesses and messages, no money actions. Viewer: read only. Everyone signs in with an authenticator code.</p>
      <form className="row card" onSubmit={(e) => { e.preventDefault(); call(() => api('/admin/team', { body: { email, role }, business: false })); setEmail(''); }}>
        <input className="input grow" type="email" placeholder="Their Orbit sign-in email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select className="input" style={{ maxWidth: 150 }} value={role} onChange={(e) => setRole(e.target.value)}>{['owner', 'finance', 'support', 'viewer'].map((r) => <option key={r}>{r}</option>)}</select>
        <button className="btn primary">Add</button>
      </form>
      <div className="card table-wrap"><table className="table"><thead><tr><th>Person</th><th>Role</th><th>2FA</th><th>Status</th><th /></tr></thead>
        <tbody>{(data ?? []).map((m) => (
          <tr key={m.userId}><td>{m.name ?? ''} <span className="muted">{m.login}</span></td>
            <td><select className="chip" value={m.role} onChange={(e) => call(() => api(`/admin/team/${m.userId}`, { method: 'PATCH', body: { role: e.target.value }, business: false }))}>{['owner', 'finance', 'support', 'viewer'].map((r) => <option key={r}>{r}</option>)}</select></td>
            <td>{m.twoFactor ? 'on' : 'not set up'}</td><td>{m.status}</td>
            <td className="row"><button className="link-btn small" onClick={() => call(() => api(`/admin/team/${m.userId}`, { method: 'PATCH', body: { status: m.status === 'active' ? 'disabled' : 'active' }, business: false }))}>{m.status === 'active' ? 'Disable' : 'Enable'}</button><button className="link-btn small" onClick={() => confirm('Reset their authenticator? They will set it up again at next sign-in.') && call(() => api(`/admin/team/${m.userId}/reset-2fa`, { body: {}, business: false }))}>Reset 2FA</button></td></tr>
        ))}</tbody>
      </table></div>
    </section>
  );
}
