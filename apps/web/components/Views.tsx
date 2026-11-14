'use client';

import { useCallback, useEffect, useState } from 'react';
import { pagesLogin, whatsappSignup, type MetaSetup } from '@/lib/meta';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { BridgeData } from '@/lib/bridge-types';
import { AgentDot } from './bridge/Hero';
import { CrewSettings } from './PlanCrew';
import { timeAgo } from './bridge/Feed';
import { VoxPanel } from './VoxPanel';

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
            <li key={x.id} className="small muted">{/^[a-z_]+(\.[a-z_]+)+$/.test(x.goal) ? t(x.goal, { agent: data.crew.find((c) => c.agent === x.agent)?.name ?? '', customer: '', service: '', channel: '' }) : x.goal} · {t(`task.${x.status}`)}</li>
          ))}
        </ul>
        {!data.feed.some((g) => g.agent === sel) && <p className="muted small">{t('crew.nothing_yet')}</p>}
        <CrewSettings key={sel} agent={sel} />
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
  const { data, error, reload } = useLoad<{ type: string; group: string; available: boolean; onPlan: boolean; form: 'meta' | 'microsoft' | 'sms' | 'razorpay' | 'zoho' | 'exotel' | null; connection: { id: string; status: string; account: string | null; error: string | null; lastSyncAt: string | null } | null }[]>('/powers');
  const [form, setForm] = useState<string | null>(null);
  const { data: metaSetup } = useLoad<MetaSetup>('/channels/meta/setup');
  const [pagePick, setPagePick] = useState<{ selection: string; pages: { id: string; name: string; instagram: { id: string; username: string | null } | null }[]; want: 'messenger' | 'instagram' } | null>(null);
  const [tpl, setTpl] = useState(false);
  const onPlan = (type: string) => !!data?.find((x) => x.type === type)?.onPlan;
  const oneClick = (type: string) => !!metaSetup && (type === 'whatsapp' ? metaSetup.oneClick.whatsapp : metaSetup.oneClick.pages);
  const connectMeta = async (type: string) => {
    setBusy(type);
    setMsg(null);
    try {
      if (type === 'whatsapp') {
        const r = await whatsappSignup(metaSetup!);
        await api('/channels/whatsapp/signup', { body: r });
        reload();
      } else {
        const code = await pagesLogin(metaSetup!);
        const r = await api<{ selection: string; pages: any[] }>('/channels/pages/login', { body: { code } });
        setPagePick({ ...r, want: type as 'messenger' | 'instagram' });
      }
    } catch (e) {
      if ((e as Error).message !== 'cancelled') setMsg((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const connect = async (type: string) => {
    setBusy(type);
    setMsg(null);
    try {
      const r = await api<{ url: string }>(type === 'outlook' ? '/channels/outlook/connect' : type === 'zoho_books' ? '/ledger/zoho/connect' : `/powers/${type}/connect`, { body: {} });
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
                    <button className="btn small primary" disabled={busy === p.type} onClick={() => (p.form === 'meta' ? (oneClick(p.type) ? connectMeta(p.type) : setForm(form === p.type ? null : p.type)) : p.form === 'sms' || p.form === 'razorpay' || p.form === 'exotel' ? setForm(form === p.type ? null : p.type) : connect(p.type))}>{p.connection?.status === 'error' ? t('powers.reconnect') : t('powers.connect')}</button>
                  ) : (
                    <span className="chip">{t('powers.upgrade')}</span>
                  )
                ) : (
                  <span className="chip">{p.connection?.status === 'pending' ? t('powers.pending') : t('powers.soon')}</span>
                )}
                {p.form === 'meta' && oneClick(p.type) && p.connection?.status !== 'connected' && p.available && p.onPlan && form !== p.type && (
                  <button className="link-btn small advanced" onClick={() => setForm(p.type)}>{t('meta.advanced')}</button>
                )}
                {p.type === 'whatsapp' && p.connection?.status === 'connected' && (
                  tpl ? <WhatsAppTemplateForm current={(p.connection as any).settings ?? {}} onDone={() => { setTpl(false); reload(); }} />
                    : <button className="link-btn small advanced" onClick={() => setTpl(true)}>{(p.connection as any).settings?.templateName ? t('meta.template_set', { name: (p.connection as any).settings.templateName }) : t('meta.template_add')}</button>
                )}
                {form === p.type && p.form === 'meta' && <MetaConnectForm type={p.type as MetaType} onDone={() => { setForm(null); reload(); }} onCancel={() => setForm(null)} />}
                {form === 'sms' && p.type === 'sms' && <SmsConnectForm onDone={() => { setForm(null); reload(); }} onCancel={() => setForm(null)} />}
                {p.type === 'phone' && form !== 'phone' && (
                  <button className="link-btn small advanced" onClick={() => setForm('phone')}>{t('vox.open')}</button>
                )}
                {form === 'phone' && p.type === 'phone' && <VoxPanel onChange={reload} />}
                {form === 'razorpay' && p.type === 'razorpay' && <RazorpayForm onDone={() => { setForm(null); reload(); }} onCancel={() => setForm(null)} />}
                {pagePick && (pagePick.want === p.type) && (
                  <PagePicker pick={pagePick} allowMessenger={onPlan('messenger')} allowInstagram={onPlan('instagram')} onDone={() => { setPagePick(null); reload(); }} onCancel={() => setPagePick(null)} />
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

type MetaType = 'whatsapp' | 'messenger' | 'instagram';
const META_FIELDS: Record<MetaType, { key: string; label: string; hint: string; secret?: boolean; optional?: boolean }[]> = {
  whatsapp: [
    { key: 'phoneNumberId', label: 'meta.f.phone_number_id', hint: 'meta.h.phone_number_id' },
    { key: 'accessToken', label: 'meta.f.token', hint: 'meta.h.token_wa', secret: true },
    { key: 'templateName', label: 'meta.f.template', hint: 'meta.h.template', optional: true },
    { key: 'templateLanguage', label: 'meta.f.template_lang', hint: 'meta.h.template_lang', optional: true },
  ],
  messenger: [
    { key: 'pageId', label: 'meta.f.page_id', hint: 'meta.h.page_id' },
    { key: 'accessToken', label: 'meta.f.token', hint: 'meta.h.token_page', secret: true },
  ],
  instagram: [
    { key: 'instagramId', label: 'meta.f.instagram_id', hint: 'meta.h.instagram_id' },
    { key: 'pageId', label: 'meta.f.page_id', hint: 'meta.h.page_id_ig' },
    { key: 'accessToken', label: 'meta.f.token', hint: 'meta.h.token_page', secret: true },
  ],
};

/** Connect WhatsApp / Messenger / Instagram: the IDs and token from Meta, with where to find each one. */
function MetaConnectForm({ type, onDone, onCancel }: { type: MetaType; onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [v, setV] = useState<Record<string, string>>(type === 'whatsapp' ? { templateLanguage: 'en' } : {});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api(`/channels/${type}/connect`, { body: v });
      onDone();
    } catch (x) {
      setErr((x as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="meta-form stack" onSubmit={submit} data-testid={`connect-${type}`}>
      <details className="meta-help">
        <summary>{t('meta.help.title')}</summary>
        <ol>{t(`meta.help.${type}`, { var: '{{1}}' }).split('\n').map((line, i) => <li key={i}>{line}</li>)}</ol>
      </details>
      {META_FIELDS[type].map((f) => (
        <label key={f.key} className="field">
          <span>{t(f.label)}{f.optional ? ` (${t('common.optional')})` : ''}</span>
          <input className="input" type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} value={v[f.key] ?? ''} required={!f.optional}
            onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
          <small className="muted">{t(f.hint, { var: '{{1}}' })}</small>
        </label>
      ))}
      <p className="small muted">{t('meta.secure')}</p>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy}>{busy ? t('common.wait') : t('powers.connect')}</button>
        <button type="button" className="btn" onClick={onCancel}>{t('meta.cancel')}</button>
      </div>
    </form>
  );
}

/** After Facebook Login: choose the Page and which of its channels to connect. */
function PagePicker({ pick, allowMessenger, allowInstagram, onDone, onCancel }: {
  pick: { selection: string; pages: { id: string; name: string; instagram: { id: string; username: string | null } | null }[]; want: 'messenger' | 'instagram' };
  allowMessenger: boolean; allowInstagram: boolean; onDone: () => void; onCancel: () => void;
}) {
  const { t } = useI18n();
  const [pageId, setPageId] = useState(pick.pages[0]?.id ?? '');
  const page = pick.pages.find((x) => x.id === pageId);
  const [messenger, setMessenger] = useState(allowMessenger && pick.want === 'messenger');
  const [instagram, setInstagram] = useState(allowInstagram && (pick.want === 'instagram' || !!pick.pages[0]?.instagram));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api('/channels/pages/connect', { body: { selection: pick.selection, pageId, messenger, instagram: instagram && !!page?.instagram } });
      onDone();
    } catch (e) {
      setErr((e as ApiError).message);
      setBusy(false);
    }
  };
  return (
    <div className="meta-form stack" data-testid="page-picker">
      <b>{t('meta.pick_page')}</b>
      {pick.pages.map((pg) => (
        <label key={pg.id} className="check-line">
          <input type="radio" name="page" checked={pageId === pg.id} onChange={() => setPageId(pg.id)} />
          <span>{pg.name}{pg.instagram?.username ? ` · @${pg.instagram.username}` : ''}</span>
        </label>
      ))}
      <label className="check-line"><input type="checkbox" checked={messenger} disabled={!allowMessenger} onChange={(e) => setMessenger(e.target.checked)} /> <span>{t('power.messenger')}{allowMessenger ? '' : ` (${t('powers.upgrade')})`}</span></label>
      <label className="check-line"><input type="checkbox" checked={instagram && !!page?.instagram} disabled={!allowInstagram || !page?.instagram} onChange={(e) => setInstagram(e.target.checked)} /> <span>{t('power.instagram')}{!page?.instagram ? ` (${t('meta.no_instagram')})` : !allowInstagram ? ` (${t('powers.upgrade')})` : ''}</span></label>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy || (!messenger && !(instagram && page?.instagram))} onClick={go}>{busy ? t('common.wait') : t('powers.connect')}</button>
        <button className="btn" onClick={onCancel}>{t('meta.cancel')}</button>
      </div>
    </div>
  );
}

/** The approved WhatsApp template Orbit uses after the 24-hour window (reminders, follow-ups). */
function WhatsAppTemplateForm({ current, onDone }: { current: { templateName?: string; templateLanguage?: string }; onDone: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(current.templateName ?? '');
  const [lang, setLang] = useState(current.templateLanguage ?? 'en');
  const [err, setErr] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/channels/whatsapp/settings', { body: { templateName: name, templateLanguage: lang } });
      onDone();
    } catch (x) {
      setErr((x as ApiError).message);
    }
  };
  return (
    <form className="meta-form stack" onSubmit={save}>
      <label className="field"><span>{t('meta.f.template')}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /><small className="muted">{t('meta.h.template', { var: '{{1}}' })}</small></label>
      <label className="field"><span>{t('meta.f.template_lang')}</span><input className="input" value={lang} onChange={(e) => setLang(e.target.value)} /></label>
      {err && <p className="error">{err}</p>}
      <div className="row"><button className="btn primary">{t('meta.save')}</button><button type="button" className="btn" onClick={onDone}>{t('meta.cancel')}</button></div>
    </form>
  );
}

/** SMS in India: MSG91 with a DLT-approved template. */
function SmsConnectForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [v, setV] = useState<Record<string, string>>({ variables: '4' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fields: { key: string; label: string; hint: string; secret?: boolean }[] = [
    { key: 'authKey', label: 'sms.f.auth_key', hint: 'sms.h.auth_key', secret: true },
    { key: 'senderId', label: 'sms.f.sender', hint: 'sms.h.sender' },
    { key: 'templateId', label: 'sms.f.template', hint: 'sms.h.template' },
    { key: 'variables', label: 'sms.f.variables', hint: 'sms.h.variables' },
  ];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/channels/sms/connect', { body: { ...v, variables: Number(v.variables || 4) } });
      onDone();
    } catch (x) {
      setErr((x as ApiError).message);
      setBusy(false);
    }
  };
  return (
    <form className="meta-form stack" onSubmit={submit} data-testid="connect-sms">
      <details className="meta-help">
        <summary>{t('meta.help.title')}</summary>
        <ol>{t('sms.help', { var: '{#var#}' }).split('\n').map((line, i) => <li key={i}>{line}</li>)}</ol>
      </details>
      {fields.map((f) => (
        <label key={f.key} className="field">
          <span>{t(f.label)}</span>
          <input className="input" type={f.secret ? 'password' : 'text'} inputMode={f.key === 'variables' ? 'numeric' : undefined} autoComplete="off" spellCheck={false} value={v[f.key] ?? ''} required
            onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
          <small className="muted">{t(f.hint, { var: '{#var#}' })}</small>
        </label>
      ))}
      <p className="small muted">{t('sms.one_way')}</p>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy}>{busy ? t('common.wait') : t('powers.connect')}</button>
        <button type="button" className="btn" onClick={onCancel}>{t('meta.cancel')}</button>
      </div>
    </form>
  );
}

/** Razorpay: the business's own keys; then (optional) the webhook to paste into Razorpay. */
function RazorpayForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hook, setHook] = useState<{ webhookUrl: string; webhookSecret: string } | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setHook(await api('/ledger/razorpay/connect', { body: { keyId: keyId.trim(), keySecret: keySecret.trim() } }));
    } catch (x) {
      setErr((x as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  if (hook) {
    return (
      <div className="meta-form stack" data-testid="razorpay-webhook">
        <p className="note small">{t('rzp.connected')}</p>
        <p className="small">{t('rzp.webhook_intro')}</p>
        <label className="field"><span>{t('rzp.webhook_url')}</span><input className="input" readOnly value={hook.webhookUrl} onFocus={(e) => e.target.select()} /></label>
        <label className="field"><span>{t('rzp.webhook_secret')}</span><input className="input" readOnly value={hook.webhookSecret} onFocus={(e) => e.target.select()} /></label>
        <p className="small muted">{t('rzp.webhook_steps')}</p>
        <div className="row"><button className="btn primary" onClick={onDone}>{t('rzp.done')}</button></div>
      </div>
    );
  }
  return (
    <form className="meta-form stack" onSubmit={submit} data-testid="connect-razorpay">
      <details className="meta-help">
        <summary>{t('meta.help.title')}</summary>
        <ol>{t('rzp.help').split('\n').map((line, i) => <li key={i}>{line}</li>)}</ol>
      </details>
      <label className="field"><span>Key ID</span><input className="input" autoComplete="off" spellCheck={false} placeholder="rzp_live_..." value={keyId} onChange={(e) => setKeyId(e.target.value)} required /></label>
      <label className="field"><span>Key Secret</span><input className="input" type="password" autoComplete="off" value={keySecret} onChange={(e) => setKeySecret(e.target.value)} required /></label>
      <p className="small muted">{t('meta.secure')}</p>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy}>{busy ? t('common.wait') : t('powers.connect')}</button>
        <button type="button" className="btn" onClick={onCancel}>{t('meta.cancel')}</button>
      </div>
    </form>
  );
}
