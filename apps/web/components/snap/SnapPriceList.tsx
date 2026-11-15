'use client';

import { useEffect, useRef, useState } from 'react';
import { api, apiUpload, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { preparePhotos } from '@/lib/photos';
import './snap.css';

interface Draft {
  ref: string;
  name: string;
  nameEn: string | null;
  category: string | null;
  price: number | null;
  priceType: 'fixed' | 'from' | 'range' | 'per_hour';
  priceMax: number | null;
  priceText: string | null;
  durationMin: number;
  durationSuggested: boolean;
  check: string[];
  variantOf: string | null;
  duplicate: { id: string; name: string; price: number | null } | null;
}
type Row = Draft & { keep: boolean; dupAction: 'update' | 'add' | 'skip' };
type Stage = { s: 'pick' } | { s: 'reading'; preview: string | null } | { s: 'review'; snapId: string; rows: Row[] } | { s: 'problem'; problem: string } | { s: 'done'; count: number };

/** Photo inputs: camera on phones ("Snap"), files elsewhere ("Upload photo or PDF"). */
export function PhotoButtons({ onFiles, snapLabel, uploadLabel, busy }: { onFiles: (f: File[]) => void; snapLabel: string; uploadLabel: string; busy?: boolean }) {
  const cam = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (f.length) onFiles(f);
  };
  return (
    <div className="snap-buttons">
      <button type="button" className="btn primary snap-big" disabled={busy} onClick={() => cam.current?.click()} data-testid="snap-camera">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.6" /></svg>
        {snapLabel}
      </button>
      <button type="button" className="link-btn" disabled={busy} onClick={() => file.current?.click()}>{uploadLabel}</button>
      <input ref={cam} type="file" accept="image/*" capture="environment" multiple hidden onChange={pick} data-testid="snap-input-camera" />
      <input ref={file} type="file" accept="image/*,application/pdf" multiple hidden onChange={pick} data-testid="snap-input-file" />
    </div>
  );
}

/** Scanning animation: the photo with a light moving down it. */
export function Scanning({ preview, label }: { preview: string | null; label: string }) {
  return (
    <div className="snap-scan" role="status" aria-live="polite" data-testid="snap-scanning">
      <div className="snap-photo">
        {preview ? <img src={preview} alt="" /> : <div className="snap-photo-blank" />}
        <i className="snap-line" aria-hidden />
      </div>
      <p>{label}</p>
    </div>
  );
}

/**
 * "Snap your price list": photos in, a checked list of services out. Nothing is
 * saved until the owner taps Add.
 */
export function SnapPriceList({ onDone, onCancel, currency = 'INR' }: { onDone: (count: number) => void; onCancel?: () => void; currency?: string }) {
  const { t, money } = useI18n();
  const [stage, setStage] = useState<Stage>({ s: 'pick' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(0);

  // The count ticks up after adding ("14 services added").
  useEffect(() => {
    if (stage.s !== 'done') return;
    setShown(0);
    const id = setInterval(() => setShown((n) => (n >= stage.count ? (clearInterval(id), n) : n + 1)), Math.max(30, 600 / Math.max(1, stage.count)));
    return () => clearInterval(id);
  }, [stage]);

  async function read(files: File[]) {
    setError(null);
    const preview = files[0]?.type.startsWith('image/') ? URL.createObjectURL(files[0]) : null;
    setStage({ s: 'reading', preview });
    try {
      const blobs = await preparePhotos(files);
      if (!blobs.length) throw new ApiError(400, 'photos', t('snap.only_photos'));
      const { ids } = await apiUpload<{ ids: string[] }>('/files?purpose=price_list', blobs);
      const r = await api<{ id: string; problem: string | null; result?: { services: Draft[] } }>('/snap', { body: { kind: 'price_list', fileIds: ids } });
      if (r.problem || !r.result) return setStage({ s: 'problem', problem: r.problem ?? 'unreadable' });
      setStage({ s: 'review', snapId: r.id, rows: r.result.services.map((d) => ({ ...d, keep: true, dupAction: !d.duplicate ? 'add' : d.duplicate.price === d.price ? 'skip' : 'update' })) });
    } catch (e) {
      setError((e as ApiError).message);
      setStage({ s: 'pick' });
    } finally {
      if (preview) setTimeout(() => URL.revokeObjectURL(preview), 30_000);
    }
  }

  async function add(onlySelected: boolean) {
    if (stage.s !== 'review') return;
    setBusy(true);
    setError(null);
    try {
      const items = stage.rows.map((r) => ({
        name: r.name, nameEn: r.nameEn, category: r.category, price: r.price, priceType: r.priceType, priceMax: r.priceType === 'range' ? r.priceMax : null, durationMin: r.durationMin,
        action: onlySelected && !r.keep ? 'skip' : r.duplicate ? r.dupAction : 'add',
        ...(r.duplicate && r.dupAction === 'update' ? { updateId: r.duplicate.id } : {}),
      }));
      const res = await api<{ added: number; updated: number }>(`/snap/${stage.snapId}/services`, { body: { items } });
      setStage({ s: 'done', count: res.added + res.updated });
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  const set = (ref: string, patch: Partial<Row>) => stage.s === 'review' && setStage({ ...stage, rows: stage.rows.map((r) => (r.ref === ref ? { ...r, ...patch } : r)) });

  return (
    <section className="snap card stack" data-testid="snap-price-list">
      {stage.s === 'pick' && (
        <>
          <div>
            <h3 style={{ margin: 0 }}>{t('snap.title')}</h3>
            <p className="muted small" style={{ margin: '4px 0 0' }}>{t('snap.sub')}</p>
          </div>
          <PhotoButtons onFiles={read} snapLabel={t('snap.snap')} uploadLabel={t('snap.upload')} />
          {onCancel && <button className="link-btn small" onClick={onCancel}>{t('snap.type_instead')}</button>}
        </>
      )}
      {stage.s === 'reading' && <Scanning preview={stage.preview} label={t('snap.reading')} />}
      {stage.s === 'problem' && (
        <div className="stack" role="alert">
          <p><b>{t(`snap.problem.${stage.problem}`)}</b></p>
          {stage.problem === 'unreadable' && <p className="small muted">{t('snap.tips')}</p>}
          <PhotoButtons onFiles={read} snapLabel={t('snap.retake')} uploadLabel={t('snap.upload')} />
          {onCancel && <button className="link-btn small" onClick={onCancel}>{t('snap.type_instead')}</button>}
        </div>
      )}
      {stage.s === 'review' && (
        <>
          <div className="row between">
            <h3 style={{ margin: 0 }}>{t('snap.found', { count: stage.rows.length })}</h3>
            <button className="link-btn small" onClick={() => setStage({ s: 'pick' })}>{t('snap.retake')}</button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>{t('snap.review_sub')}</p>
          <ul className="snap-rows">
            {stage.rows.map((r) => (
              <li key={r.ref} className={`snap-row ${r.keep ? '' : 'off'}`} data-testid="snap-row">
                <label className="snap-keep"><input type="checkbox" checked={r.keep} onChange={(e) => set(r.ref, { keep: e.target.checked })} aria-label={t('snap.keep', { name: r.name })} /></label>
                <div className="snap-fields">
                  <input className={`input ${r.check.includes('name') ? 'check' : ''}`} value={r.name} onChange={(e) => set(r.ref, { name: e.target.value })} aria-label={t('snap.name')} />
                  {r.nameEn !== null && <input className="input small-input" value={r.nameEn ?? ''} placeholder={t('snap.name_en')} onChange={(e) => set(r.ref, { nameEn: e.target.value || null })} aria-label={t('snap.name_en')} />}
                  <div className="snap-line2">
                    <label className={`snap-price ${r.check.includes('price') ? 'check' : ''}`}>
                      <span>{r.priceType === 'from' ? t('snap.from') : '₹'}</span>
                      <input className="input" inputMode="decimal" value={r.price ?? ''} onChange={(e) => set(r.ref, { price: e.target.value === '' ? null : Number(e.target.value.replace(/[^\d.]/g, '')) })} aria-label={t('snap.price')} />
                      {r.priceType === 'range' && <><span>–</span><input className="input" inputMode="decimal" value={r.priceMax ?? ''} onChange={(e) => set(r.ref, { priceMax: e.target.value === '' ? null : Number(e.target.value.replace(/[^\d.]/g, '')) })} aria-label={t('snap.price_max')} /></>}
                      {r.priceType === 'per_hour' && <span>{t('snap.per_hour')}</span>}
                    </label>
                    <label className="snap-mins">
                      <input className="input" inputMode="numeric" value={r.durationMin} onChange={(e) => set(r.ref, { durationMin: Number(e.target.value.replace(/\D/g, '')) || 0, durationSuggested: false })} aria-label={t('snap.minutes')} />
                      <span>{t('snap.min')}</span>
                      {r.durationSuggested && <em>{t('snap.suggested')}</em>}
                    </label>
                  </div>
                  {r.check.length > 0 && <span className="snap-check">{t('snap.please_check')}{r.priceText ? ` · “${r.priceText}”` : ''}</span>}
                  {r.duplicate && (
                    <div className="snap-dup" role="group" aria-label={t('snap.dup_q')}>
                      <span>{r.duplicate.price === r.price
                        ? t('snap.dup_same', { name: r.duplicate.name, price: r.price == null ? '—' : money(r.price, currency) })
                        : t('snap.dup', { name: r.duplicate.name, old: r.duplicate.price == null ? '—' : money(r.duplicate.price, currency), now: r.price == null ? '—' : money(r.price, currency) })}</span>
                      {(['update', 'add', 'skip'] as const).map((a) => (
                        <button key={a} type="button" className="chip" aria-pressed={r.dupAction === a} onClick={() => set(r.ref, { dupAction: a })}>{t(`snap.dup.${a}`)}</button>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="snap-actions">
            <button className="btn primary" disabled={busy || !stage.rows.length} onClick={() => add(false)} data-testid="snap-add-all">{t('snap.add_all')}</button>
            <button className="btn" disabled={busy || !stage.rows.some((r) => r.keep)} onClick={() => add(true)}>{t('snap.add_selected', { count: stage.rows.filter((r) => r.keep).length })}</button>
          </div>
        </>
      )}
      {stage.s === 'done' && (
        <div className="snap-done pop" role="status" data-testid="snap-done">
          <div className="snap-stack" aria-hidden><i /><i /><i /></div>
          <b>{t('snap.added', { count: shown })}</b>
          <button className="btn primary" onClick={() => onDone(stage.count)}>{t('common.continue')}</button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
