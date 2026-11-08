'use client';

import { useEffect, useRef, useState } from 'react';
import type { Sentence } from '@orbit/shared';
import { useI18n } from '@/lib/i18n';
import { useCountUp } from '@/lib/motion';
import { AgentDot } from './Hero';

export function timeAgo(iso: string, t: (k: string, p?: Record<string, string | number>) => string) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return t('time.just_now');
  if (mins < 60) return t('time.min_ago', { count: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return t('time.hr_ago', { count: hrs });
  return t('time.day_ago', { count: Math.round(hrs / 24) });
}

export interface FeedGroup {
  id: string;
  agent: string;
  type: string;
  at: string;
  channel: string | null;
  sentence: Sentence;
  items: { id: string; sentence: Sentence; at: string; entityType: string | null; entityId: string | null }[];
}

const AGENT_NAMES: Record<string, string> = { aria: 'Aria', vox: 'Vox', nudge: 'Nudge', ledger: 'Ledger', spark: 'Spark', orbit: 'Orbit' };

/** "What your Crew did": new rows slide in at the top; tap opens what the row is about. */
export function CrewFeed({ groups, names, animate, onOpen }: { groups: FeedGroup[]; names: Record<string, string>; animate: boolean; onOpen: (g: FeedGroup['items'][number]) => void }) {
  const { t, ts } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const fresh = new Set<string>();
  if (seen.current) for (const g of groups) if (!seen.current.has(g.id)) fresh.add(g.id);
  useEffect(() => {
    seen.current = new Set(groups.map((g) => g.id));
  }, [groups]);

  return (
    <section aria-labelledby="feed-h" data-testid="feed">
      <div className="zone-head"><h2 id="feed-h">{t('zone.crew_did')}</h2></div>
      {groups.length === 0 ? (
        <p className="muted small">{t('feed.empty')}</p>
      ) : (
        <ul className="feed2">
          {groups.map((g, i) => {
            const many = g.items.length > 1;
            const name = names[g.agent] ?? AGENT_NAMES[g.agent] ?? g.agent;
            return (
              <li key={g.id} className={`${fresh.has(g.id) ? 'new' : ''} ${animate ? 'rise' : ''}`} style={{ ['--d' as any]: `${0.45 + i * 0.1}s` }}>
                <button className="rowbtn" onClick={() => (many ? setOpen(open === g.id ? null : g.id) : onOpen(g.items[0]))} aria-expanded={many ? open === g.id : undefined}>
                  <AgentDot agent={g.agent} />
                  <span className="grow">
                    <span className="s" style={{ display: 'block' }}>{ts(g.sentence)}</span>
                    <span className="m" style={{ display: 'block' }}>
                      {name}{g.channel ? ` · ${t(`channel.${g.channel}`)}` : ''} · {timeAgo(g.at, t)}{many ? ` · ${open === g.id ? '▲' : `▼ ${g.items.length}`}` : ''}
                    </span>
                  </span>
                </button>
                {many && open === g.id && (
                  <div className="sub">
                    {g.items.map((it) => (
                      <button key={it.id} className="link-btn" style={{ textAlign: 'left', fontWeight: 600, minHeight: 36, padding: 0, color: 'var(--muted)' }} onClick={() => onOpen(it)}>
                        {ts(it.sentence)}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Orbit Earnings: total, hours saved, a bar per agent proportional to the best agent. */
export function Earnings({ total, minutes, rows, currency, animate }: { total: number; minutes: number; rows: { agent: string; name: string; value: number }[]; currency: string; animate: boolean }) {
  const { t, money } = useI18n();
  const shownTotal = useCountUp(total, animate);
  const hours = Math.round((minutes / 60) * 10) / 10;
  const shownHours = useCountUp(hours, animate);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <section className={`earn ${animate ? 'grow rise' : ''}`} style={{ ['--d' as any]: '0.3s' }} data-testid="earnings">
      <div className="top">
        <div>
          <div className="label">{t('earn.title')}</div>
          <div className="total">{money(Math.round(shownTotal), currency)}</div>
        </div>
        <div className="hours">
          {t('earn.hours', { count: Math.round(shownHours * 10) / 10 })}
          <small>{t('earn.saved')}</small>
        </div>
      </div>
      {rows.length > 0 && (
        <div className="bars">
          {rows.map((r, i) => (
            <div key={r.agent} className={`bar a-${r.agent}`}>
              <div className="row1"><span>{r.name}</span><span>{money(r.value, currency)}</span></div>
              <div className="track">
                <div className="fill" style={{ width: `${Math.max(3, (r.value / max) * 100)}%`, ['--d' as any]: `${[0.4, 0.55, 0.7, 0.85][i] ?? 0.85}s` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
