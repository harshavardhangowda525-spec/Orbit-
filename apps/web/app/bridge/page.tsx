'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Sentence } from '@orbit/shared';
import { api, ApiError, session } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { LanguagePicker } from '@/components/LanguagePicker';
import { Checklist } from '@/components/LiveLinks';
import { CommandBar } from '@/components/CommandBar';
import { CrewView, PeopleView, PowersView, DetailsView, ComingView } from '@/components/Views';

export interface BridgeData {
  business: { id: string; name: string; slug: string; timezone: string; currency: string; status: string };
  mode: 'morning' | 'evening';
  pulse: { score: number; mood: 'great' | 'good' | 'watch' | 'low'; sentence: Sentence; numbers: { moneyToday: number; bookingsToday: number; peopleWaiting: number } };
  briefing: Sentence[];
  needsYou: { id: string; agent: string; agentName: string; type: string; title: Sentence; context: Record<string, unknown>; options: { key: string; label: string; style: string }[] }[];
  feed: { id: string; agent: string; type: string; at: string; sentence: Sentence; items: { id: string; sentence: Sentence; at: string }[] }[];
  earnings: { total: number; minutesSaved: number; byAgent: { agent: string; name: string; value: number; minutes: number }[] };
  crew: { agent: string; name: string; enabled: boolean }[];
  suggestions: string[];
}

const VIEWS = ['bridge', 'crew', 'people', 'tomorrow', 'rewind', 'powers', 'details'] as const;
type View = (typeof VIEWS)[number];

export default function Bridge() {
  const { t } = useI18n();
  const { me, loading, business, signOut } = useSession();
  const router = useRouter();
  const [data, setData] = useState<BridgeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('bridge');
  const [checklist, setChecklist] = useState<{ key: string; done: boolean }[] | null>(null);
  const [pull, setPull] = useState(0);
  const touch = useRef<{ x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<BridgeData>('/bridge'));
      setError(null);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!me) return router.replace('/login');
    if (!business && !me.impersonation) return router.replace('/onboarding');
    if (business?.status === 'onboarding') return router.replace('/onboarding');
    load();
    api('/onboarding/state').then((s) => setChecklist(s.checklist)).catch(() => undefined);
    // Live refresh (WebSockets arrive with the live inbox in Phase 2).
    const id = setInterval(() => document.visibilityState === 'visible' && load(), 30_000);
    return () => clearInterval(id);
  }, [loading, me, business, router, load]);

  // Swipe left/right between views; pull down at the top to refresh.
  const onTouchStart = (e: React.TouchEvent) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY });
  const onTouchMove = (e: React.TouchEvent) => {
    if (!touch.current || window.scrollY > 0) return;
    const dy = e.touches[0].clientY - touch.current.y;
    if (dy > 0 && Math.abs(e.touches[0].clientX - touch.current.x) < 30) setPull(Math.min(dy, 90));
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    if (pull > 70) load();
    setPull(0);
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) > 90 && Math.abs(dy) < 50 && !(e.target as HTMLElement).closest('.cards, .views, input, textarea')) {
      const i = VIEWS.indexOf(view) + (dx < 0 ? 1 : -1);
      if (i >= 0 && i < VIEWS.length) setView(VIEWS[i]);
    }
  };

  return (
    <main className="page bridge" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <div className="ptr" style={{ height: pull }}>{pull > 70 ? t('bridge.release') : t('bridge.pull')}</div>
      <div className="topbar">
        <div className="name">{data?.business.name ?? business?.name ?? 'Orbit'}</div>
        <div className="row">
          <LanguagePicker compact />
          {me?.user.isPlatformAdmin && !me.impersonation && <a className="chip" href="/admin">{t('bridge.admin')}</a>}
          <button className="chip" onClick={signOut}>{t('bridge.sign_out')}</button>
        </div>
      </div>
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
      <nav className="views" aria-label={t('bridge.views')}>
        {VIEWS.map((v) => (
          <button key={v} className="chip" aria-current={view === v} onClick={() => setView(v)}>
            {t(`view.${v}`)}
          </button>
        ))}
      </nav>

      {error && <p className="error" role="alert">{error}</p>}
      {!data && !error && <p className="muted">{t('common.loading')}</p>}

      {data && view === 'bridge' && <BridgeHome data={data} reload={load} checklist={checklist} />}
      {data && view === 'crew' && <CrewView data={data} />}
      {view === 'people' && <PeopleView />}
      {view === 'powers' && <PowersView />}
      {view === 'details' && <DetailsView />}
      {(view === 'tomorrow' || view === 'rewind') && <ComingView view={view} />}

      {data && <CommandBar suggestions={data.suggestions} onDone={load} />}
    </main>
  );
}

function BridgeHome({ data, reload, checklist }: { data: BridgeData; reload: () => void; checklist: { key: string; done: boolean }[] | null }) {
  const { t, ts, money } = useI18n();
  const { pulse } = data;
  const briefing = (
    <section className="card" data-testid="briefing">
      <h2>{data.mode === 'morning' ? t('bridge.morning') : t('bridge.evening')}</h2>
      <ul className="stack" style={{ margin: 0, paddingLeft: 18, gap: 4 }}>
        {data.briefing.map((s, i) => <li key={i}>{ts(s)}</li>)}
      </ul>
    </section>
  );
  return (
    <>
      {/* 1. PULSE */}
      <section className="card" aria-label={t('zone.pulse')} data-testid="pulse">
        <div className="pulse">
          <div className={`ring ${pulse.mood}`} style={{ ['--score' as any]: pulse.score }} role="img" aria-label={t('pulse.score_label', { score: pulse.score })}>
            <span>{pulse.score}</span>
          </div>
          <div className="grow">
            <div className="small muted">{t('zone.pulse')}</div>
            <div className="pulse-sentence">{ts(pulse.sentence)}</div>
          </div>
        </div>
        <div className="numbers">
          <div className="num"><b>{money(pulse.numbers.moneyToday, data.business.currency)}</b><span>{t('pulse.label.money_today')}</span></div>
          <div className="num"><b>{pulse.numbers.bookingsToday}</b><span>{t('pulse.label.bookings_today')}</span></div>
          <div className="num"><b>{pulse.numbers.peopleWaiting}</b><span>{t('pulse.label.people_waiting')}</span></div>
        </div>
      </section>

      {data.mode === 'morning' && <div style={{ marginTop: 12 }}>{briefing}</div>}

      {/* 2. NEEDS YOU */}
      <div className="zone-title">
        <h2>{t('zone.needs_you')}</h2>
        {data.needsYou.length > 0 && <span className="small muted">{t('needs.count', { count: data.needsYou.length })}</span>}
      </div>
      {data.needsYou.length === 0 ? (
        <div className="card empty" data-testid="needs-empty">
          <div className="big">✨</div>
          <div>{t('needs.empty')}</div>
        </div>
      ) : (
        <div className="cards" data-testid="needs-you">
          {data.needsYou.map((c) => <NeedCard key={c.id} card={c} onDone={reload} />)}
        </div>
      )}

      {data.mode === 'evening' && <div style={{ marginTop: 12 }}>{briefing}</div>}

      {/* 3. ORBIT FEED */}
      <div className="zone-title"><h2>{t('zone.feed')}</h2></div>
      <section className="card" data-testid="feed">
        {data.feed.length === 0 ? (
          <p className="muted">{t('feed.empty')}</p>
        ) : (
          <ul className="feed">
            {data.feed.map((g) => <FeedRow key={g.id} group={g} />)}
          </ul>
        )}
      </section>

      {/* ORBIT EARNINGS */}
      <div className="zone-title"><h2>{t('zone.earnings')}</h2></div>
      <section className="card" data-testid="earnings">
        <div className="earn">
          <div>
            <b>{money(data.earnings.total, data.business.currency)}</b>
            <div className="small muted">{t('earn.sub', { count: Math.round(data.earnings.minutesSaved / 6) / 10 })}</div>
          </div>
          <span style={{ fontSize: '2rem' }} aria-hidden>🪐</span>
        </div>
        {data.earnings.byAgent.length > 0 && (
          <div className="bars">
            {data.earnings.byAgent.map((a) => (
              <div key={a.agent} className={`bar a-${a.agent}`}>
                <span>{a.name}</span>
                <div className="track"><div className="fill" style={{ width: `${data.earnings.total ? Math.max(4, (a.value / data.earnings.total) * 100) : 0}%`, background: 'var(--c)' }} /></div>
                <span className="small">{money(a.value, data.business.currency)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {checklist && checklist.some((c) => !c.done) && (
        <details style={{ marginTop: 16 }}>
          <summary className="btn ghost block">{t('check.title')}</summary>
          <div style={{ marginTop: 12 }}><Checklist items={checklist} /></div>
        </details>
      )}
    </>
  );
}

function NeedCard({ card, onDone }: { card: BridgeData['needsYou'][number]; onDone: () => void }) {
  const { t, ts } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ctx = card.context as Record<string, any>;
  return (
    <article className="card need" data-card-type={card.type}>
      <div className="who"><span className={`avatar a-${card.agent}`}>{card.agentName[0]}</span>{card.agentName}</div>
      <div className="title">{ts(card.title)}</div>
      {(ctx.conversation || ctx.review || ctx.sample) && (
        <div className="ctx">
          {ctx.conversation && <div>{ctx.conversation}</div>}
          {ctx.review && <div>“{ctx.review}”</div>}
          {ctx.suggestedReply && <div style={{ marginTop: 6 }}><b>{t('needs.suggested')}:</b> {ctx.suggestedReply}</div>}
          {ctx.sample && <div><b>{t('needs.sample')}:</b> {ctx.sample}</div>}
        </div>
      )}
      <div className="actions">
        {card.options.map((o) => (
          <button key={o.key} className={`btn ${o.style === 'primary' ? 'primary' : o.style === 'ghost' ? 'ghost' : ''}`} disabled={!!busy}
            onClick={async () => {
              setBusy(o.key);
              setErr(null);
              try {
                await api(`/bridge/cards/${card.id}/decide`, { body: { option: o.key } });
                onDone();
              } catch (e) {
                setErr((e as ApiError).message);
                setBusy(null);
              }
            }}>
            {busy === o.key ? '…' : t(o.label)}
          </button>
        ))}
      </div>
      {err && <p className="error small">{err}</p>}
    </article>
  );
}

function FeedRow({ group }: { group: BridgeData['feed'][number] }) {
  const { ts, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const many = group.items.length > 1;
  return (
    <li>
      <span className={`avatar a-${group.agent}`} aria-hidden>{group.agent[0].toUpperCase()}</span>
      <div className="grow">
        <div>{ts(group.sentence)}</div>
        <div className="when">{ago(group.at, lang)}{many && <button className="link-btn small" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '▲' : `▼ ${group.items.length}`}</button>}</div>
        {many && open && (
          <ul className="sub">
            {group.items.map((i) => <li key={i.id}>{ts(i.sentence)}</li>)}
          </ul>
        )}
      </div>
    </li>
  );
}

function ago(iso: string, lang: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (Math.abs(mins) < 60) return rtf.format(-mins, 'minute');
  const hrs = Math.round(mins / 60);
  if (Math.abs(hrs) < 24) return rtf.format(-hrs, 'hour');
  return rtf.format(-Math.round(hrs / 24), 'day');
}
