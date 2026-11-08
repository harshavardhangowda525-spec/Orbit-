'use client';

import { useEffect, useRef, useState } from 'react';
import type { Sentence } from '@orbit/shared';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AgentDot } from './Hero';
import { timeAgo } from './Feed';

export interface Decision {
  id: string;
  agent: string;
  agentName: string;
  type: string;
  channel: string | null;
  title: Sentence;
  context: Record<string, any>;
  options: { key: string; label: string; style: string }[];
  createdAt: string;
}

/**
 * One decision at a time, a lavender card peeking behind when more wait.
 * Tap a button, or swipe: right = primary action, left = later.
 */
export function NeedsYou({ cards, onDecided, onOpen, dayName }: { cards: Decision[]; onDecided: () => void; onOpen: (href: string) => void; dayName: string }) {
  const { t } = useI18n();
  const [order, setOrder] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);

  // Keep the local order (cards moved "for later" go to the back) in step with the server list.
  useEffect(() => {
    setOrder((prev) => [...prev.filter((id) => cards.some((c) => c.id === id)), ...cards.map((c) => c.id).filter((id) => !prev.includes(id))]);
  }, [cards]);
  const list = order.map((id) => cards.find((c) => c.id === id)).filter(Boolean) as Decision[];
  const card = list[0];
  const count = cards.length;
  const countLabel = count === 0 ? t('needs.all_clear') : t('needs.decisions', { count });

  async function decide(c: Decision, key: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ open?: string | null }>(`/bridge/cards/${c.id}/decide`, { body: { option: key } });
      setOrder((o) => o.filter((id) => id !== c.id));
      onDecided();
      if (r.open) onOpen(r.open);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
      setDx(0);
    }
  }
  const later = (c: Decision) => setOrder((o) => [...o.filter((id) => id !== c.id), c.id]);

  const primary = card?.options.find((o) => o.style === 'primary') ?? card?.options[0];
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const d = e.clientX - start.current.x;
    if (Math.abs(d) > 8 && Math.abs(e.clientY - start.current.y) < 40) setDx(d);
  };
  const onUp = () => {
    if (!start.current || !card) return;
    start.current = null;
    if (dx > 110 && primary) decide(card, primary.key);
    else if (dx < -110 && list.length > 1) later(card);
    setDx(0);
  };

  return (
    <section aria-labelledby="needs-h" data-testid="needs-you">
      <div className="zone-head">
        <h2 id="needs-h">{t('zone.needs_you')}</h2>
        <span className="count" data-testid="needs-count">{countLabel}</span>
      </div>
      {!card ? (
        <div className="clear" data-testid="needs-empty">
          <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden>
            <circle cx="22" cy="22" r="22" fill="#5EE0B5" />
            <path className="tick" d="M13 22.5l6 6 12-13" fill="none" stroke="#10332A" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <b>{t('needs.nothing')}</b>
            <span>{t('needs.handled', { day: dayName })}</span>
          </div>
        </div>
      ) : (
        <div className={`stack-wrap ${list.length > 1 ? 'more' : ''}`}>
          <article
            key={card.id}
            className="decision pop"
            data-card-type={card.type}
            style={dx ? { transform: `translateX(${dx}px) rotate(${dx / 40}deg)`, transition: 'none' } : undefined}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => { start.current = null; setDx(0); }}
          >
            {dx > 40 && primary && <span className="swipe-label right">{t(primary.label)}</span>}
            {dx < -40 && list.length > 1 && <span className="swipe-label left">{t('needs.later')}</span>}
            <div className="meta">
              <AgentDot agent={card.agent} />
              <span>
                {card.agentName}
                {card.channel ? ` · ${t(`channel.${card.channel}`)}` : ''} · {timeAgo(card.createdAt, t)}
              </span>
            </div>
            <Situation card={card} />
            <div className="actions">
              {card.options.map((o) => (
                <button key={o.key} className={`btn ${o.style === 'primary' ? 'primary' : ''}`} disabled={busy} onClick={() => decide(card, o.key)}>
                  {t(o.label)}
                </button>
              ))}
            </div>
            {error && <p className="error small">{error}</p>}
          </article>
        </div>
      )}
    </section>
  );
}

function Situation({ card }: { card: Decision }) {
  const { t, ts } = useI18n();
  const c = card.context ?? {};
  const preview = c.suggestedReply ?? c.sample ?? c.conversation ?? null;
  const suggestion = c.suggestion ?? (card.type === 'handover' ? t('needs.suggest.handover') : card.type === 'review_reply' ? t('needs.suggest.review') : card.type === 'discount' ? t('needs.suggest.discount') : null);
  return (
    <>
      <div className="situation">{ts(card.title)}</div>
      {c.review && <div className="suggest">“{c.review}”</div>}
      {suggestion && <div className="suggest">{suggestion}</div>}
      {preview && <div className="preview">{preview}</div>}
      {(c.audience || c.channels) && (
        <div className="audience">
          {c.audience && <span>{c.audience}</span>}
          {(c.channels ?? []).map((ch: string) => <span key={ch}>{t(`channel.${ch}`)}</span>)}
        </div>
      )}
    </>
  );
}
