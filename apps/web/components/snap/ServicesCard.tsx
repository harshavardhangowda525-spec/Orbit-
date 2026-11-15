'use client';

import { useCallback, useEffect, useState } from 'react';
import { WEEKDAYS, type WeeklyHours } from '@orbit/shared';
import { api, apiUpload, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { preparePhotos } from '@/lib/photos';
import { PhotoButtons, Scanning, SnapPriceList } from './SnapPriceList';
import './snap.css';

interface Service { id: string; name: string; nameEn: string | null; price: number | null; priceType: string; priceMax: number | null; durationMin: number }

/** Details → Services: the list, and Snap to add from a photo of the price board. */
export function ServicesCard() {
  const { t, money } = useI18n();
  const [list, setList] = useState<Service[] | null>(null);
  const [mode, setMode] = useState<'list' | 'snap' | 'details'>('list');
  const load = useCallback(() => api<Service[]>('/snap/services').then(setList).catch(() => setList([])), []);
  useEffect(() => void load(), [load]);
  const price = (s: Service) =>
    s.price == null ? t('snap.on_request') : s.priceType === 'range' && s.priceMax ? `${money(s.price)} – ${money(s.priceMax)}` : s.priceType === 'from' ? `${t('snap.from')} ${money(s.price)}` : s.priceType === 'per_hour' ? `${money(s.price)} ${t('snap.per_hour')}` : money(s.price);

  return (
    <section className="stack" data-testid="services-card">
      <div className="row between"><h2 style={{ margin: 0 }}>{t('snap.services')}</h2></div>
      {mode === 'snap' ? (
        <SnapPriceList onDone={() => { setMode('list'); load(); }} onCancel={() => setMode('list')} />
      ) : mode === 'details' ? (
        <SnapDetails onDone={() => setMode('list')} />
      ) : (
        <>
          <button className="btn snap-cta block" onClick={() => setMode('snap')} data-testid="details-snap">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.6" /></svg>
            <span><b>{t('snap.snap')}</b><small>{t('snap.cta_sub')}</small></span>
          </button>
          <div className="card">
            {list && list.length === 0 && <p className="muted">{t('snap.no_services')}</p>}
            {list?.map((s) => (
              <div key={s.id} className="list-item">
                <div className="grow">
                  <b>{s.name}</b>
                  {s.nameEn && <div className="small muted">{s.nameEn}</div>}
                </div>
                <span className="small muted">{t('snap.minutes_n', { count: s.durationMin })}</span>
                <b style={{ minWidth: 90, textAlign: 'right' }}>{price(s)}</b>
              </div>
            ))}
          </div>
          <button className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setMode('details')}>{t('snap.card_cta')}</button>
        </>
      )}
    </section>
  );
}

type Found = { name?: string | null; phone?: string | null; address?: string | null; hours?: WeeklyHours | null };

/** A business card, signboard or hours board: tick what to keep. */
export function SnapDetails({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ s: 'pick' } | { s: 'reading'; preview: string | null } | { s: 'review'; id: string; found: Found } | { s: 'problem'; problem: string }>({ s: 'pick' });
  const [keep, setKeep] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  async function read(files: File[], kind: 'card' | 'hours') {
    setError(null);
    const preview = files[0]?.type.startsWith('image/') ? URL.createObjectURL(files[0]) : null;
    setState({ s: 'reading', preview });
    try {
      const { ids } = await apiUpload<{ ids: string[] }>(`/files?purpose=${kind}`, await preparePhotos(files));
      const r = await api<{ id: string; problem: string | null; result?: Found }>('/snap', { body: { kind, fileIds: ids } });
      if (r.problem || !r.result) return setState({ s: 'problem', problem: r.problem ?? 'unreadable' });
      setKeep(Object.fromEntries(Object.entries(r.result).filter(([k, v]) => v && k !== 'confidence').map(([k]) => [k, true])));
      setState({ s: 'review', id: r.id, found: r.result });
    } catch (e) {
      setError((e as ApiError).message);
      setState({ s: 'pick' });
    }
  }
  async function save() {
    if (state.s !== 'review') return;
    const f = state.found;
    try {
      await api(`/snap/${state.id}/details`, { body: Object.fromEntries((['name', 'phone', 'address', 'hours'] as const).filter((k) => keep[k] && f[k]).map((k) => [k, f[k]])) });
      onDone();
    } catch (e) {
      setError((e as ApiError).message);
    }
  }

  return (
    <section className="snap card stack" data-testid="snap-details">
      {state.s === 'pick' && (
        <>
          <h3 style={{ margin: 0 }}>{t('snap.card_title')}</h3>
          <p className="muted small" style={{ margin: 0 }}>{t('snap.card_sub')}</p>
          <PhotoButtons onFiles={(f) => read(f, 'card')} snapLabel={t('snap.card_snap')} uploadLabel={t('snap.upload')} />
          <PhotoButtons onFiles={(f) => read(f, 'hours')} snapLabel={t('snap.hours_snap')} uploadLabel={t('snap.upload')} />
          <button className="link-btn small" onClick={onDone}>{t('common.cancel')}</button>
        </>
      )}
      {state.s === 'reading' && <Scanning preview={state.preview} label={t('snap.reading_details')} />}
      {state.s === 'problem' && (
        <>
          <p role="alert"><b>{t(`snap.problem.${state.problem}`)}</b></p>
          <p className="small muted">{t('snap.tips')}</p>
          <button className="btn" onClick={() => setState({ s: 'pick' })}>{t('snap.retake')}</button>
        </>
      )}
      {state.s === 'review' && (
        <>
          <h3 style={{ margin: 0 }}>{t('snap.details_found')}</h3>
          {(['name', 'phone', 'address'] as const).filter((k) => state.found[k]).map((k) => (
            <label key={k} className="check-line">
              <input type="checkbox" checked={!!keep[k]} onChange={(e) => setKeep({ ...keep, [k]: e.target.checked })} />
              <span><small className="muted">{t(`snap.field.${k}`)}</small><br />{state.found[k]}</span>
            </label>
          ))}
          {state.found.hours && (
            <label className="check-line">
              <input type="checkbox" checked={!!keep.hours} onChange={(e) => setKeep({ ...keep, hours: e.target.checked })} />
              <span>
                <small className="muted">{t('snap.field.hours')}</small>
                {WEEKDAYS.map((d) => <span key={d} className="small" style={{ display: 'block' }}>{t(`weekday.${d}`)}: {state.found.hours![d].open ? state.found.hours![d].ranges.map((r) => `${r.from}–${r.to}`).join(', ') : t('common.closed')}</span>)}
              </span>
            </label>
          )}
          <div className="snap-actions">
            <button className="btn primary" onClick={save} disabled={!Object.values(keep).some(Boolean)}>{t('snap.save_details')}</button>
            <button className="btn" onClick={onDone}>{t('common.cancel')}</button>
          </div>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
