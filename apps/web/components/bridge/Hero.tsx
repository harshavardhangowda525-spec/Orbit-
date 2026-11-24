'use client';

import type { AvatarStyle, Sentence } from '@orbit/shared';
import { useI18n } from '@/lib/i18n';
import { useCountUp, useCycle } from '@/lib/motion';
import type { ExperienceData } from '@/lib/bridge-types';
import { AgentGlyph } from '@/components/experience/PlanBadge';

export const AGENT_INITIAL: Record<string, string> = { aria: 'A', vox: 'V', nudge: 'N', ledger: 'L', spark: 'S', khata: 'K', orbit: 'O' };

/** Lanes per spec 5.3: inner 22s (Aria, Ledger half a lap behind), middle 30s (Vox, Nudge apart), outer 40s (Spark, Khata opposite). */
const LANES: { agent: string; lap: number; r: number; delay: number }[] = [
  { agent: 'aria', lap: 22, r: 29.333, delay: 0 },
  { agent: 'ledger', lap: 22, r: 29.333, delay: -11 },
  { agent: 'vox', lap: 30, r: 38, delay: -4 },
  { agent: 'nudge', lap: 30, r: 38, delay: -19 },
  { agent: 'spark', lap: 40, r: 45.333, delay: -27 },
  { agent: 'khata', lap: 40, r: 45.333, delay: -7 },
];

export interface CrewMember {
  agent: string;
  name: string;
  enabled: boolean;
  working: boolean;
}

export function AgentDot({ agent, size = '', avatarStyle = 'initials' }: { agent: string; size?: '' | 'sm' | 'lg'; avatarStyle?: AvatarStyle }) {
  return (
    <span className={`agent-dot ${size} a-${agent}`} aria-hidden>
      <AgentGlyph agent={agent} style={avatarStyle} />
    </span>
  );
}

/** The orbit system: agents travelling round the Pulse. Tapping an agent opens it in the Crew view. */
export function OrbitSystem({
  crew,
  score,
  animate,
  onAgent,
  experience,
}: {
  crew: CrewMember[];
  score: number;
  animate: boolean;
  onAgent: (a: string) => void;
  experience?: ExperienceData;
}) {
  const { t } = useI18n();
  const shown = useCountUp(score, animate);
  const R = 46; // progress ring radius in a 110×110 viewBox (7px stroke)
  const C = 2 * Math.PI * R;
  const byKey = Object.fromEntries(crew.map((c) => [c.agent, c]));
  const planCode = experience?.plan.code ?? 'free';
  const exp = experience?.plan.experience;
  const perks = exp?.perks ?? [];
  const hasTrails = perks.includes('heroTrails');
  const branches = perks.includes('constellation') ? (experience?.locations ?? []) : [];
  const avatarStyle = experience?.appearance.effectiveAvatar ?? 'initials';
  const ringStop1 = experience?.appearance.effectiveBrandColor ?? exp?.accent ?? '#5B4CE0';
  const ringStop2 = experience?.appearance.effectiveBrandColor ?? exp?.accent2 ?? '#5B4CE0';
  const gradId = `pulse-ring-${planCode}`;
  return (
    <div
      className={`orbit plan-${planCode} ${hasTrails ? 'trails' : ''} ${branches.length ? 'constellation' : ''}`}
      role="group"
      aria-label={t('hero.orbit_label')}
      data-testid="orbit-system"
      data-trails={hasTrails ? 'true' : 'false'}
    >
      <div className="ringline r1" />
      <div className="ringline r2" />
      <div className="ringline r3" />
      {branches.length > 0 && <div className="ringline r4" data-testid="constellation-ring" />}
      {branches.map((loc, idx) => (
        <span
          key={loc.id}
          className="branch-dot"
          data-testid="branch-dot"
          style={{ ['--ang' as any]: `${(idx * 360) / branches.length - 45}deg` }}
          title={loc.name}
        >
          {loc.name}
        </span>
      ))}
      {LANES.map((l) => {
        const m = byKey[l.agent];
        return (
          <div key={l.agent} className="lane" style={{ ['--lap' as any]: `${l.lap}s`, ['--delay' as any]: `${l.delay}s`, ['--r' as any]: `${l.r}cqw` }}>
            <div className={`agent a-${l.agent} ${m?.working ? 'working' : ''} ${m && !m.enabled ? 'off' : ''}`}>
              <button type="button" onClick={() => onAgent(l.agent)} aria-label={t('hero.agent_label', { agent: m?.name ?? l.agent, status: `@crew.status.${m?.working ? 'working' : m?.enabled === false ? 'off' : 'idle'}` })}>
                <AgentGlyph agent={l.agent} style={avatarStyle} />
              </button>
            </div>
          </div>
        );
      })}
      <div className="pulse-core" aria-label={t('pulse.score_label', { score })}>
        <svg viewBox="0 0 110 110" aria-hidden>
          <defs>
            <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={ringStop1} />
              <stop offset="100%" stopColor={ringStop2} />
            </linearGradient>
          </defs>
          <circle cx="55" cy="55" r={R} fill="none" stroke="#ECEAF8" strokeWidth="7" />
          <circle
            className="ring-progress"
            cx="55" cy="55" r={R} fill="none" stroke={`url(#${gradId})`} strokeWidth="7" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - Math.max(0, Math.min(100, shown)) / 100)}
            style={animate ? undefined : { transition: 'none' }}
          />
        </svg>
        <div className="score" data-testid="pulse-score">
          {Math.round(shown)}
          <span className="pl">PULSE</span>
        </div>
      </div>
    </div>
  );
}

export interface TickerItem {
  agent: string;
  name: string;
  sentence: Sentence;
  live: boolean;
}

/** One agent's current activity, cycling every 2.6s. Typing dots only while work is really in progress. */
export function Ticker({ items, running, empty }: { items: TickerItem[]; running: boolean; empty?: React.ReactNode }) {
  const { ts } = useI18n();
  const i = useCycle(items.length, 2600, running);
  if (!items.length) return <div className="ticker">{empty}</div>;
  const it = items[i];
  return (
    <div className="ticker" aria-live="polite" data-testid="ticker">
      <span className={`agent-dot sm a-${it.agent}`} aria-hidden>{AGENT_INITIAL[it.agent]}</span>
      <span className="txt" key={`${i}-${it.agent}`}>{ts(it.sentence)}</span>
      {it.live && (
        <span className="typing" aria-hidden>
          <i /><i /><i />
        </span>
      )}
    </div>
  );
}

/** Money today, bookings today, need-you. Numbers count up on first load. */
export function StatTiles({ money, bookings, needYou, currency, animate, className = '' }: { money: number; bookings: number; needYou: number; currency: string; animate: boolean; className?: string }) {
  const { t, money: fmt } = useI18n();
  const m = useCountUp(money, animate);
  const b = useCountUp(bookings, animate);
  return (
    <div className={className} data-testid="tiles">
      <div className="tile rise" style={{ ['--d' as any]: '0.2s' }}>
        <b>{fmt(Math.round(m), currency)}</b>
        <span>{t('tiles.money_today')}</span>
      </div>
      <div className="tile rise" style={{ ['--d' as any]: '0.28s' }}>
        <b>{Math.round(b)}</b>
        <span>{t('tiles.bookings_today')}</span>
      </div>
      <div className="tile attn rise" style={{ ['--d' as any]: '0.36s' }} data-testid="tile-need-you">
        <b>{needYou}</b>
        <span>{t('tiles.need_you')}</span>
      </div>
    </div>
  );
}
