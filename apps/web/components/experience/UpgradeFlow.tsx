'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { ExperienceData, ExperiencePlanChange } from '@/lib/bridge-types';
import { AgentDot } from '@/components/bridge/Hero';

/** Skippable 2–3s upgrade celebration modal (shown once per upgrade). */
export function UpgradeCelebration({
  planChange,
  experience,
  ownerName,
  onDone,
}: {
  planChange: ExperiencePlanChange;
  experience: ExperienceData;
  ownerName: string | null;
  onDone: () => void;
}) {
  const { t, ts } = useI18n();
  const [busy, setBusy] = useState(false);
  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    await api(`/experience/plan-change/${planChange.id}/seen`, { body: {} }).catch(() => undefined);
    onDone();
  };
  const wl = experience.plan.whiteLabel;
  const titleKey = wl
    ? ownerName ? 'exp.upgrade.title_wl' : 'exp.upgrade.title_wl_noname'
    : ownerName ? 'exp.upgrade.title' : 'exp.upgrade.title_noname';
  return (
    <div className="exp-modal" role="dialog" aria-modal="true" aria-label={t(titleKey, { plan: planChange.toPlanName, name: ownerName ?? '' })} data-testid="upgrade-celebration">
      <div className="exp-modal-card exp-celebrate" style={{ ['--plan-accent' as any]: experience.plan.experience.accent }}>
        <div className="exp-sweep" aria-hidden />
        <div className="row between" style={{ position: 'relative' }}>
          <span className={`plan-badge ${experience.plan.experience.badge === 'none' ? 'plain' : experience.plan.experience.badge}`}>
            {wl ? planChange.toPlanName : experience.plan.experience.label}
          </span>
          <button type="button" className="link-btn small" onClick={dismiss} data-testid="upgrade-skip">{t('exp.upgrade.skip')}</button>
        </div>
        <div className="exp-rings" aria-hidden>
          <span className="er er1" />
          <span className="er er2" />
          <span className="er er3" />
          <AgentDot agent="orbit" size="lg" />
        </div>
        <h2>{t(titleKey, { plan: planChange.toPlanName, name: ownerName ?? '' })}</h2>
        <p className="muted small">{t('exp.upgrade.sub')}</p>
        {planChange.newAgents.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="label" style={{ opacity: 0.75 }}>{t('exp.upgrade.launching')}</div>
            <div className="exp-launch-row">
              {planChange.newAgents.map((a, i) => (
                <span key={a} className="exp-launch-chip" style={{ ['--d' as any]: `${0.35 + i * 0.22}s` }}>
                  <AgentDot agent={a} size="sm" />
                  {t(`agent.${a}.name`)}
                </span>
              ))}
            </div>
          </div>
        )}
        <ul className="exp-hl-list">
          {planChange.highlights.map((h, i) => <li key={i}>{ts(h)}</li>)}
        </ul>
        <button type="button" className="btn primary block" disabled={busy} onClick={dismiss} data-testid="upgrade-continue">
          {t('exp.upgrade.continue')}
        </button>
      </div>
    </div>
  );
}

/** Calm, zero-guilt downgrade summary (shown once). Data is never deleted. */
export function DowngradeSummary({
  planChange,
  onDone,
  onViewPlans,
}: {
  planChange: ExperiencePlanChange;
  onDone: () => void;
  onViewPlans: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    await api(`/experience/plan-change/${planChange.id}/seen`, { body: {} }).catch(() => undefined);
    onDone();
  };
  return (
    <section className="card exp-card" role="region" aria-label={t('exp.downgrade.title', { plan: planChange.toPlanName })} data-testid="downgrade-summary">
      <b>{t('exp.downgrade.title', { plan: planChange.toPlanName })}</b>
      <p className="small muted">{t('exp.downgrade.safe')}</p>
      {planChange.pausedAgents.length > 0 && (
        <p className="small">{t('exp.downgrade.paused_agents', { plan: planChange.toPlanName, agents: planChange.pausedAgents.map((a) => t(`agent.${a}.name`)).join(', ') })}</p>
      )}
      {planChange.themeReset && (
        <p className="small muted">{t('exp.downgrade.theme_reset', { plan: planChange.toPlanName })}</p>
      )}
      <div className="row">
        <button type="button" className="btn primary small" disabled={busy} onClick={dismiss} data-testid="downgrade-dismiss">{t('exp.downgrade.got_it')}</button>
        <button type="button" className="btn small" onClick={async () => { await dismiss(); onViewPlans(); }}>{t('exp.downgrade.reupgrade')}</button>
      </div>
    </section>
  );
}

/** "What's new for you" 7-day checklist card on The Bridge after an upgrade. */
export function WhatsNewCard({
  planChange,
  onAction,
  onReload,
}: {
  planChange: ExperiencePlanChange;
  onAction: (action: 'details' | 'crew' | 'story' | 'report' | 'wins') => void;
  onReload: () => void;
}) {
  const { t, ts } = useI18n();
  const [justTicked, setJustTicked] = useState<string | null>(null);
  if (planChange.direction !== 'up' || !planChange.checklist.length) return null;
  const doneCount = planChange.checklist.filter((c) => c.done).length;
  const clickItem = async (item: ExperiencePlanChange['checklist'][number]) => {
    if (!item.done) {
      setJustTicked(item.key);
      await api(`/experience/plan-change/${planChange.id}/tick`, { body: { item: item.key } }).catch(() => undefined);
      onReload();
    }
    onAction(item.action);
  };
  return (
    <section className="card exp-card" data-testid="whats-new-card">
      <div className="row between">
        <b>{t('exp.whatsnew.title', { plan: planChange.toPlanName })}</b>
        <span className="small muted">
          {doneCount === planChange.checklist.length
            ? t('exp.whatsnew.all_done')
            : t('exp.whatsnew.progress', { done: doneCount, total: planChange.checklist.length })}
        </span>
      </div>
      <ul className="exp-check-list">
        {planChange.checklist.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              className={`exp-check-btn ${item.done || justTicked === item.key ? 'done' : ''}`}
              onClick={() => clickItem(item)}
              data-testid={`whats-new-${item.key}`}
            >
              <span className="exp-check-box" aria-hidden>{item.done || justTicked === item.key ? '✓' : ''}</span>
              <span className="grow">{ts(item.label)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
