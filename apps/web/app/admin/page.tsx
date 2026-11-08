'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, session } from '@/lib/api';
import { useSession } from '@/lib/session';

/** Platform admin panel (Orbit team). English only — internal tool. */
export default function Admin() {
  const { me, loading } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<'businesses' | 'plans' | 'templates' | 'health' | 'audit'>('businesses');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && (!me || !me.user.isPlatformAdmin)) router.replace('/');
  }, [loading, me, router]);
  if (!me?.user.isPlatformAdmin) return <main className="page">Loading…</main>;

  return (
    <main className="page wide">
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
      {tab === 'plans' && <JsonEditor kind="plans" onError={setError} />}
      {tab === 'templates' && <JsonEditor kind="templates" onError={setError} />}
      {tab === 'health' && <Health />}
      {tab === 'audit' && <Audit />}
    </main>
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
          </tbody>
        </table>
      </div>
    </section>
  );
}

function JsonEditor({ kind, onError }: { kind: 'plans' | 'templates'; onError: (e: string | null) => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [sel, setSel] = useState(0);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api<any[]>(`/admin/${kind}`, { business: false }).then((r) => {
      setItems(r);
      setSel(0);
    });
  }, [kind]);
  const item = items[sel];
  useEffect(() => {
    if (!item) return;
    setText(JSON.stringify(kind === 'plans' ? { name: item.name, prices: item.prices, limits: item.limits, features: item.features, active: item.active } : item.content, null, 2));
  }, [item, kind]);
  const save = async () => {
    onError(null);
    setSaved(false);
    try {
      const body = JSON.parse(text);
      if (kind === 'plans') await api(`/admin/plans/${item.code}`, { method: 'PUT', body, business: false });
      else await api(`/admin/templates/${item.type}`, { method: 'PUT', body: { content: body }, business: false });
      setSaved(true);
    } catch (e) {
      onError(e instanceof SyntaxError ? 'That is not valid JSON.' : (e as ApiError).message);
    }
  };
  return (
    <section className="stack">
      <p className="small muted">{kind === 'plans' ? 'Prices, limits and features for each plan. Changes apply immediately, no deploy needed.' : 'Business-type templates used during onboarding (services, hours, FAQs, sequences, agent settings). Each save creates a new version.'}</p>
      <select className="input" value={sel} onChange={(e) => setSel(Number(e.target.value))}>
        {items.map((it, i) => <option key={i} value={i}>{kind === 'plans' ? it.name : `${it.type} (v${it.version})`}</option>)}
      </select>
      <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <button className="btn primary" onClick={save}>Save</button>
      {saved && <p className="note">Saved.</p>}
    </section>
  );
}

function Health() {
  const [h, setH] = useState<any>(null);
  useEffect(() => {
    api('/admin/health', { business: false }).then(setH);
  }, []);
  if (!h) return <p className="muted">Loading…</p>;
  return (
    <section className="card">
      <div className="numbers">
        <div className="num"><b>{h.businesses}</b><span>businesses ({h.live} live)</span></div>
        <div className="num"><b>{h.users}</b><span>users</span></div>
        <div className="num"><b>{h.dbLatencyMs} ms</b><span>database</span></div>
        <div className="num"><b>{h.queuedTasks}</b><span>queued tasks</span></div>
        <div className="num"><b>{h.failedTasks24h}</b><span>failed tasks (24h)</span></div>
      </div>
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
            <tr key={i}><td className="small">{new Date(r.at).toLocaleString()}</td><td className="small">{r.actor ?? r.actor_kind}</td><td>{r.action}</td><td className="small">{r.business_id ?? '—'}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
