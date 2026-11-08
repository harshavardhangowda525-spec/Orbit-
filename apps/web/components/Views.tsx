'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { BridgeData } from '@/lib/bridge-types';
import { AgentDot } from './bridge/Hero';
import { timeAgo } from './bridge/Feed';

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api<T>(path).then(setData).catch((e) => setError((e as ApiError).message));
  }, [path]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, reload };
}

/** Crew: each agent as a card — status, today's work, and its recent tasks. */
export function CrewView({ data, selected, onSelect }: { data: BridgeData; selected: string | null; onSelect: (a: string) => void }) {
  const { t, ts } = useI18n();
  const { data: tasks } = useLoad<{ id: string; agent: string; goal: string; status: string; createdAt: string }[]>('/tasks');
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = (agent: string) => data.feed.filter((g) => g.agent === agent && g.at.slice(0, 10) === today).reduce((n, g) => n + g.items.length, 0);
  const sel = selected ?? 'aria';
  const crew = data.crew.filter((c) => c.agent !== 'orbit');
  return (
    <section className="stack">
      <div>
        <h2>{t('view.crew')}</h2>
        <p className="muted small">{t('crew.sub')}</p>
      </div>
      <div className="crew-grid2">
        {crew.map((a) => (
          <button key={a.agent} className={`crew-card2 ${sel === a.agent ? 'sel' : ''}`} data-agent={a.agent} onClick={() => onSelect(a.agent)} style={{ textAlign: 'left', cursor: 'pointer', color: 'var(--ink)' }}>
            <AgentDot agent={a.agent} size="lg" />
            <b>{a.name}</b>
            <span className="small muted">{t(`agent.${a.agent}.role`)}</span>
            <span className={`status-pill ${a.working ? 'working' : ''}`}>
              <i />
              {a.enabled ? (a.working ? t('crew.status.working') : t('crew.status.idle')) : t('crew.off')}
            </span>
            {a.enabled ? <span className="small">{t('crew.done_today', { count: doneToday(a.agent) })}</span> : <span className="small muted">{t('crew.upgrade')}</span>}
          </button>
        ))}
      </div>
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <AgentDot agent={sel} />
          <b>{data.crew.find((c) => c.agent === sel)?.name}</b>
        </div>
        <ul className="feed2">
          {data.feed.filter((g) => g.agent === sel).slice(0, 8).map((g) => (
            <li key={g.id} className="small">{ts(g.sentence)} <span className="muted">· {timeAgo(g.at, t)}</span></li>
          ))}
          {(tasks ?? []).filter((x) => x.agent === sel).slice(0, 5).map((x) => (
            <li key={x.id} className="small muted">{x.goal} · {t(`task.${x.status}`)}</li>
          ))}
        </ul>
        {!data.feed.some((g) => g.agent === sel) && <p className="muted small">{t('crew.nothing_yet')}</p>}
      </div>
    </section>
  );
}

export function PeopleView() {
  const { t, money } = useI18n();
  const { data, error } = useLoad<any[]>('/customers');
  return (
    <section className="stack">
      <h2>{t('view.people')}</h2>
      {error && <p className="error">{error}</p>}
      {data && data.length === 0 && <p className="muted">{t('people.empty')}</p>}
      <div className="card">
        {data?.map((c) => (
          <div key={c.id} className="list-item">
            <span className="agent-dot a-orbit">{(c.name ?? '?')[0]}</span>
            <div className="grow">
              <b>{c.name ?? c.phone}</b>
              <div className="small muted">{t('people.line', { visits: c.visitCount, spend: money(c.lifetimeSpend) })}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const GROUPS = ['calendar', 'messaging', 'payments', 'records', 'presence'];

/** Powers: what each service lets Orbit do, and one tap to connect or disconnect. */
export function PowersView() {
  const { t } = useI18n();
  const { data, error, reload } = useLoad<{ type: string; group: string; available: boolean; onPlan: boolean; connection: { id: string; status: string; account: string | null; error: string | null; lastSyncAt: string | null } | null }[]>('/powers');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const connect = async (type: string) => {
    setBusy(type);
    setMsg(null);
    try {
      const r = await api<{ url: string }>(`/powers/${type}/connect`, { body: {} });
      window.location.href = r.url;
    } catch (e) {
      setMsg((e as ApiError).message);
      setBusy(null);
    }
  };
  const disconnect = async (id: string, type: string) => {
    if (!confirm(t('powers.confirm_disconnect', { power: t(`power.${type}`) }))) return;
    setBusy(type);
    await api(`/powers/${id}`, { method: 'DELETE' }).catch((e) => setMsg((e as ApiError).message));
    setBusy(null);
    reload();
  };
  return (
    <section className="stack">
      <div>
        <h2>{t('view.powers')}</h2>
        <p className="muted small">{t('powers.sub')}</p>
      </div>
      {(error || msg) && <p className="error">{error ?? msg}</p>}
      {GROUPS.map((g) => {
        const items = (data ?? []).filter((p) => p.group === g);
        if (!items.length) return null;
        return (
          <div key={g} className="card">
            <h3 className="small muted">{t(`powers.group.${g}`)}</h3>
            {items.map((p) => (
              <div key={p.type} className="list-item" data-power={p.type}>
                <div className="grow">
                  <b>{t(`power.${p.type}`)}</b>
                  <div className="small muted">{t(`power.${p.type}.what`)}</div>
                  {p.connection?.account && <div className="small">{p.connection.account}</div>}
                  {p.connection?.status === 'error' && <div className="small" style={{ color: 'var(--attn-ink)' }}>{t('powers.reconnect_needed')}</div>}
                </div>
                {p.connection?.status === 'connected' ? (
                  <button className="btn small" disabled={busy === p.type} onClick={() => disconnect(p.connection!.id, p.type)}>{t('powers.disconnect')}</button>
                ) : p.available ? (
                  p.onPlan ? (
                    <button className="btn small primary" disabled={busy === p.type} onClick={() => connect(p.type)}>{p.connection?.status === 'error' ? t('powers.reconnect') : t('powers.connect')}</button>
                  ) : (
                    <span className="chip">{t('powers.upgrade')}</span>
                  )
                ) : (
                  <span className="chip">{p.connection?.status === 'pending' ? t('powers.pending') : t('powers.soon')}</span>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}

/** Details: upcoming bookings, conversations and what Orbit knows (the knowledge editor). */
export function DetailsView() {
  const { t, lang } = useI18n();
  const { data: cal } = useLoad<{ bookings: any[] }>('/calendar');
  const { data: convs } = useLoad<any[]>('/inbox');
  const fmt = (iso: string) => new Intl.DateTimeFormat(lang, { weekday: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const upcoming = (cal?.bookings ?? []).filter((b) => new Date(b.endAt) > new Date() && b.status !== 'cancelled').slice(0, 20);
  return (
    <section className="stack">
      <h2>{t('details.bookings')}</h2>
      <div className="card">
        {upcoming.length === 0 && <p className="muted">{t('details.no_bookings')}</p>}
        {upcoming.map((b) => (
          <div key={b.id} className="list-item">
            <b style={{ minWidth: 110 }}>{fmt(b.startAt)}</b>
            <div className="grow">{b.customer ?? '—'} · {b.service}</div>
          </div>
        ))}
      </div>
      <div className="row between"><h2 style={{ margin: 0 }}>{t('details.inbox')}</h2><a className="chip" href="/inbox">{t('inbox.open')}</a></div>
      <div className="card">
        {(convs ?? []).length === 0 && <p className="muted">{t('details.no_conversations')}</p>}
        {(convs ?? []).slice(0, 8).map((c) => (
          <a key={c.id} href={`/inbox/${c.id}`} className="list-item" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="grow"><b>{c.customer ?? t('details.visitor')}</b><div className="small muted">{t(`channel.${c.channel}`)} · {c.preview}</div></div>
            <span className="chip small">{t(`conv.${c.status}`)}</span>
          </a>
        ))}
      </div>
      <KnowledgeEditor />
    </section>
  );
}

function KnowledgeEditor() {
  const { t } = useI18n();
  const { data, reload } = useLoad<{ id: string; type: string; title: string; content: string }[]>('/knowledge');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setErr(null);
    try {
      await api('/knowledge', { body: { type: 'faq', title, content } });
      setTitle('');
      setContent('');
      reload();
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };
  return (
    <>
      <h2>{t('knowledge.title')}</h2>
      <p className="muted small">{t('knowledge.sub')}</p>
      <div className="card stack">
        <input className="input" placeholder={t('knowledge.question')} value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('knowledge.question')} />
        <textarea className="input" style={{ minHeight: 90, fontFamily: 'inherit', fontSize: 15 }} placeholder={t('knowledge.answer')} value={content} onChange={(e) => setContent(e.target.value)} aria-label={t('knowledge.answer')} />
        <button className="btn primary" disabled={!title.trim() || !content.trim()} onClick={add}>{t('knowledge.add')}</button>
        {err && <p className="error small">{err}</p>}
      </div>
      <div className="card">
        {(data ?? []).map((k) => (
          <div key={k.id} className="list-item" style={{ alignItems: 'flex-start' }}>
            <div className="grow"><b>{k.title}</b><div className="small muted">{k.content}</div></div>
            <button className="icon-btn" aria-label={t('common.remove')} onClick={() => api(`/knowledge/${k.id}`, { method: 'DELETE' }).then(reload)}>×</button>
          </div>
        ))}
      </div>
    </>
  );
}

export function ComingView({ view }: { view: 'tomorrow' | 'rewind' }) {
  const { t } = useI18n();
  return (
    <section className="card empty">
      <div className="big">{view === 'tomorrow' ? '🔮' : '⏪'}</div>
      <h2>{t(`view.${view}`)}</h2>
      <p>{t(`coming.${view}`)}</p>
    </section>
  );
}
