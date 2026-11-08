'use client';

import '../bridge/bridge.css';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useLive, ownerLiveQuery } from '@/lib/live';
import { useSession } from '@/lib/session';
import { useRouter } from 'next/navigation';
import { timeAgo } from '@/components/bridge/Feed';

const FILTERS = ['all', 'needs_me', 'aria', 'human', 'closed'] as const;

/** Unified inbox: every channel in one list. */
export default function Inbox() {
  const { t } = useI18n();
  const { business, me, loading } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !me) router.replace('/login');
  }, [loading, me, router]);
  const ready = !!(business || me?.impersonation);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!ready) return;
    const q = filter === 'all' ? '' : filter === 'aria' || filter === 'human' ? `?handledBy=${filter}` : `?status=${filter}`;
    api<any[]>(`/inbox${q}`).then(setRows).catch((e) => setError((e as ApiError).message));
  }, [filter, ready]);
  useEffect(() => {
    load();
  }, [load]);
  useLive(ready ? ownerLiveQuery() : null, (e) => (e.type === 'message.new' || e.type === 'conversation.updated') && load());
  return (
    <main className="page">
      <div className="topbar">
        <Link className="chip" href="/bridge">← {t('view.today')}</Link>
        <div className="name">{t('inbox.title')}</div>
        <span style={{ width: 40 }} />
      </div>
      <nav className="views" aria-label={t('inbox.filters')}>
        {FILTERS.map((f) => (
          <button key={f} className="chip" aria-current={filter === f} onClick={() => setFilter(f)}>{t(`inbox.filter.${f}`)}</button>
        ))}
      </nav>
      {error && <p className="error">{error}</p>}
      {rows && rows.length === 0 && <div className="card empty">{t('inbox.empty')}</div>}
      <ul className="feed2" data-testid="inbox-list">
        {(rows ?? []).map((c) => (
          <li key={c.id}>
            <Link href={`/inbox/${c.id}`} className="rowbtn" style={{ textDecoration: 'none' }}>
              <span className={`agent-dot ${c.handledBy === 'aria' ? 'a-aria' : 'a-orbit'}`} aria-hidden>{(c.customer ?? '?')[0]}</span>
              <span className="grow">
                <span className="s" style={{ display: 'block' }}>{c.customer ?? t('details.visitor')}</span>
                <span className="m" style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.preview}</span>
                <span className="m" style={{ display: 'block' }}>
                  {t(`channel.${c.channel}`)} · {c.lastMessageAt ? timeAgo(c.lastMessageAt, t) : ''} · {c.handledBy === 'aria' ? 'Aria' : t('inbox.you')}
                </span>
              </span>
              {c.status === 'waiting_staff' && <span className="chip small" style={{ background: 'var(--attn-bg)', color: 'var(--attn-ink)', borderColor: 'transparent' }}>{t('conv.waiting_staff')}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
