'use client';

import './bridge.css';
import './bridge-glow.css';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Sentence } from '@orbit/shared';
import { api, ApiError, session } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useLive, ownerLiveQuery } from '@/lib/live';
import { useCountUp, useIntroOnce, usePageVisible } from '@/lib/motion';
import { LanguagePicker } from '@/components/LanguagePicker';
import { CommandBar, type OrbitScreen } from '@/components/CommandBar';
import { MoneyView } from '@/components/MoneyView';
import { PlanView } from '@/components/PlanCrew';
import { OrbitSystem, StatTiles, Ticker, type CrewMember, type TickerItem } from '@/components/bridge/Hero';
import { NeedsYou, type Decision } from '@/components/bridge/NeedsYou';
import { CrewFeed, Earnings, timeAgo, type FeedGroup } from '@/components/bridge/Feed';
import { CrewView, PeopleView, PowersView, DetailsView, ComingView } from '@/components/Views';
import { SpaceBackdrop } from '@/components/SpaceBackdrop';
import { MaintenanceBanner } from '@/components/MaintenanceBanner';

import { VIEWS, type BridgeData, type View } from '@/lib/bridge-types';

export default function BridgePage() {
  return (
    <Suspense fallback={<main className="br space-theme"><SpaceBackdrop variant="app" /><Skeleton /></main>}>
      <Bridge />
    </Suspense>
  );
}

function Bridge() {
  const { t, lang } = useI18n();
  const { me, loading, business, signOut } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [data, setData] = useState<BridgeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>((VIEWS as readonly string[]).includes(params.get('view') ?? '') ? (params.get('view') as View) : 'today');
  const [agent, setAgent] = useState<string | null>(null);
  const visible = usePageVisible();
  const intro = useIntroOnce('orbit.bridge.intro', !!data);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const refetch = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setData(await api<BridgeData>('/bridge'));
      setError(null);
    } catch (e) {
      setError((e as ApiError).code === 'offline' ? t('bridge.offline') : t('bridge.error'));
    }
  }, [t]);

  useEffect(() => {
    if (loading) return;
    if (!me) return router.replace('/login');
    if (!business && !me.impersonation) return router.replace('/onboarding');
    if (business?.status === 'onboarding') return router.replace('/onboarding');
    load();
  }, [loading, me, business, router, load]);

  // Live updates: any event refreshes The Bridge (debounced); a slow poll covers missed sockets.
  const liveQuery = useMemo(() => (me && (business || me.impersonation) ? ownerLiveQuery() : null), [me, business]);
  useLive(liveQuery, () => {
    clearTimeout(refetch.current);
    refetch.current = setTimeout(load, 250);
  });
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [visible, load]);

  // Orbit (Command Bar) opening a screen in front of the owner.
  const openScreen = useCallback((screen: OrbitScreen, id?: string) => {
    if (screen === 'conversation' && id) router.push(`/inbox/${id}`);
    else if (screen === 'inbox') router.push('/inbox');
    else if ((VIEWS as readonly string[]).includes(screen)) setView(screen as View);
  }, [router]);

  const openEntity = (it: { entityType: string | null; entityId: string | null }) => {
    if (it.entityType === 'conversation' && it.entityId) router.push(`/inbox/${it.entityId}`);
    else if (it.entityType === 'booking') setView('details');
    else if (it.entityType === 'lead' || it.entityType === 'customer') setView('people');
    else if (it.entityType === 'task') setView('crew');
    else if (it.entityType === 'power') setView('powers');
    else if (it.entityType === 'invoice') setView('money');
  };

  const onTouchStart = (e: React.TouchEvent) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY });
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current;
    touch.current = null;
    if (!s) return;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) > 90 && Math.abs(dy) < 50 && !(e.target as HTMLElement).closest('.decision, .switcher, input, textarea, .orbit')) {
      const i = VIEWS.indexOf(view) + (dx < 0 ? 1 : -1);
      if (i >= 0 && i < VIEWS.length) setView(VIEWS[i]);
    }
  };

  const names = Object.fromEntries((data?.crew ?? []).map((c) => [c.agent, c.name]));
  const dayName = data ? new Intl.DateTimeFormat(lang === 'en' ? 'en-IN' : `${lang}-IN`, { weekday: 'long', timeZone: data.business.timezone }).format(new Date(data.now)) : '';
  const greetingKey = data ? `greet.${data.dayPart}` : 'greet.morning';
  const switcher = (
    <nav className="switcher" aria-label={t('bridge.views')}>
      {VIEWS.map((v) => (
        <button key={v} aria-current={view === v} onClick={() => setView(v)}>{t(`view.${v}`)}</button>
      ))}
    </nav>
  );

  return (
    <main className={`br space-theme ${view === 'today' && data ? 'fit' : ''} ${intro ? 'intro' : ''} ${visible ? '' : 'paused'}`} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <SpaceBackdrop variant="app" />
      <Header
        dayName={dayName}
        business={data?.business.name ?? business?.name ?? ''}
        greeting={data ? t(greetingKey, { name: data.owner.firstName ?? '' }).replace(/,\s*$/, '') : ''}
        switcher={switcher}
        isAdmin={!!me?.user.isPlatformAdmin && !me.impersonation}
        signOut={signOut}
        ready={!!data}
      />
      <div className="br-switch-phone">{switcher}</div>
      <MaintenanceBanner />
      {me?.impersonation && (
        <p className="note small row between">
          <span>{t('bridge.impersonating')}</span>
          <button className="link-btn" onClick={() => {
            const admin = sessionStorage.getItem('orbit.admin.token');
            session.setToken(admin || null);
            session.setBusinessId(null);
            window.location.href = admin ? '/admin' : '/login';
          }}>{t('bridge.stop_viewing')}</button>
        </p>
      )}
      {params.get('result') && view === 'powers' && <p className="note small">{t(`powers.result.${params.get('result')}`, { power: params.get('power') ? `@power.${params.get('power')}` : '' })}</p>}

      {error && !data && (
        <div className="card stack" role="alert">
          <p>{error}</p>
          <button className="btn primary" onClick={load}>{t('common.retry')}</button>
        </div>
      )}
      {!data && !error && <Skeleton />}

      {data && view === 'today' && (
        <Today data={data} intro={intro} running={visible} names={names} dayName={dayName} reload={load} openEntity={openEntity}
          onAgent={(a) => { setAgent(a); setView('crew'); }} onOpen={(href) => router.push(href)} openScreen={openScreen} />
      )}
      {data && view === 'crew' && <CrewView data={data} selected={agent} onSelect={setAgent} />}
      {/* These load business data, so they wait until The Bridge (and the chosen business) is ready. */}
      {data && view === 'people' && <PeopleView />}
      {data && view === 'money' && <MoneyView />}
      {data && view === 'plan' && <PlanView />}
      {data && view === 'powers' && <PowersView />}
      {data && view === 'details' && <DetailsView />}
      {(view === 'tomorrow' || view === 'rewind') && <ComingView view={view} />}
      {data && view !== 'today' && <div className="br-phone-cmd"><CommandBar suggestions={data.suggestions} onDone={load} onOpen={openScreen} running={visible} /></div>}
    </main>
  );
}

function Header({ dayName, business, greeting, switcher, isAdmin, signOut, ready }: { dayName: string; business: string; greeting: string; switcher: React.ReactNode; isAdmin: boolean; signOut: () => void; ready: boolean }) {
  const { t, ts } = useI18n();
  const [notes, setNotes] = useState<{ unread: number; items: { id: string; title: Sentence; link: string | null; at: string; readAt: string | null }[] } | null>(null);
  const [open, setOpen] = useState(false);
  const bellArea = useRef<HTMLDivElement>(null);
  // Close the panel on a tap outside it or on Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !bellArea.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const loadNotes = useCallback(() => api('/notifications').then(setNotes).catch(() => undefined), []);
  useEffect(() => {
    if (ready) loadNotes();
  }, [ready, loadNotes]);
  useLive(ready ? ownerLiveQuery() : null, (e) => e.type === 'notification.new' && loadNotes());
  return (
    <header className="br-head rise" style={{ ['--d' as any]: '0s', position: 'relative' }}>
      <div className="logo" aria-hidden>
        <div className="ring" />
        <div className="core" />
        <div className="spin"><i /></div>
      </div>
      <div className="who">
        <div className="date">{dayName}{business ? ` · ${business}` : ''}</div>
        <h1 data-testid="greeting">{greeting || ' '}</h1>
      </div>
      <div className="br-desktop-only">{switcher}</div>
      <LanguagePicker compact />
      <div className="bell-area" ref={bellArea}>
      <button className="bell" aria-label={t('bridge.notifications', { count: notes?.unread ?? 0 })} aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && notes?.unread) api('/notifications/read', { body: {} }).then(loadNotes).catch(() => undefined);
        }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M10 20a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        {!!notes?.unread && <span className="dot" data-testid="bell-dot" />}
      </button>
      {open && (
        <div className="notes" role="dialog" aria-label={t('bridge.notifications_title')} data-testid="notes">
          <div className="notes-head"><b>{t('bridge.notifications_title')}</b><button className="link-btn small" onClick={signOut}>{t('bridge.sign_out')}</button></div>
          {isAdmin && <a className="chip" href="/admin" style={{ margin: '0 0 8px' }}>{t('bridge.admin')}</a>}
          {!notes?.items.length && <p className="muted small">{t('bridge.no_notifications')}</p>}
          {notes?.items.map((n) => (
            <a key={n.id} href={n.link ?? '#'} className={`note-row ${n.readAt ? '' : 'unread'}`}>
              <span className="note-text">{ts(n.title)}</span>
              <span className="note-time">{timeAgo(n.at, t)}</span>
            </a>
          ))}
        </div>
      )}
      </div>
    </header>
  );
}

function Today({ data, intro, running, names, dayName, reload, openEntity, onAgent, onOpen, openScreen }: {
  data: BridgeData; intro: boolean; running: boolean; names: Record<string, string>; dayName: string; reload: () => void;
  openEntity: (it: { entityType: string | null; entityId: string | null }) => void; onAgent: (a: string) => void; onOpen: (href: string) => void;
  openScreen: (screen: OrbitScreen, id?: string) => void;
}) {
  const { t, ts } = useI18n();
  const n = data.pulse.numbers;
  const share = async () => {
    const url = `${window.location.origin}/${data.business.slug}`;
    try {
      if (navigator.share) await navigator.share({ title: data.business.name, url });
      else await navigator.clipboard.writeText(url);
    } catch {}
  };
  const tiles = (cls: string) => <StatTiles className={cls} money={n.moneyToday} bookings={n.bookingsToday} needYou={data.needsYou.length} currency={data.business.currency} animate={intro} />;
  const briefing = data.dayPart !== 'afternoon' && data.briefing.length > 0 && (
    <section className="briefing rise" style={{ ['--d' as any]: '0.15s' }} data-testid="briefing">
      <div className="label" style={{ color: 'var(--muted)' }}>{data.mode === 'morning' ? t('brief.title_morning') : t('brief.title_evening')}</div>
      <ul>{data.briefing.map((s, i) => <li key={i}>{ts(s)}</li>)}</ul>
    </section>
  );
  return (
    <div className="br-grid pivot">
      {/* Desktop: one row of the day's key numbers across the top. */}
      <div className="kpi-strip br-desktop-only rise" style={{ ['--d' as any]: '0.04s' }} data-testid="kpi-strip">
        {tiles('kpi-tiles')}
        <KpiExtra earned={data.earnings.total} minutes={data.earnings.minutesSaved} score={data.pulse.score} currency={data.business.currency} byAgent={data.earnings.byAgent} animate={intro} />
      </div>
      <div className="br-col hero-col">
        <section className="hero-card rise" style={{ ['--d' as any]: '0.08s' }} data-testid="pulse">
          <div className="hero-top">
            <span className="label">{t('hero.working')}</span>
            <span className="live"><i />{t('hero.live')}</span>
          </div>
          <OrbitSystem crew={data.crew} score={data.pulse.score} animate={intro} onAgent={onAgent} />
          <p className="pulse-line" data-testid="pulse-sentence">{ts(data.pulse.sentence)}</p>
          {tiles('hero-tiles')}
          <Ticker
            items={data.isNew ? [] : data.ticker}
            running={running}
            empty={
              <>
                <span className="txt">{t('hero.ready')}</span>
                <button className="btn small share" onClick={share}>{t('hero.share')}</button>
              </>
            }
          />
        </section>
        {tiles('tiles phone')}
      </div>
      <div className="br-col mid-col">
        {data.mode === 'morning' && briefing}
        {data.mode === 'evening' && briefing}
        <NeedsYou cards={data.needsYou} onDecided={reload} onOpen={onOpen} dayName={dayName} />
        <div className="mid-earn" style={{ flexDirection: 'column' }}>
          <Earnings total={data.earnings.total} minutes={data.earnings.minutesSaved} rows={data.earnings.byAgent} currency={data.business.currency} animate={intro} />
        </div>
      </div>
      <div className="br-col feed-col">
        <CrewFeed groups={data.feed} names={names} animate={intro} onOpen={openEntity} />
      </div>
      {/* Ask Orbit: docked at the bottom of the screen on every size. */}
      <CommandBar suggestions={data.suggestions} onDone={reload} onOpen={openScreen} running={running} />
    </div>
  );
}

/** The rest of the desktop key-numbers row: Orbit's earnings this month, hours saved, and the Pulse. */
function KpiExtra({ earned, minutes, score, currency, byAgent, animate }: { earned: number; minutes: number; score: number; currency: string; byAgent: { name: string; value: number }[]; animate: boolean }) {
  const { t, money } = useI18n();
  const e = useCountUp(earned, animate);
  const hours = Math.round((minutes / 60) * 10) / 10;
  const top = byAgent.slice(0, 3).map((r) => `${r.name} ${money(r.value, currency)}`).join(' · ');
  return (
    <>
      <div className="tile kpi-earn" title={top} data-testid="kpi-earned">
        <b>{money(Math.round(e), currency)}</b>
        <span>{t('kpi.earned_month')}</span>
      </div>
      <div className="tile kpi-hours">
        <b>{t('kpi.hours', { count: hours })}</b>
        <span>{t('kpi.hours_saved')}</span>
      </div>
      <div className="tile kpi-pulse">
        <b>{score}<small>/100</small></b>
        <span>{t('kpi.pulse')}</span>
      </div>
    </>
  );
}

/** Soft skeleton shapes in the same layout — no spinners. */
function Skeleton() {
  return (
    <div className="br-grid" aria-busy="true" aria-label="Loading">
      <div className="br-col"><div className="sk" style={{ height: 470, borderRadius: 28 }} /><div className="sk" style={{ height: 70 }} /></div>
      <div className="br-col"><div className="sk" style={{ height: 240 }} /><div className="sk" style={{ height: 200 }} /></div>
      <div className="br-col">{[0, 1, 2, 3].map((i) => <div key={i} className="sk" style={{ height: 64, borderRadius: 18 }} />)}</div>
    </div>
  );
}
