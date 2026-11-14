'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { SpaceBackdrop } from '@/components/SpaceBackdrop';
import './admin.css';
import { AdminBell, AdminGate, Approvals, BusinessesCentre, Budgets, Coupons, Messaging, Overview, Reports, Settings, Subscriptions, Team } from './centre';

const AGENT_KEYS = ['orbit', 'aria', 'vox', 'nudge', 'ledger', 'spark'] as const;
const LIMIT_FIELDS: { key: string; label: string; nullable: boolean }[] = [
  { key: 'aiConversationsPerMonth', label: 'AI conversations / month', nullable: true },
  { key: 'aiConversationsPerDay', label: 'AI conversations / day (empty on paid = 3× daily share)', nullable: true },
  { key: 'dailyCapMultiplier', label: 'Paid daily cap × daily share', nullable: false },
  { key: 'graceMessages', label: 'Grace replies after a limit', nullable: false },
  { key: 'assistantPerDay', label: 'Owner questions to Orbit / day', nullable: true },
  { key: 'staffCalendars', label: 'Staff calendars', nullable: true },
  { key: 'locations', label: 'Locations', nullable: true },
  { key: 'callMinutesPerMonth', label: 'Call minutes / month', nullable: false },
  { key: 'tasksPerMonth', label: 'Tasks / month', nullable: true },
  { key: 'campaignsPerMonth', label: 'Campaigns / month', nullable: true },
  { key: 'storageMb', label: 'Storage (MB)', nullable: false },
];
const FEATURE_FLAGS: [string, string][] = [
  ['customDomain', 'Custom domain'], ['orbitBranding', 'Shows "Powered by Orbit"'], ['dailyBriefing', 'Daily briefing'],
  ['voiceCommands', 'Voice commands'], ['rewind', 'Rewind'], ['tomorrow', 'Tomorrow view'], ['advancedReports', 'Advanced reports'],
  ['multiBranch', 'Multi-branch'], ['googleBusinessProfile', 'Google Business Profile'], ['prioritySupport', 'Priority support'],
];

/** Platform admin panel (Orbit team). English only — internal tool. */
const TABS: { key: string; label: string; roles?: string[] }[] = [
  { key: 'overview', label: 'Overview' }, { key: 'businesses', label: 'Businesses' }, { key: 'subscriptions', label: 'Subscriptions' },
  { key: 'approvals', label: 'Approvals' }, { key: 'budgets', label: 'Budgets' }, { key: 'ai', label: 'AI & margins' },
  { key: 'plans', label: 'Plans' }, { key: 'coupons', label: 'Coupons' }, { key: 'messaging', label: 'Messaging' },
  { key: 'reports', label: 'Reports' }, { key: 'settings', label: 'Settings' }, { key: 'team', label: 'Team', roles: ['owner'] },
  { key: 'templates', label: 'Business templates' }, { key: 'health', label: 'Health' }, { key: 'audit', label: 'Audit' },
];

/** Platform admin centre (Orbit team). English only — internal tool. */
export default function Admin() {
  const { me, loading } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<string>(() => (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('tab')) || 'overview');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && (!me || !me.user.isPlatformAdmin)) router.replace('/');
  }, [loading, me, router]);

  const go = (t: string) => {
    setTab(t);
    setError(null);
    window.history.replaceState(null, '', `/admin?tab=${t}`);
  };

  return (
    <div className="space-theme">
      <SpaceBackdrop variant="app" />
      <main className="page wide admin">
        {!me?.user.isPlatformAdmin ? <p className="muted">Loading…</p> : (
          <AdminGate>
            {(role) => (
              <>
                <div className="topbar">
                  <div className="name">Orbit admin <span className="chip small">{role}</span></div>
                  <div className="row"><AdminBell onError={setError} /><a className="chip" href="/bridge">Back to The Bridge</a></div>
                </div>
                <nav className="views">
                  {TABS.filter((t) => !t.roles || t.roles.includes(role)).map((t) => (
                    <button key={t.key} className="chip" aria-current={tab === t.key} onClick={() => go(t.key)}>{t.label}</button>
                  ))}
                </nav>
                {error && <p className="error">{error}</p>}
                {tab === 'overview' && <Overview onError={setError} go={go} />}
                {tab === 'businesses' && <BusinessesCentre onError={setError} role={role} />}
                {tab === 'subscriptions' && <Subscriptions onError={setError} />}
                {tab === 'approvals' && <Approvals onError={setError} role={role} />}
                {tab === 'budgets' && <Budgets onError={setError} role={role} />}
                {tab === 'ai' && <AiAdmin onError={setError} />}
                {tab === 'plans' && <Plans onError={setError} />}
                {tab === 'coupons' && <Coupons onError={setError} role={role} />}
                {tab === 'messaging' && <Messaging onError={setError} role={role} />}
                {tab === 'reports' && <Reports onError={setError} />}
                {tab === 'settings' && <Settings onError={setError} role={role} />}
                {tab === 'team' && <Team onError={setError} />}
                {tab === 'templates' && <Templates onError={setError} />}
                {tab === 'health' && <Health />}
                {tab === 'audit' && <Audit />}
              </>
            )}
          </AdminGate>
        )}
      </main>
    </div>
  );
}

function NumField({ label, value, onChange, nullable }: { label: string; value: number | null; onChange: (v: number | null) => void; nullable?: boolean }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="input" type="number" min={0} step="any" inputMode="decimal" value={value ?? ''} placeholder={nullable ? 'Unlimited' : '0'}
        onChange={(e) => onChange(e.target.value === '' ? (nullable ? null : 0) : Number(e.target.value))} />
    </label>
  );
}

function Plans({ onError }: { onError: (e: string | null) => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [sel, setSel] = useState(0);
  const [draft, setDraft] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api<any[]>('/admin/plans', { business: false }).then(setItems).catch((e) => onError(e.message));
  }, [onError]);
  useEffect(() => {
    const p = items[sel];
    if (p) setDraft(structuredClone({ name: p.name, prices: p.prices, limits: p.limits, features: p.features, active: p.active ?? true }));
    setSaved(false);
  }, [items, sel]);
  if (!draft) return <p className="muted">Loading…</p>;
  const set = (path: string[], v: unknown) => {
    setSaved(false);
    setDraft((d: any) => {
      const n = structuredClone(d);
      let o = n;
      for (const k of path.slice(0, -1)) o = o[k] ??= {};
      o[path[path.length - 1]] = v;
      return n;
    });
  };
  const agents: string[] = draft.features.agents ?? [];
  const allPowers = draft.features.powers?.includes('*');
  const save = async () => {
    onError(null);
    try {
      await api(`/admin/plans/${items[sel].code}`, { method: 'PUT', body: draft, business: false });
      setItems((xs) => xs.map((x, i) => (i === sel ? { ...x, ...draft } : x)));
      setSaved(true);
    } catch (e) {
      onError((e as ApiError).message);
    }
  };
  return (
    <section className="stack">
      <p className="small muted">Prices, limits and features for each plan. Changes apply immediately, no deploy needed.</p>
      <div className="seg">
        {items.map((p, i) => <button key={p.code} className="chip" aria-current={i === sel} onClick={() => setSel(i)}>{p.name}</button>)}
      </div>
      <div className="card stack">
        <h3>Basics</h3>
        <div className="grid">
          <label className="field"><span>Plan name</span><input className="input" value={draft.name} onChange={(e) => set(['name'], e.target.value)} /></label>
          <NumField label="Monthly price (₹ INR)" value={draft.prices.INR} onChange={(v) => set(['prices', 'INR'], v ?? 0)} />
          <NumField label="Monthly price ($ USD)" value={draft.prices.USD} onChange={(v) => set(['prices', 'USD'], v ?? 0)} />
          <label className="check-row"><input type="checkbox" checked={draft.active} onChange={(e) => set(['active'], e.target.checked)} /> Available to new sign-ups</label>
        </div>
      </div>
      <div className="card stack">
        <h3>Limits <span className="small muted">(leave empty for unlimited)</span></h3>
        <div className="grid">
          {LIMIT_FIELDS.map((f) => <NumField key={f.key} label={f.label} nullable={f.nullable} value={draft.limits[f.key] ?? null} onChange={(v) => set(['limits', f.key], v)} />)}
          <label className="field"><span>Past a limit</span>
            <select className="input" value={draft.limits.overage ?? 'block'} onChange={(e) => set(['limits', 'overage'], e.target.value)}>
              <option value="block">Stop and ask to upgrade</option>
              <option value="wallet">Pay As You Go wallet when topped up</option>
            </select>
          </label>
        </div>
      </div>
      <div className="card stack">
        <h3>AI tier</h3>
        <select className="input" value={draft.features.aiTier ?? 'free'} onChange={(e) => set(['features', 'aiTier'], e.target.value)}>
          <option value="free">Free — low-cost, fast</option>
          <option value="standard">Standard — better conversations</option>
          <option value="premium">Premium — strongest models</option>
        </select>
        <label className="check-row"><input type="checkbox" checked={!!draft.features.customPricing} onChange={(e) => set(['features', 'customPricing'], e.target.checked)} /> Custom pricing (not bought online)</label>
        <h3>Crew on this plan</h3>
        <div className="checks">
          {AGENT_KEYS.map((a) => (
            <label key={a} className="check-row"><input type="checkbox" checked={agents.includes(a)} disabled={a === 'orbit'}
              onChange={(e) => set(['features', 'agents'], e.target.checked ? [...agents, a] : agents.filter((x) => x !== a))} /> {a[0].toUpperCase() + a.slice(1)}</label>
          ))}
        </div>
        <h3>Features</h3>
        <div className="checks">
          {FEATURE_FLAGS.map(([k, label]) => (
            <label key={k} className="check-row"><input type="checkbox" checked={!!draft.features[k]} onChange={(e) => set(['features', k], e.target.checked)} /> {label}</label>
          ))}
        </div>
        <h3>Powers (connections)</h3>
        <label className="check-row"><input type="checkbox" checked={!!allPowers} onChange={(e) => set(['features', 'powers'], e.target.checked ? ['*'] : ['website_chat', 'chat_link'])} /> All powers</label>
        {!allPowers && (
          <label className="field"><span>Allowed powers, comma separated</span>
            <input className="input" value={(draft.features.powers ?? []).join(', ')} onChange={(e) => set(['features', 'powers'], e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
          </label>
        )}
      </div>
      <div className="row"><button className="btn primary" onClick={save}>Save {draft.name}</button>{saved && <span className="note">Saved.</span>}</div>
    </section>
  );
}

function Templates({ onError }: { onError: (e: string | null) => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [sel, setSel] = useState(0);
  const [c, setC] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api<any[]>('/admin/templates', { business: false }).then(setItems).catch((e) => onError(e.message));
  }, [onError]);
  useEffect(() => {
    if (items[sel]) setC(structuredClone(items[sel].content));
    setSaved(false);
  }, [items, sel]);
  if (!c) return <p className="muted">Loading…</p>;
  const upd = (fn: (n: any) => void) => {
    setSaved(false);
    setC((d: any) => { const n = structuredClone(d); fn(n); return n; });
  };
  const save = async () => {
    onError(null);
    try {
      const r = await api<{ version: number }>(`/admin/templates/${c.type}`, { method: 'PUT', body: { content: c }, business: false });
      setItems((xs) => xs.map((x, i) => (i === sel ? { ...x, content: c, version: r?.version ?? x.version + 1 } : x)));
      setSaved(true);
    } catch (e) {
      onError((e as ApiError).message);
    }
  };
  const lines = (arr: string[] | undefined) => (arr ?? []).join('\n');
  const fromLines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  return (
    <section className="stack">
      <p className="small muted">Business-type templates used during onboarding. Each save creates a new version; businesses already set up are not changed.</p>
      <select className="input" value={sel} onChange={(e) => setSel(Number(e.target.value))}>
        {items.map((it, i) => <option key={it.type} value={i}>{it.type} (v{it.version})</option>)}
      </select>
      <div className="card stack">
        <h3>Basics</h3>
        <div className="grid">
          <label className="field"><span>Placeholder business name</span><input className="input" value={c.defaultName ?? ''} onChange={(e) => upd((n) => { n.defaultName = e.target.value; })} /></label>
          <label className="field"><span>Icon</span><input className="input" value={c.icon ?? ''} onChange={(e) => upd((n) => { n.icon = e.target.value; })} /></label>
        </div>
      </div>
      <div className="card stack">
        <div className="row between"><h3>Services</h3><button className="btn small" onClick={() => upd((n) => { n.services.push({ name: '', durationMin: 30, price: null }); })}>+ Add service</button></div>
        <div className="svc-head small muted"><span>Name</span><span>Minutes</span><span>Price ₹</span><span /></div>
        {c.services.map((s: any, i: number) => (
          <div key={i} className="svc-row">
            <input className="input" aria-label="Service name" value={s.name} onChange={(e) => upd((n) => { n.services[i].name = e.target.value; })} />
            <input className="input" aria-label="Minutes" type="number" min={5} value={s.durationMin} onChange={(e) => upd((n) => { n.services[i].durationMin = Number(e.target.value); })} />
            <input className="input" aria-label="Price" type="number" min={0} placeholder="Ask" value={s.price ?? ''} onChange={(e) => upd((n) => { n.services[i].price = e.target.value === '' ? null : Number(e.target.value); })} />
            <button className="icon-btn" aria-label="Remove service" disabled={c.services.length <= 1} onClick={() => upd((n) => { n.services.splice(i, 1); })}>✕</button>
          </div>
        ))}
      </div>
      <div className="card stack">
        <div className="row between"><h3>FAQs</h3><button className="btn small" onClick={() => upd((n) => { (n.faqs ??= []).push({ question: '', answer: '' }); })}>+ Add FAQ</button></div>
        {(c.faqs ?? []).map((f: any, i: number) => (
          <div key={i} className="faq-row">
            <input className="input" placeholder="Question" value={f.question} onChange={(e) => upd((n) => { n.faqs[i].question = e.target.value; })} />
            <textarea className="input" placeholder="Answer" rows={2} value={f.answer} onChange={(e) => upd((n) => { n.faqs[i].answer = e.target.value; })} />
            <button className="link-btn small" onClick={() => upd((n) => { n.faqs.splice(i, 1); })}>Remove</button>
          </div>
        ))}
      </div>
      <div className="card stack">
        <h3>Aria</h3>
        <label className="field"><span>Questions Aria asks new leads (one per line, up to 3)</span>
          <textarea className="input" rows={3} value={lines(c.qualifyingQuestions)} onChange={(e) => upd((n) => { n.qualifyingQuestions = fromLines(e.target.value).slice(0, 3); })} />
        </label>
        <label className="field"><span>Extra rules for Aria (one per line)</span>
          <textarea className="input" rows={3} value={lines(c.ariaRules)} onChange={(e) => upd((n) => { n.ariaRules = fromLines(e.target.value); })} />
        </label>
        <h3>Crew switched on by default</h3>
        <div className="checks">
          {AGENT_KEYS.filter((a) => a !== 'orbit').map((a) => (
            <label key={a} className="check-row"><input type="checkbox" checked={c.agentSettings?.[a]?.enabled ?? false}
              onChange={(e) => upd((n) => { (n.agentSettings ??= {})[a] = { enabled: e.target.checked }; })} /> {a[0].toUpperCase() + a.slice(1)}</label>
          ))}
        </div>
        <p className="small muted">Opening hours and follow-up sequences keep their current values; the owner edits them during onboarding.</p>
      </div>
      <div className="row"><button className="btn primary" onClick={save}>Save template</button>{saved && <span className="note">Saved as a new version.</span>}</div>
    </section>
  );
}

function Health() {
  const [h, setH] = useState<any>(null);
  useEffect(() => {
    api('/admin/health', { business: false }).then(setH);
  }, []);
  if (!h) return <p className="muted">Loading…</p>;
  const stats: { v: string | number; l: string; bad?: boolean }[] = [
    { v: h.businesses, l: `businesses · ${h.live} live` },
    { v: h.users, l: 'users' },
    { v: `${h.dbLatencyMs} ms`, l: 'database response', bad: h.dbLatencyMs > 200 },
    { v: h.queuedTasks, l: 'queued tasks' },
    { v: h.failedTasks24h, l: 'failed tasks (24h)', bad: h.failedTasks24h > 0 },
  ];
  return (
    <section className="stat-grid">
      {stats.map((s) => (
        <div key={s.l} className={`card stat ${s.bad ? 'bad' : ''}`}><b>{s.v}</b><span>{s.l}</span></div>
      ))}
    </section>
  );
}

function Audit() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    api<any[]>('/admin/audit', { business: false }).then(setRows);
  }, []);
  return (
    <div className="card table-wrap">
      <table className="table">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Business</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}><td className="small">{new Date(r.at).toLocaleString()}</td><td className="small">{r.actor ?? r.actor_kind}</td><td>{r.action}</td><td className="small mono">{r.business_id ? r.business_id.slice(0, 8) : '—'}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TIERS = ['free', 'standard', 'premium'] as const;
const TASKS: [string, string][] = [['conversation', 'Customer conversations'], ['command', 'Command Orbit / planning'], ['simple', 'Simple, low-risk text']];
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** AI routing per tier and task, the AI budget %, and the margin dashboard. Internal only. */
function AiAdmin({ onError }: { onError: (e: string | null) => void }) {
  const [r, setR] = useState<any>(null);
  const [draft, setDraft] = useState<any>(null);
  const [budget, setBudget] = useState<any>(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [m, setM] = useState<any>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    api<any>('/admin/ai/routing', { business: false }).then((x) => { setR(x); setDraft(structuredClone(x.routing)); }).catch((e) => onError(e.message));
    api<any>('/admin/ai/budget', { business: false }).then(setBudget).catch((e) => onError(e.message));
  }, [onError]);
  useEffect(() => {
    api<any>(`/admin/ai/margins?month=${month}`, { business: false }).then(setM).catch((e) => onError(e.message));
  }, [month, onError, saved]);
  if (!draft || !budget) return <p className="muted">Loading…</p>;
  const setRoute = (tier: string, task: string, k: 'provider' | 'model', v: string) => setDraft((d: any) => { const n = structuredClone(d); n[tier].routes[task][k] = v; return n; });
  const setFallback = (tier: string, v: string) =>
    setDraft((d: any) => {
      const n = structuredClone(d);
      n[tier].fallback = v.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [provider, ...rest] = x.split('/'); return { provider, model: rest.join('/') }; });
      return n;
    });
  const saveRouting = async () => {
    onError(null);
    try { await api('/admin/ai/routing', { method: 'PUT', body: draft, business: false }); setSaved('routing'); } catch (e) { onError((e as ApiError).message); }
  };
  const saveBudget = async () => {
    onError(null);
    try { await api('/admin/ai/budget', { method: 'PUT', body: budget, business: false }); setSaved(`budget${Date.now()}`); } catch (e) { onError((e as ApiError).message); }
  };
  return (
    <section className="stack">
      <div className="card stack">
        <h3>AI routing</h3>
        <p className="small muted">Which provider and model serve each tier and task. Plans pick a tier (Plans tab). Fallbacks are tried in order on errors or rate limits, then lower tiers' routes; never higher ones. Keys on this server: Groq {r.providers.groq ? '✓' : '✗'} · Anthropic {r.providers.claude ? '✓' : '✗'}. Businesses only ever see "Orbit".</p>
        {TIERS.map((tier) => (
          <div key={tier} className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <b>{tier[0].toUpperCase() + tier.slice(1)}</b>
            <div className="grid">
              {TASKS.map(([task, label]) => (
                <label key={task} className="field"><span>{label}</span>
                  <div className="row">
                    <select className="input" style={{ maxWidth: 110 }} value={draft[tier].routes[task].provider} onChange={(e) => setRoute(tier, task, 'provider', e.target.value)}>
                      <option value="groq">groq</option><option value="claude">claude</option>
                    </select>
                    <input className="input grow" value={draft[tier].routes[task].model} onChange={(e) => setRoute(tier, task, 'model', e.target.value)} />
                  </div>
                </label>
              ))}
              <label className="field"><span>Fallbacks (provider/model, comma separated)</span>
                <input className="input" defaultValue={draft[tier].fallback.map((f: any) => `${f.provider}/${f.model}`).join(', ')} onBlur={(e) => setFallback(tier, e.target.value)} />
              </label>
            </div>
          </div>
        ))}
        <div className="row"><button className="btn primary" onClick={saveRouting}>Save routing</button>{saved === 'routing' && <span className="note">Saved. Applies within 30 seconds.</span>}</div>
      </div>

      <div className="card stack">
        <h3>AI cost budget</h3>
        <div className="grid">
          <NumField label="AI budget (% of net revenue)" value={budget.budgetPct} onChange={(v) => setBudget({ ...budget, budgetPct: v ?? 25 })} />
          <NumField label="Net revenue factor (after GST and gateway fees)" value={budget.netRevenueFactor} onChange={(v) => setBudget({ ...budget, netRevenueFactor: v ?? 0.83 })} />
          <NumField label="USD → INR (for AI costs)" value={budget.usdInr} onChange={(v) => setBudget({ ...budget, usdInr: v ?? 84 })} />
        </div>
        <div className="row"><button className="btn primary" onClick={saveBudget}>Save budget</button></div>
      </div>

      <div className="card stack">
        <div className="row between"><h3>Margins</h3><input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ maxWidth: 180 }} /></div>
        {!m ? <p className="muted">Loading…</p> : (
          <>
            <div className="stat-grid">
              <div className="stat"><b>{inr(m.total.revenueNet)}</b><span>net revenue</span></div>
              <div className="stat"><b>{inr(m.total.aiBudget)}</b><span>AI budget ({m.settings.budgetPct}%)</span></div>
              <div className="stat"><b>{inr(m.total.aiCost)}</b><span>actual AI cost</span></div>
              <div className={`stat ${m.total.difference < 0 ? 'bad' : ''}`}><b>{inr(m.total.difference)}</b><span>difference</span></div>
              <div className="stat"><b>{inr(m.transferToAiAccount)}</b><span>move to AI costs account</span></div>
            </div>
            <h4>By plan</h4>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Plan</th><th>Businesses</th><th>Net revenue</th><th>AI budget</th><th>AI cost</th><th>Avg cost</th><th>Difference</th></tr></thead>
              <tbody>{m.byPlan.map((p: any) => <tr key={p.plan} className={p.overBudget ? 'flag' : ''}><td>{p.plan}{p.overBudget ? ' ⚠' : ''}</td><td>{p.businesses}</td><td>{inr(p.revenueNet)}</td><td>{inr(p.aiBudget)}</td><td>{inr(p.aiCost)}</td><td>{inr(p.avgAiCost)}</td><td>{inr(p.difference)}</td></tr>)}</tbody>
            </table></div>
            <h4>Businesses (highest AI cost first)</h4>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Business</th><th>Plan</th><th>Conversations</th><th>Net revenue</th><th>AI budget</th><th>AI cost</th><th>Difference</th><th>Failovers</th></tr></thead>
              <tbody>{m.businesses.slice(0, 100).map((b: any) => <tr key={b.id} className={b.overBudget ? 'flag' : ''}><td>{b.name}{b.overBudget ? ' ⚠' : ''}</td><td>{b.plan}</td><td>{b.conversations}</td><td>{inr(b.revenueNet)}</td><td>{inr(b.aiBudget)}</td><td>{inr(b.aiCost)}</td><td>{inr(b.difference)}</td><td>{b.failovers}</td></tr>)}</tbody>
            </table></div>
            <h4>By provider and model</h4>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Provider</th><th>Model</th><th>Tier</th><th>Task</th><th>Calls</th><th>Failed</th><th>Tokens in/out</th><th>Cost</th></tr></thead>
              <tbody>{m.byProvider.map((p: any, i: number) => <tr key={i}><td>{p.provider}</td><td>{p.model}</td><td>{p.tier ?? '—'}</td><td>{p.taskType ?? '—'}</td><td>{p.calls}</td><td>{p.failed}</td><td>{p.inputTokens}/{p.outputTokens}</td><td>{inr(p.costInr ?? 0)}</td></tr>)}</tbody>
            </table></div>
          </>
        )}
      </div>
    </section>
  );
}
