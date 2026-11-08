'use client';

import '../../bridge/bridge.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useLive, ownerLiveQuery } from '@/lib/live';

/** One conversation: full history across channels, customer card, take over / hand back to Aria. */
export default function Conversation() {
  const { id } = useParams<{ id: string }>();
  const { t, money, lang } = useI18n();
  const { me } = useSession();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(() => api(`/inbox/${id}`).then(setData).catch((e) => setError((e as ApiError).message)), [id]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [data?.messages?.length]);
  useLive(ownerLiveQuery(), (e) => (e.type === 'message.new' || e.type === 'conversation.updated') && load());

  const act = async (path: string, body?: object) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/inbox/${id}/${path}`, { body: body ?? {} });
      await load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const handled = data?.conversation.handledBy as string | undefined;
  const mine = handled === `user:${me?.user.id}`;
  const c = data?.customer;
  const fmt = (iso: string) => new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

  return (
    <main className="page" style={{ paddingBottom: 120 }}>
      <div className="topbar">
        <Link className="chip" href="/inbox">← {t('inbox.title')}</Link>
        <div className="name">{c?.name ?? t('details.visitor')}</div>
        <span style={{ width: 40 }} />
      </div>
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          <section className="card stack" style={{ gap: 6 }} data-testid="customer-card">
            <div className="row between">
              <span className="small muted">{t(`channel.${data.conversation.channel}`)} · {handled === 'aria' ? t('inbox.aria_handling') : mine ? t('inbox.you_handling') : t('inbox.team_handling')}</span>
              {handled === 'aria' ? (
                <button className="btn small primary" disabled={busy} onClick={() => act('takeover')}>{t('inbox.take_over')}</button>
              ) : (
                <button className="btn small" disabled={busy} onClick={() => act('handback')}>{t('inbox.hand_back')}</button>
              )}
            </div>
            {c && (
              <div className="small">
                {c.phone && <span>{c.phone} · </span>}
                {c.email && <span>{c.email} · </span>}
                {t('people.line', { visits: c.visitCount, spend: money(c.lifetimeSpend) })}
              </div>
            )}
            {data.upcoming?.map((b: any) => <div key={b.id} className="small">📅 {b.service} · {fmt(b.startAt)}</div>)}
          </section>
          <div className="chat" style={{ marginTop: 16 }} data-testid="conversation">
            {data.messages.map((m: any) => (
              <div key={m.id} className={`bubble ${m.direction === 'in' ? 'out' : 'in'}`} style={m.direction === 'out' && m.sender === 'aria' ? { background: 'var(--aria)', color: 'var(--aria-ink)' } : undefined}>
                <span className="who">{m.direction === 'in' ? (c?.name ?? t('details.visitor')) : m.sender === 'aria' ? 'Aria' : m.sender.startsWith('user:') ? t('inbox.team') : m.sender} · {fmt(m.at)}</span>
                {m.body}
              </div>
            ))}
            <div ref={end} />
          </div>
          <form className="cmd" onSubmit={(e) => { e.preventDefault(); if (text.trim()) act('reply', { body: text }).then(() => setText('')); }}>
            <div className="row" style={{ background: 'var(--surface)', borderRadius: 999, padding: '6px 6px 6px 18px', boxShadow: 'var(--shadow-bar)' }}>
              <input className="grow" style={{ border: 'none', outline: 'none', background: 'transparent', minHeight: 46 }} placeholder={handled === 'aria' ? t('inbox.reply_takes_over') : t('inbox.reply')} aria-label={t('inbox.reply')} value={text} onChange={(e) => setText(e.target.value)} />
              <button className="send" style={{ width: 46, height: 46, borderRadius: 999, border: 'none', background: 'var(--primary)', color: '#fff' }} disabled={busy || !text.trim()} aria-label={t('cmd.send')}>➤</button>
            </div>
          </form>
        </>
      )}
    </main>
  );
}
