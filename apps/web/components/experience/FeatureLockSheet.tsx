'use client';

import { useEffect, useState } from 'react';
import type { Sentence } from '@orbit/shared';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface PreviewData {
  feature: string;
  plan: { code: string; name: string };
  headline: Sentence;
  body: Sentence;
}

/** Friendly real-data preview modal for a feature locked behind a higher plan. */
export function FeatureLockSheet({
  feature,
  onClose,
  onUpgrade,
}: {
  feature: string;
  onClose: () => void;
  onUpgrade: () => void;
}) {
  const { t, ts } = useI18n();
  const [prev, setPrev] = useState<PreviewData | null>(null);
  useEffect(() => {
    api<PreviewData>(`/experience/preview/${encodeURIComponent(feature)}`).then(setPrev).catch(() => undefined);
  }, [feature]);
  return (
    <div
      className="exp-modal"
      role="dialog"
      aria-modal="true"
      aria-label={prev ? ts(prev.headline) : t('exp.see_preview')}
      data-testid="feature-lock-sheet"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="exp-modal-card stack">
        <div className="row between">
          <span className="lock-pill">🔒 {prev?.plan.name ?? 'Pro'}</span>
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>×</button>
        </div>
        {!prev ? (
          <p className="muted">{t('common.loading')}</p>
        ) : (
          <>
            <h2>{ts(prev.headline)}</h2>
            <p className="muted">{ts(prev.body)}</p>
            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" className="btn primary" onClick={() => { onClose(); onUpgrade(); }} data-testid="lock-upgrade-btn">
                {t('exp.upgrade_to', { plan: prev.plan.name })}
              </button>
              <button type="button" className="btn" onClick={onClose}>{t('exp.lock.maybe_later')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
