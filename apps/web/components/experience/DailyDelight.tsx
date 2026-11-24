'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useCountUp } from '@/lib/motion';
import type { ExperienceData, ExperienceMilestone } from '@/lib/bridge-types';
import { AgentDot } from '@/components/bridge/Hero';

/** Plus+: weekly Orbit Wins card animating the week's best number. */
export function WinsCard({ wins, animate }: { wins: NonNullable<ExperienceData['wins']>; animate: boolean }) {
  const { t, ts, money } = useI18n();
  const shown = useCountUp(wins.value, animate);
  const display =
    wins.kind === 'money' ? money(Math.round(shown), wins.currency)
    : wins.kind === 'hours' ? `${Math.round(shown * 10) / 10}h`
    : wins.kind === 'empty' ? null
    : String(Math.round(shown));
  return (
    <section className="card exp-card" data-testid="wins-card">
      <div className="row between">
        <span className="label" style={{ color: 'var(--muted)' }}>{t(wins.titleKey)}</span>
        <span className="included-pill">{t('exp.included')}</span>
      </div>
      {display && <div className="exp-wins-num">{display}</div>}
      <p className="small" style={{ margin: 0 }}>{ts(wins.sentence)}</p>
    </section>
  );
}

/** Pro+: trigger card on Today for the 4-card swipeable Morning Story. */
export function MorningStoryCard({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <section className="card exp-card" data-testid="morning-story-card">
      <div className="row between">
        <div>
          <b>{t('exp.story.cta')}</b>
          <div className="small muted">{t('exp.story.sub')}</div>
        </div>
        <button type="button" className="btn primary small" onClick={onOpen} data-testid="open-morning-story">
          {t('exp.story.open')}
        </button>
      </div>
    </section>
  );
}

/** Pro+: 4-card swipeable Morning Story modal. */
export function MorningStoryModal({
  story,
  timezone,
  onClose,
}: {
  story: NonNullable<ExperienceData['morningStory']>;
  timezone: string;
  onClose: () => void;
}) {
  const { t, ts, money, lang } = useI18n();
  const [step, setStep] = useState(0);
  const touchX = useRef<number | null>(null);
  const nextTime = story.nextBookingAt
    ? new Intl.DateTimeFormat(lang === 'en' ? 'en-IN' : `${lang}-IN`, { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(new Date(story.nextBookingAt))
    : null;
  const total = 4;
  const next = () => (step < total - 1 ? setStep(step + 1) : onClose());
  const prev = () => step > 0 && setStep(step - 1);

  return (
    <div
      className="exp-modal"
      role="dialog"
      aria-modal="true"
      aria-label={t('exp.story.cta')}
      data-testid="morning-story-modal"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="exp-modal-card"
        onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touchX.current == null) return;
          const dx = e.changedTouches[0].clientX - touchX.current;
          touchX.current = null;
          if (dx < -40) next();
          else if (dx > 40) prev();
        }}
      >
        <div className="story-bars" aria-hidden>
          {[0, 1, 2, 3].map((i) => <i key={i} className={i <= step ? 'on' : ''} />)}
        </div>
        <div className="row between">
          <span className="label">{t('exp.story.cta')}</span>
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>×</button>
        </div>

        <div className="story-slide" data-testid={`story-slide-${step}`}>
          {step === 0 && (
            <>
              <span className="small muted">{t('exp.story.money_label')}</span>
              <div className="story-big">{money(story.yesterdayMoney, story.currency)}</div>
              <p className="small muted">
                {t('exp.story.money_sub', { spent: money(story.yesterdaySpent, story.currency), net: money(story.yesterdayNet, story.currency) })}
              </p>
            </>
          )}
          {step === 1 && (
            <>
              <span className="small muted">{t('exp.story.bookings_label')}</span>
              <div className="story-big">{t('exp.story.bookings_count', { count: story.bookingsToday })}</div>
              {nextTime && <p className="small muted">{t('exp.story.next_at', { time: nextTime })}</p>}
            </>
          )}
          {step === 2 && (
            <>
              <span className="small muted">{t('exp.story.moment_label')}</span>
              {story.bestMoment ? (
                <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                  <AgentDot agent={story.bestMoment.agent} size="lg" />
                  <p style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{ts(story.bestMoment.sentence)}</p>
                </div>
              ) : (
                <p style={{ fontSize: 17, fontWeight: 600 }}>{t('exp.story.moment_empty')}</p>
              )}
            </>
          )}
          {step === 3 && (
            <>
              <span className="small muted">{t('exp.story.tip_label')}</span>
              <p style={{ fontSize: 19, fontWeight: 700, margin: 0 }}>{ts(story.suggestion)}</p>
            </>
          )}
        </div>

        <div className="row between" style={{ marginTop: 12 }}>
          <button type="button" className="btn small" disabled={step === 0} onClick={prev}>←</button>
          <button type="button" className="btn primary" onClick={next} data-testid="story-next">
            {step < total - 1 ? t('exp.story.next') : t('exp.story.done')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Business+: dedicated Success Manager card read from platform_settings. */
export function SuccessManagerCard({ manager }: { manager: NonNullable<ExperienceData['successManager']> }) {
  const { t } = useI18n();
  const wa = manager.whatsapp?.replace(/\D/g, '');
  return (
    <section className="card exp-card" data-testid="success-manager-card">
      <div className="row between">
        <span className="label" style={{ color: 'var(--muted)' }}>{t('exp.sm.title')}</span>
        <span className="included-pill">{t('exp.included')}</span>
      </div>
      <div>
        <b style={{ fontSize: 16 }}>{manager.name}</b>
        <div className="small muted">{manager.role ?? t('exp.sm.sub')}</div>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {wa && <a className="btn primary small" href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">{t('exp.sm.whatsapp')}</a>}
        {manager.phone && <a className="btn small" href={`tel:${manager.phone}`}>{t('exp.sm.call')}</a>}
        {manager.email && <a className="btn small" href={`mailto:${manager.email}`}>{t('exp.sm.email')}</a>}
      </div>
    </section>
  );
}

/** Business+: magazine-style printable/shareable Monthly Business Report modal. */
export function BusinessReportModal({ onClose }: { onClose: () => void }) {
  const { t, money } = useI18n();
  const [rep, setRep] = useState<{
    month: string; businessName: string; currency: string; whiteLabel: boolean;
    revenue: number; expenses: number; profit: number; bookings: number; customers: number;
    hoursSaved: number; topServices: { name: string; count: number; revenue: number }[];
    crew: { agent: string; name: string; value: number; minutes: number }[];
  } | null>(null);
  useEffect(() => {
    api<any>('/experience/report').then(setRep).catch(() => undefined);
  }, []);
  const share = async () => {
    if (!rep) return;
    const text = `${rep.businessName} · ${rep.month}: ${money(rep.revenue, rep.currency)} revenue, ${rep.bookings} bookings, ${rep.hoursSaved}h saved.`;
    try {
      if (navigator.share) await navigator.share({ title: `${rep.businessName} — ${rep.month}`, text });
      else await navigator.clipboard.writeText(text);
    } catch {}
  };
  return (
    <div className="exp-modal" role="dialog" aria-modal="true" aria-label={t('exp.report.cta')} data-testid="business-report-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="exp-modal-card report-card">
        <div className="row between no-print">
          <span className="label">{t('exp.report.cta')}</span>
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>×</button>
        </div>
        {!rep ? (
          <p className="muted">{t('common.loading')}</p>
        ) : (
          <div className="stack">
            <div>
              <h2>{rep.businessName}</h2>
              <div className="small muted">{rep.month}{!rep.whiteLabel ? ' · Orbit Business' : ''}</div>
            </div>
            <div className="report-grid">
              <div className="report-stat"><b>{money(rep.revenue, rep.currency)}</b><span>{t('exp.report.revenue')}</span></div>
              <div className="report-stat"><b>{money(rep.expenses, rep.currency)}</b><span>{t('exp.report.expenses')}</span></div>
              <div className="report-stat"><b>{money(rep.profit, rep.currency)}</b><span>{t('exp.report.profit')}</span></div>
              <div className="report-stat"><b>{rep.bookings}</b><span>{t('exp.report.bookings')}</span></div>
              <div className="report-stat"><b>{rep.customers}</b><span>{t('exp.report.customers')}</span></div>
              <div className="report-stat"><b>{t('exp.report.hours_saved', { hours: rep.hoursSaved })}</b><span>{t('exp.report.crew_impact')}</span></div>
            </div>
            {rep.topServices.length > 0 && (
              <div>
                <div className="label" style={{ marginBottom: 6 }}>{t('exp.report.top_services')}</div>
                {rep.topServices.map((s) => (
                  <div key={s.name} className="list-item">
                    <span className="grow">{s.name}</span>
                    <span className="small muted">{s.count}× · {money(s.revenue, rep.currency)}</span>
                  </div>
                ))}
              </div>
            )}
            {rep.revenue === 0 && rep.bookings === 0 && <p className="small muted">{t('exp.report.no_data')}</p>}
            <div className="row no-print">
              <button type="button" className="btn primary" onClick={() => window.print()}>{t('exp.report.print')}</button>
              <button type="button" className="btn" onClick={share}>{t('exp.report.share')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Paid plans: Milestone celebration modal with confetti & Canvas PNG shareable card. */
export function MilestoneModal({
  milestone,
  businessName,
  whiteLabel,
  onDone,
}: {
  milestone: ExperienceMilestone;
  businessName: string;
  whiteLabel: boolean;
  onDone: () => void;
}) {
  const { t, money } = useI18n();
  const [busy, setBusy] = useState(false);
  const headline = t(`exp.milestone.${milestone.key}`);
  const sub = milestone.key.startsWith('bookings_')
    ? t('exp.milestone.sub_bookings', { count: Math.round(milestone.value ?? 100) })
    : milestone.key.startsWith('earned_')
    ? t('exp.milestone.sub_earned', { amount: money(milestone.value ?? 100000, milestone.currency) })
    : t('exp.milestone.sub_year');

  const buildPng = (): Promise<Blob | null> =>
    new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = 1080;
      c.height = 1080;
      const ctx = c.getContext('2d');
      if (!ctx) return resolve(null);
      const grad = ctx.createLinearGradient(0, 0, 1080, 1080);
      grad.addColorStop(0, '#181442');
      grad.addColorStop(1, '#3b2c99');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 1080, 1080);
      ctx.fillStyle = '#5ee0b5';
      ctx.font = 'bold 34px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(businessName.toUpperCase(), 540, 260);
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 84px system-ui, sans-serif';
      ctx.fillText(headline, 540, 520);
      ctx.fillStyle = '#d8d4ff';
      ctx.font = '500 36px system-ui, sans-serif';
      ctx.fillText(sub.slice(0, 54), 540, 620);
      if (!whiteLabel) {
        ctx.fillStyle = 'rgba(255,255,255,0.65)';
        ctx.font = '600 28px system-ui, sans-serif';
        ctx.fillText('Powered by Orbit', 540, 960);
      }
      c.toBlob((b) => resolve(b), 'image/png');
    });

  const downloadOrShare = async (shareMode: boolean) => {
    const blob = await buildPng();
    if (!blob) return;
    if (shareMode && navigator.share && navigator.canShare) {
      const file = new File([blob], `milestone-${milestone.key}.png`, { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ title: headline, files: [file] }).catch(() => undefined);
        return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `milestone-${milestone.key}.png`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    await api(`/experience/milestones/${milestone.id}/seen`, { body: {} }).catch(() => undefined);
    onDone();
  };

  const colors = ['#5ee0b5', '#a99bff', '#ffc857', '#ff9a7a', '#7aa7ff'];
  return (
    <div className="exp-modal" role="dialog" aria-modal="true" aria-label={headline} data-testid="milestone-modal">
      <div className="exp-modal-card exp-celebrate">
        <div className="confetti-layer" aria-hidden>
          {Array.from({ length: 18 }).map((_, i) => (
            <i key={i} style={{ left: `${(i * 37) % 96}%`, background: colors[i % colors.length], animationDelay: `${(i % 6) * 0.35}s` }} />
          ))}
        </div>
        <span className="plan-badge metal">{t('exp.milestone.badge')}</span>
        <h2 style={{ fontSize: 28, marginTop: 14 }}>{headline}</h2>
        <p className="muted">{sub}</p>
        <div className="row" style={{ justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={() => downloadOrShare(false)}>{t('exp.milestone.download')}</button>
          <button type="button" className="btn" onClick={() => downloadOrShare(true)}>{t('exp.milestone.share')}</button>
          <button type="button" className="btn primary" disabled={busy} onClick={dismiss} data-testid="milestone-close">{t('exp.milestone.close')}</button>
        </div>
      </div>
    </div>
  );
}
