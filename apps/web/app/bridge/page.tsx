'use client';

import './bridge.css';
import './bridge-glow.css';
import '@/components/experience/experience.css';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { inkOn, type Sentence } from '@orbit/shared';
import { api, ApiError, session } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useLive, ownerLiveQuery } from '@/lib/live';
import { useCountUp, useIntroOnce, usePageVisible } from '@/lib/motion';
import { AppNav } from '@/components/AppNav';
import { CommandBar, prefillCommand, type OrbitScreen } from '@/components/CommandBar';
import { UndoBar } from '@/components/trust/UndoBar';
import { WhySheetHost } from '@/components/trust/WhySheet';
import { ScanBill } from '@/components/khata/ScanBill';
import { KhataMini } from '@/components/khata/KhataMini';
import { MoneyView } from '@/components/MoneyView';
import { PlanView } from '@/components/PlanCrew';
import { OrbitSystem, StatTiles, Ticker, type CrewMember, type TickerItem } from '@/components/bridge/Hero';
import { NeedsYou, type Decision } from '@/components/bridge/NeedsYou';
import { CrewFeed, Earnings, timeAgo, type FeedGroup } from '@/components/bridge/Feed';
import { CrewView, PeopleView, PowersView, DetailsView, ComingView } from '@/components/Views';
import { SpaceBackdrop } from '@/components/SpaceBackdrop';
import { MaintenanceBanner } from '@/components/MaintenanceBanner';
import { PlanBadge } from '@/components/experience/PlanBadge';
import { DowngradeSummary, UpgradeCelebration, WhatsNewCard } from '@/components/experience/UpgradeFlow';
import { BusinessReportModal, MilestoneModal, MorningStoryCard, MorningStoryModal, SuccessManagerCard, WinsCard } from '@/components/experience/DailyDelight';

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
  const [agent, setAgent] = useState<string | null>(params.get('agent'));
  const [scan, setScan] = useState(false);
  const visible = usePageVisible();
  const intro = useIntroOnce('orbit.bridge.intro', !!data);
  // Links within the app (e.g. "Change this rule" from a Why? sheet) change the URL without remounting.
  useEffect(() => {
    const v = params.get('view');
    if (v && (VIEWS as readonly string[]).includes(v)) setView(v as View);
    if (params.get('agent')) setAgent(params.get('agent'));
  }, [params]);
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

  const [storyOpen, setStoryOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [morningGreet, setMorningGreet] = useState(false);
  const exp = data?.experience;
  const whiteLabel = !!exp?.plan.whiteLabel;
  const effectiveTheme = exp?.appearance.effectiveTheme ?? 'space';
  const brandColor = exp?.appearance.effectiveBrandColor ?? null;

  // Business+: animated morning greeting on first open each local day.
  useEffect(() => {
    if (!data || !exp?.plan.experience.perks.includes('morningGreeting')) return;
    const key = `orbit.greet.${data.business.id}.${data.now.slice(0, 10)}`;
    if (typeof window !== 'undefined' && !localStorage.getItem(key)) {
      localStorage.setItem(key, '1');
      setMorningGreet(true);
      const id = setTimeout(() => setMorningGreet(false), 1800);
      return () => clearTimeout(id);
    }
  }, [data, exp]);

  const names = Object.fromEntries((data?.crew ?? []).map((c) => [c.agent, c.name]));
  const dayName = data ? new Intl.DateTimeFormat(lang === 'en' ? 'en-IN' : `${lang}-IN`, { weekday: 'long', timeZone: data.business.timezone }).format(new Date(data.now)) : '';
  const greetingKey = data ? `greet.${data.dayPart}` : 'greet.morning';
  const selectView = (v: View) => {
    setView(v);
    window.history.replaceState(null, '', v === 'today' ? '/bridge' : `/bridge?view=${v}`);
  };

  const mainStyle = brandColor
    ? ({ ['--brand-accent' as any]: brandColor, ['--brand-ink' as any]: inkOn(brandColor) } as React.CSSProperties)
    : undefined;
  const showUpgradeCelebration = !!exp?.planChange && !exp.planChange.seenAt && exp.planChange.direction === 'up';
  const showMilestone = !showUpgradeCelebration && !!exp?.milestones.unseen;

  return (
    <main
      className={`br has-nav space-theme ${view === 'today' && data ? 'fit' : ''} ${intro ? 'intro' : ''} ${morningGreet ? 'morning-greet' : ''} ${visible ? '' : 'paused'}`}
      data-theme={effectiveTheme}
      data-plan={exp?.plan.code ?? 'free'}
      data-brand={brandColor ? 'true' : undefined}
      data-whitelabel={whiteLabel ? 'true' : 'false'}
      style={mainStyle}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <SpaceBackdrop variant="app" />
      <AppNav
        active={view}
        onSelect={selectView}
        business={data?.business.name ?? business?.name ?? ''}
        badges={{ today: data?.needsYou.length ?? 0, inbox: data?.pulse.numbers.peopleWaiting ?? 0 }}
        whiteLabel={whiteLabel}
      />
      <Header
        dayName={dayName}
        business={data?.business.name ?? business?.name ?? ''}
        greeting={data ? t(greetingKey, { name: data.owner.firstName ?? '' }).replace(/,\s*$/, '') : ''}
        isAdmin={!!me?.user.isPlatformAdmin && !me.impersonation}
        signOut={signOut}
        ready={!!data}
        experience={exp}
      />
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
        <Today
          data={data}
          intro={intro || morningGreet}
          running={visible}
          names={names}
          dayName={dayName}
          reload={load}
          openEntity={openEntity}
          onAgent={(a) => { setAgent(a); setView('crew'); }}
          onOpen={(href) => router.push(href)}
          openScreen={openScreen}
          onSelectView={selectView}
          onOpenStory={() => setStoryOpen(true)}
          onOpenReport={() => setReportOpen(true)}
        />
      )}
      {data && view === 'crew' && <CrewView data={data} selected={agent} onSelect={setAgent} highlight={params.get('highlight') ?? (params.get('section') === 'safety' ? 'safety' : null)} onUpgrade={() => selectView('plan')} />}
      {/* These load business data, so they wait until The Bridge (and the chosen business) is ready. */}
      {data && view === 'people' && <PeopleView />}
      {data && view === 'money' && <MoneyView />}
      {data && view === 'plan' && <PlanView />}
      {data && view === 'powers' && <PowersView />}
      {data && view === 'details' && <DetailsView experience={exp} onReload={load} onUpgrade={() => selectView('plan')} />}
      {(view === 'tomorrow' || view === 'rewind') && <ComingView view={view} />}
      {data && view !== 'today' && <div className="br-phone-cmd"><CommandBar suggestions={data.suggestions} onDone={load} onOpen={openScreen} running={visible} whiteLabel={whiteLabel} /></div>}
      {data && <UndoBar held={data.held ?? []} onChanged={load} onEditAgain={(text) => prefillCommand(text)} />}
      <WhySheetHost />
      {/* Scan bill: one tap from anywhere on The Bridge (Khata). */}
      {data && !scan && view === 'today' && (
        <button className="scan-fab" onClick={() => setScan(true)} data-testid="scan-fab" aria-label={t('khata.scan.button')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></svg>
          <span>{t('khata.scan.short')}</span>
        </button>
      )}
      {scan && (
        <div className="khata-sheet" role="dialog" aria-modal="true" aria-label={t('khata.scan.title')} onClick={(e) => e.target === e.currentTarget && setScan(false)}>
          <ScanBill onDone={(m) => { setScan(false); load(); if (m) router.push(`/bridge?view=money&month=${m}`); }} currency={data?.business.currency} />
        </div>
      )}
      {showUpgradeCelebration && exp?.planChange && (
        <UpgradeCelebration planChange={exp.planChange} experience={exp} ownerName={data?.owner.firstName ?? null} onDone={load} />
      )}
      {showMilestone && exp?.milestones.unseen && (
        <MilestoneModal milestone={exp.milestones.unseen} businessName={data?.business.name ?? ''} whiteLabel={whiteLabel} onDone={load} />
      )}
      {storyOpen && exp?.morningStory && data && (
        <MorningStoryModal story={exp.morningStory} timezone={data.business.timezone} onClose={() => setStoryOpen(false)} />
      )}
      {reportOpen && <BusinessReportModal onClose={() => setReportOpen(false)} />}
    </main>
  );
}

function Header({ dayName, business, greeting, isAdmin, signOut, ready, experience }: { dayName: string; business: string; greeting: string; isAdmin: boolean; signOut: () => void; ready: boolean; experience?: BridgeData['experience'] }) {
  const { t, ts } = useI18n();
  const [notes, setNotes] = useState<{ unread: number; items: { id: string; title: Sentence; link: string | null; at: string; readAt: string | null }[] } | null>(null);
  const [open, setOpen] = useState(false);
  const bellArea = useRef<HTMLDivElement>(null);
  const whiteLabel = !!experience?.plan.whiteLabel;
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
      {whiteLabel ? (
        <span className="agent-dot a-orbit" aria-hidden>{(business || 'B')[0]?.toUpperCase()}</span>
      ) : (
        <div className="logo" aria-hidden>
          <div className="ring" />
          <div className="core" />
          <div className="spin"><i /></div>
        </div>
      )}
      <div className="who">
        <div className="date" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span>{dayName}{business ? ` · ${business}` : ''}</span>
          <PlanBadge experience={experience?.plan.experience} whiteLabel={whiteLabel} />
        </div>
        <h1 data-testid="greeting">{greeting || ' '}</h1>
      </div>
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

function Today({ data, intro, running, names, dayName, reload, openEntity, onAgent, onOpen, openScreen, onSelectView, onOpenStory, onOpenReport }: {
  data: BridgeData; intro: boolean; running: boolean; names: Record<string, string>; dayName: string; reload: () => void;
  openEntity: (it: { entityType: string | null; entityId: string | null }) => void; onAgent: (a: string) => void; onOpen: (href: string) => void;
  openScreen: (screen: OrbitScreen, id?: string) => void;
  onSelectView: (v: View) => void;
  onOpenStory: () => void;
  onOpenReport: () => void;
}) {
  const { t, ts } = useI18n();
  const n = data.pulse.numbers;
  const exp = data.experience;
  const whiteLabel = !!exp?.plan.whiteLabel;
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
  const handleWhatsNew = (action: 'details' | 'crew' | 'story' | 'report' | 'wins') => {
    if (action === 'details') onSelectView('details');
    else if (action === 'crew') onSelectView('crew');
    else if (action === 'story') onOpenStory();
    else if (action === 'report') onOpenReport();
  };
  return (
    <div className="br-grid pivot">
      {/* Desktop: one row of the day's key numbers across the top. */}
      <div className="kpi-strip br-desktop-only rise" style={{ ['--d' as any]: '0.04s' }} data-testid="kpi-strip">
        {tiles('kpi-tiles')}
        <KpiExtra earned={data.earnings.total} minutes={data.earnings.minutesSaved} score={data.pulse.score} currency={data.business.currency} byAgent={data.earnings.byAgent} animate={intro} />
      </div>
      <div className="br-col hero-col">
        {exp?.appearance.activeFestival && (
          <div className="festival-pill" data-testid="festival-banner">
            ✨ {t('exp.festival.banner', { festival: t(`exp.festival.${exp.appearance.activeFestival}`) })}
          </div>
        )}
        <section className="hero-card rise" style={{ ['--d' as any]: '0.08s' }} data-testid="pulse">
          <div className="hero-top">
            <span className="label">{t('hero.working')}</span>
            <span className="live"><i />{t('hero.live')}</span>
          </div>
          <OrbitSystem crew={data.crew} score={data.pulse.score} animate={intro} onAgent={onAgent} experience={exp} />
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
        {exp?.planChange && !exp.planChange.seenAt && exp.planChange.direction === 'down' && (
          <DowngradeSummary planChange={exp.planChange} onDone={reload} onViewPlans={() => onSelectView('plan')} />
        )}
        {exp?.planChange && exp.planChange.direction === 'up' && exp.planChange.seenAt && (
          <WhatsNewCard planChange={exp.planChange} onAction={handleWhatsNew} onReload={reload} />
        )}
        {exp?.morningStory && <MorningStoryCard onOpen={onOpenStory} />}
        {data.mode === 'morning' && briefing}
        {data.mode === 'evening' && briefing}
        <NeedsYou cards={data.needsYou} onDecided={reload} onOpen={onOpen} dayName={dayName} />
        {exp?.wins && <WinsCard wins={exp.wins} animate={intro} />}
        {exp?.plan.experience.perks.includes('magazineReport') && (
          <section className="card exp-card" data-testid="business-report-card">
            <div className="row between">
              <div>
                <b>{t('exp.report.cta')}</b>
                <div className="small muted">{t('exp.report.sub')}</div>
              </div>
              <button type="button" className="btn small" onClick={onOpenReport} data-testid="open-business-report">
                {t('exp.report.open')}
              </button>
            </div>
          </section>
        )}
        {exp?.successManager && <SuccessManagerCard manager={exp.successManager} />}
        <div className="mid-earn" style={{ flexDirection: 'column' }}>
          <KhataMini refresh={data} onOpen={() => openScreen('money')} />
          <Earnings total={data.earnings.total} minutes={data.earnings.minutesSaved} rows={data.earnings.byAgent} currency={data.business.currency} animate={intro} />
        </div>
      </div>
      <div className="br-col feed-col">
        <CrewFeed groups={data.feed} names={names} animate={intro} onOpen={openEntity} />
      </div>
      {/* Ask Orbit: docked at the bottom of the screen on every size. */}
      <CommandBar suggestions={data.suggestions} onDone={reload} onOpen={openScreen} running={running} whiteLabel={whiteLabel} />
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
