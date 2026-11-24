'use client';

import { useState } from 'react';
import { AVATAR_STYLES, FESTIVALS, THEMES, planFor, type AvatarStyle, type FestivalKey, type ThemeKey } from '@orbit/shared';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { ExperienceData } from '@/lib/bridge-types';
import { FeatureLockSheet } from './FeatureLockSheet';

const BRAND_SWATCHES = ['#D97706', '#E11D48', '#0D9488', '#2563EB', '#7C3AED', '#059669'];

/** Appearance & themes settings panel (Details view). Undoable for 24 hours. */
export function AppearancePanel({
  experience,
  onChanged,
  onUpgrade,
}: {
  experience: ExperienceData;
  onChanged: () => void;
  onUpgrade: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lockedFeature, setLockedFeature] = useState<string | null>(null);
  const exp = experience.plan.experience;
  const app = experience.appearance;
  const hasBrand = exp.perks.includes('brandColor');
  const hasAvatars = exp.perks.includes('avatarStyles');

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await api('/experience/appearance', { method: 'PATCH', body });
      setSaved(true);
      onChanged();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleFestival = (f: FestivalKey) => {
    const next = app.festivals.includes(f) ? app.festivals.filter((x) => x !== f) : [...app.festivals, f];
    patch({ festivals: next });
  };

  return (
    <section className="card stack" data-testid="appearance-panel">
      <div>
        <h3 style={{ margin: 0 }}>{t('exp.appearance.title')}</h3>
        <p className="muted small" style={{ margin: '4px 0 0' }}>{t('exp.appearance.sub')}</p>
      </div>

      {/* Themes */}
      <div className="stack" style={{ gap: 8 }}>
        <span className="label" style={{ color: 'var(--muted)' }}>{t('exp.appearance.themes')}</span>
        <div className="theme-grid">
          {THEMES.map((th: ThemeKey) => {
            const allowed = exp.themes.includes(th);
            const active = app.effectiveTheme === th;
            const req = !allowed ? planFor(experience.allPlans, th) : null;
            const isPaid = th !== 'space' && th !== 'light';
            return (
              <button
                key={th}
                type="button"
                className={`theme-swatch ${active ? 'sel' : ''}`}
                disabled={busy}
                data-testid={`theme-${th}`}
                data-locked={allowed ? 'false' : 'true'}
                onClick={() => (allowed ? patch({ theme: th }) : setLockedFeature(th))}
              >
                <span className={`preview swatch-${th}`} aria-hidden />
                <b className="small">{t(`exp.theme.${th}`)}</b>
                {!allowed && req && <span className="lock-pill">🔒 {req.name}</span>}
                {allowed && isPaid && <span className="included-pill">{t('exp.included')}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Festivals for Festive theme */}
      {exp.themes.includes('festive') && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="label" style={{ color: 'var(--muted)' }}>{t('exp.festivals.title')}</span>
          <p className="small muted" style={{ margin: 0 }}>{t('exp.festivals.hint')}</p>
          <div className="fest-chips">
            {FESTIVALS.map((f) => {
              const on = app.festivals.includes(f);
              return (
                <button
                  key={f}
                  type="button"
                  className={`fest-chip ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  disabled={busy}
                  onClick={() => toggleFestival(f)}
                  data-testid={`festival-${f}`}
                >
                  {t(`exp.festival.${f}`)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Crew avatar style (Pro+) */}
      <div className="stack" style={{ gap: 6 }}>
        <div className="row between">
          <span className="label" style={{ color: 'var(--muted)' }}>{t('exp.avatars.title')}</span>
          {hasAvatars ? (
            <span className="included-pill">{t('exp.included')}</span>
          ) : (
            <span className="lock-pill">🔒 {planFor(experience.allPlans, 'avatarStyles')?.name ?? 'Pro'}</span>
          )}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {AVATAR_STYLES.map((st: AvatarStyle) => {
            const locked = st !== 'initials' && !hasAvatars;
            const active = app.effectiveAvatar === st;
            return (
              <button
                key={st}
                type="button"
                className={`btn small ${active ? 'primary' : ''}`}
                disabled={busy}
                data-testid={`avatar-${st}`}
                onClick={() => (locked ? setLockedFeature('avatarStyles') : patch({ avatarStyle: st }))}
              >
                {locked ? '🔒 ' : ''}{t(`exp.avatar.${st}`)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Custom brand colour (Business+) */}
      <div className="stack" style={{ gap: 6 }}>
        <div className="row between">
          <span className="label" style={{ color: 'var(--muted)' }}>{t('exp.brand.title')}</span>
          {hasBrand ? (
            <span className="included-pill">{t('exp.included')}</span>
          ) : (
            <span className="lock-pill">🔒 {planFor(experience.allPlans, 'brandColor')?.name ?? 'Business'}</span>
          )}
        </div>
        <p className="small muted" style={{ margin: 0 }}>{t('exp.brand.hint')}</p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {BRAND_SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              aria-label={hex}
              disabled={busy}
              data-testid={`brand-color-${hex.slice(1)}`}
              onClick={() => (hasBrand ? patch({ brandColor: hex, theme: 'brand' }) : setLockedFeature('brandColor'))}
              style={{
                width: 34, height: 34, borderRadius: 999, background: hex, cursor: 'pointer',
                border: app.brandColor === hex ? '3px solid #fff' : '2px solid rgba(255,255,255,0.25)',
              }}
            />
          ))}
        </div>
      </div>

      {saved && <p className="small" style={{ color: '#5ee0b5', margin: 0 }}>{t('exp.appearance.saved')}</p>}
      {err && <p className="error small" style={{ margin: 0 }}>{err}</p>}

      {lockedFeature && (
        <FeatureLockSheet feature={lockedFeature} onClose={() => setLockedFeature(null)} onUpgrade={onUpgrade} />
      )}
    </section>
  );
}
