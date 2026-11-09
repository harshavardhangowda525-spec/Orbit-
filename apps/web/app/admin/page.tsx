'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, session } from '@/lib/api';
import { useSession } from '@/lib/session';
import { SpaceBackdrop } from '@/components/SpaceBackdrop';
import './admin.css';

const AGENT_KEYS = ['orbit', 'aria', 'vox', 'nudge', 'ledger', 'spark'] as const;
const LIMIT_FIELDS: { key: string; label: string; nullable: boolean }[] = [
  { key: 'aiConversationsPerMonth', label: 'AI conversations / month', nullable: true },
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
export default function Admin() {
  const { me, loading } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<'businesses' | 'plans' | 'templates' | 'health' | 'audit'>('businesses');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && (!me || !me.user.isPlatformAdmin)) router.replace('/');
  }, [loading, me, router]);

  return (
    <div className="space-theme">
      <SpaceBackdrop variant="app" />
      <main className="page wide admin">
        {!me?.user.isPlatformAdmin ? <p className="muted">Loading…</p> : (
          <>
            <div className="topbar">
              <div className="name">Orbit admin</div>
              <a className="chip" href="/bridge">Back to The Bridge</a>
            </div>
            <nav className="views">
              {(['businesses', 'plans', 'templates', 'health', 'audit'] as const).map((t) => (
                <button key={t} className="chip" aria-current={tab === t} onClick={() => { setTab(t); setError(null); }}>{t[0].toUpperCase() + t.slice(1)}</button>
              ))}
            </nav>
            {error && <p className="error">{error}</p>}
            {tab === 'businesses' && <Businesses onError={setError} />}
            {tab === 'plans' && <Plans onError={setError} />}
            {tab === 'templates' && <Templates onError={setError} />}
            {tab === 'health' && <Health />}
            {tab === 'audit' && <Audit />}
          </>
        )}
      </main>
    </div>
  );
}

function Businesses({ onError }: { onError: (e: string | null) => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const load = useCallback(() => {
    api(`/admin/businesses${q ? `?q=${encodeURIComponent(q)}` : ''}`, { business: false }).then(setRows).catch((e) => onError(e.message));
  }, [q, onError]);
  useEffect(() => {
    load();
    api('/admin/plans', { business: false }).then(setPlans).catch(() => undefined);
  }, [load]);

  const patch = async (id: string, body: object) => {
    try {
      await api(`/admin/businesses/${id}`, { method: 'PATCH', body, business: false });
      load();
    } catch (e) {
      onError((e as ApiError).message);
    }
  };
  const impersonate = async (id: string) => {
    if (!confirm('View this business as its owner? This is recorded in the audit log.')) return;
    const r = await api<{ token: string }>(`/admin/businesses/${id}/impersonate`, { body: {}, business: false });
    // Keep the admin token in this tab only so the admin can come back.
    sessionStorage.setItem('orbit.admin.token', session.token() ?? '');
    session.setToken(r.token);
    session.setBusinessId(id);
    window.location.href = '/bridge';
  };

  return (
    <section className="stack">
      <form className="row" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <input className="input grow" placeholder="Search by name or link" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn">Search</button>
      </form>
      <div className="card table-wrap">
        <table className="table">
          <thead>
            <tr><th>Business</th><th>Status</th><th>Plan</th><th>Usage (month)</th><th>Health</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td><b>{b.name}</b><div className="small muted">/{b.slug} · {b.type}</div></td>
                <td>
                  <select className="chip" value={b.status} onChange={(e) => patch(b.id, { status: e.target.value })}>
                    {['onboarding', 'live', 'paused', 'suspended'].map((s) => <option key={s}>{s}</option>)}
                  </select>
                  {b.status === 'onboarding' && <div className="small muted">step {b.onboardingStep}</div>}
                </td>
                <td>
                  <select className="chip" value={b.plan} onChange={(e) => patch(b.id, { planCode: e.target.value })}>
                    {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                  </select>
                </td>
                <td className="small">{b.aiMessages} AI msgs · {b.callMinutes} min · {b.tasks} tasks<br />{b.customers} customers · {b.bookings30d} bookings/30d</td>
                <td className="small">{b.failedTasks7d > 0 ? `⚠️ ${b.failedTasks7d} failed tasks` : '✓'}</td>
                <td><button className="btn small" onClick={() => impersonate(b.id)}>View as owner</button></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted">No businesses found.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Number input where an empty box means "unlimited" (null). */
function NumField({ label, value, onChange, nullable }: { label: string; value: number | null; onChange: (v: number | null) => void; nullable?: boolean }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="input" type="number" min={0} inputMode="numeric" value={value ?? ''} placeholder={nullable ? 'Unlimited' : '0'}
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
              <option value="charge">Keep going, charge per unit</option>
            </select>
          </label>
        </div>
      </div>
      <div className="card stack">
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
