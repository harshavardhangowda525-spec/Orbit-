'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { translate } from '@orbit/shared';
import { API_URL } from '@/lib/api';
import { useLive } from '@/lib/live';

interface Msg { id: string; from: 'you' | 'aria' | 'team'; body: string; at: string }

/** Customer chat with Aria. The visitor keeps a private token for their own conversation (stored on this device). */
export function ChatPanel({ slug, businessName, lang, openOnLoad, embed = false }: { slug: string; businessName: string; lang: string; openOnLoad: boolean; embed?: boolean }) {
  const t = (k: string, p: Record<string, string | number> = {}) => translate(lang, k, p);
  const [open, setOpen] = useState(openOnLoad || embed);
  const [conv, setConv] = useState<{ id: string; token: string } | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [handledBy, setHandledBy] = useState<'aria' | 'human'>('aria');
  const [text, setText] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const key = `orbit.chat.${slug}`;

  const call = useCallback(async (path: string, init: RequestInit & { token?: string } = {}) => {
    const res = await fetch(`${API_URL}/public/businesses/${slug}/chat${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.token ? { 'x-visitor-token': init.token } : {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? t('chat.error')), { status: res.status });
    return data;
  }, [slug]);

  const start = useCallback(async () => {
    let saved: { id: string; token: string } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {}
    if (saved) {
      try {
        const h = await call(`/${saved.id}/messages`, { token: saved.token });
        setConv(saved);
        setMessages(h.messages);
        setHandledBy(h.handledBy);
        return;
      } catch {}
    }
    const r = await call('', { method: 'POST', body: JSON.stringify({ language: navigator.language, channel: embed ? 'website_chat' : 'chat_link' }) });
    const c = { id: r.conversationId, token: r.visitorToken };
    try {
      localStorage.setItem(key, JSON.stringify(c));
    } catch {}
    setConv(c);
    setMessages(r.messages.map((m: any) => ({ id: m.id, from: 'aria', body: m.body, at: m.at })));
  }, [call, key, embed]);

  useEffect(() => {
    if (open && !conv) start().catch((e) => setError(e.message));
  }, [open, conv, start]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, waiting]);

  // Team replies arrive live.
  useLive(conv ? `visitor=${encodeURIComponent(conv.token)}&conversation=${conv.id}&slug=${slug}` : null, (e) => {
    if (e.type === 'message.new' && e.data?.message?.direction === 'out') {
      const m = e.data.message;
      setMessages((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms, { id: m.id, from: m.sender === 'aria' ? 'aria' : 'team', body: m.body, at: m.at }]));
    }
    if (e.type === 'conversation.updated' && e.data?.handledBy) setHandledBy(e.data.handledBy);
  });

  async function send(value: string) {
    if (!conv || !value.trim()) return;
    setText('');
    setError(null);
    const temp: Msg = { id: `tmp-${Date.now()}`, from: 'you', body: value.trim(), at: new Date().toISOString() };
    setMessages((ms) => [...ms, temp]);
    setWaiting(true);
    try {
      const r = await call(`/${conv.id}/messages`, { method: 'POST', body: JSON.stringify({ text: value.trim() }), token: conv.token });
      // Live replies can arrive before this response: merge, de-duplicate, keep time order.
      setMessages((ms) => {
        const rest = ms.filter((m) => m.id !== temp.id);
        return [...rest, ...r.messages.filter((m: Msg) => !rest.some((x) => x.id === m.id))].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      });
      setHandledBy(r.handledBy);
    } catch (e: any) {
      if (e.status === 401) {
        try { localStorage.removeItem(key); } catch {}
        setConv(null);
      }
      setError(e.message);
    } finally {
      setWaiting(false);
    }
  }

  if (!open) {
    return <button className="btn big grow" onClick={() => setOpen(true)}>💬 {t('public.chat')}</button>;
  }
  const panelStyle: React.CSSProperties = embed
    ? { position: 'fixed', inset: 0, borderRadius: 0, display: 'flex', flexDirection: 'column' }
    : { position: 'fixed', inset: 'auto 8px 8px 8px', maxWidth: 520, margin: '0 auto', zIndex: 30, maxHeight: '80dvh', display: 'flex', flexDirection: 'column' };
  return (
    <div className="card" role="dialog" aria-label={t('chat.title', { business: businessName })} style={panelStyle} data-testid="chat">
      <div className="row between" style={{ marginBottom: 8 }}>
        <div className="row"><span className="agent-dot sm a-aria">A</span><b>{t('chat.title', { business: businessName })}</b></div>
        {!embed && <button className="icon-btn" aria-label={t('common.close')} onClick={() => setOpen(false)}>×</button>}
      </div>
      {handledBy === 'human' && <p className="note small" style={{ marginBottom: 8 }}>{t('chat.human_joined')}</p>}
      <div className="chat grow" style={{ overflowY: 'auto', paddingBottom: 8 }}>
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.from === 'you' ? 'in' : 'out'}`}>
            {m.from === 'team' && <span className="who">{t('chat.team', { business: businessName })}</span>}
            {m.body}
          </div>
        ))}
        {waiting && <div className="bubble out"><span className="typing"><i /><i /><i /></span></div>}
        <div ref={end} />
      </div>
      {messages.length <= 1 && (
        <div className="row" style={{ flexWrap: 'wrap', margin: '8px 0' }}>
          {['book', 'prices', 'timings', 'human'].map((k) => (
            <button key={k} className="chip" onClick={() => send(t(`chat.say.${k}`))}>{t(`chat.chip.${k}`)}</button>
          ))}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input className="input grow" placeholder={t('chat.placeholder')} aria-label={t('chat.placeholder')} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
        <button className="btn primary" disabled={!text.trim() || waiting || !conv} aria-label={t('cmd.send')}>➤</button>
      </form>
    </div>
  );
}
