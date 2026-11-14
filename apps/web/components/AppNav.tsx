'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { LanguagePicker } from '@/components/LanguagePicker';
import './app-nav.css';
import type { View } from '@/lib/bridge-types';

export type NavKey = View | 'inbox';

const ICONS: Record<NavKey, React.ReactNode> = {
  today: <path d="M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10" />,
  inbox: <path d="M4 13.5 6.5 5h11L20 13.5M4 13.5V19h16v-5.5M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20" />,
  people: <><circle cx="9" cy="9" r="3.2" /><path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" /><circle cx="17" cy="9.5" r="2.4" /><path d="M16 14.6c2.3.1 3.9 1.5 4.5 4.4" /></>,
  money: <><rect x="3" y="6" width="18" height="12" rx="2.5" /><circle cx="12" cy="12" r="2.6" /><path d="M6.5 9.5v5M17.5 9.5v5" /></>,
  crew: <><circle cx="12" cy="12" r="2.6" /><circle cx="12" cy="12" r="8" strokeDasharray="2.5 3" /><circle cx="19.5" cy="9" r="1.6" fill="currentColor" /><circle cx="5.5" cy="15.5" r="1.6" fill="currentColor" /></>,
  details: <><path d="M4 20V9l8-5 8 5v11" /><path d="M9 20v-6h6v6" /></>,
  powers: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />,
  plan: <><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><path d="M3.5 9.5h17M7 15h4" /></>,
  tomorrow: <><rect x="4" y="5" width="16" height="15" rx="2.5" /><path d="M4 9.5h16M9 3v4M15 3v4M10 14.5l2 2 3-3.5" /></>,
  rewind: <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5M12 8v4.5l3 1.8" />,
};

function Icon({ k }: { k: NavKey }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[k]}
    </svg>
  );
}

const GROUPS: { label: string; items: NavKey[]; soon?: boolean }[] = [
  { label: 'nav.group.home', items: ['today', 'inbox'] },
  { label: 'nav.group.customers', items: ['people', 'money'] },
  { label: 'nav.group.team', items: ['crew'] },
  { label: 'nav.group.setup', items: ['details', 'powers', 'plan'] },
  { label: 'nav.group.soon', items: ['tomorrow', 'rewind'], soon: true },
];
const PHONE_TABS: NavKey[] = ['today', 'inbox', 'people', 'money'];

/**
 * The app's navigation. Laptop: a grouped sidebar (icons only on narrower
 * laptops). Phone and tablet: a bottom tab bar with the four everyday places
 * and "More" for the rest. The Inbox and Today show what is waiting.
 */
export function AppNav({ active, onSelect, business, badges = {} }: { active: NavKey; onSelect?: (v: View) => void; business?: string; badges?: Partial<Record<NavKey, number>> }) {
  const { t } = useI18n();
  const router = useRouter();
  const [more, setMore] = useState(false);
  const go = (k: NavKey) => {
    setMore(false);
    if (k === 'inbox') return router.push('/inbox');
    if (onSelect) onSelect(k as View);
    else router.push(k === 'today' ? '/bridge' : `/bridge?view=${k}`);
  };
  useEffect(() => {
    if (!more) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMore(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [more]);
  const label = (k: NavKey) => t(`nav.${k}`);
  const badge = (k: NavKey) => (badges[k] ? <span className="nav-badge" aria-label={t('nav.waiting', { count: badges[k]! })}>{badges[k]! > 99 ? '99+' : badges[k]}</span> : null);
  const moreItems = GROUPS.flatMap((g) => g.items.map((k) => ({ k, soon: !!g.soon }))).filter((x) => !PHONE_TABS.includes(x.k));

  return (
    <>
      <aside className="app-side" aria-label={t('nav.label')} data-testid="app-nav">
        <div className="side-brand">
          <div className="logo" aria-hidden><div className="ring" /><div className="core" /><div className="spin"><i /></div></div>
          <div className="side-name">
            <b>Orbit</b>
            {business && <span>{business}</span>}
          </div>
        </div>
        <nav className="side-groups">
          {GROUPS.map((g) => (
            <div key={g.label} className={`side-group ${g.soon ? 'soon' : ''}`}>
              <div className="side-label">{t(g.label)}</div>
              {g.items.map((k) => (
                <button key={k} className="side-item" aria-current={active === k ? 'page' : undefined} onClick={() => go(k)} title={label(k)} data-nav={k}>
                  <Icon k={k} />
                  <span className="side-text">{label(k)}</span>
                  {badge(k)}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot"><LanguagePicker compact /></div>
      </aside>

      <nav className="tabbar" aria-label={t('nav.label')} data-testid="tab-bar">
        {PHONE_TABS.map((k) => (
          <button key={k} className="tab" aria-current={active === k ? 'page' : undefined} onClick={() => go(k)} data-nav={k}>
            <span className="tab-icon"><Icon k={k} />{badge(k)}</span>
            <span>{label(k)}</span>
          </button>
        ))}
        <button className="tab" aria-expanded={more} aria-current={!PHONE_TABS.includes(active) ? 'page' : undefined} onClick={() => setMore(!more)} data-nav="more">
          <span className="tab-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
          </span>
          <span>{t('nav.more')}</span>
        </button>
      </nav>

      {more && (
        <div className="more-sheet" role="dialog" aria-label={t('nav.more')} onClick={(e) => e.target === e.currentTarget && setMore(false)}>
          <div className="more-card">
            <div className="more-grab" aria-hidden />
            <div className="more-grid">
              {moreItems.map(({ k, soon }) => (
                <button key={k} className={`more-item ${soon ? 'soon' : ''}`} aria-current={active === k ? 'page' : undefined} onClick={() => go(k)} data-nav={k}>
                  <Icon k={k} />
                  <span>{label(k)}</span>
                  {soon && <small>{t('nav.soon')}</small>}
                </button>
              ))}
            </div>
            <div className="more-foot"><span className="small muted">{t('common.language')}</span><LanguagePicker compact /></div>
          </div>
        </div>
      )}
    </>
  );
}
