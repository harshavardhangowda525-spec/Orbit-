'use client';

import { useState } from 'react';
import { EXPENSE_CATEGORIES } from '@orbit/shared';
import { api, apiUpload, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { preparePhotos } from '@/lib/photos';
import { PhotoButtons, Scanning } from '@/components/snap/SnapPriceList';
import '@/components/snap/snap.css';
import './khata.css';

interface Draft {
  vendorName: string; gstin: string | null; billNumber: string | null; billDate: string; category: string; categorySource: 'vendor' | 'guess';
  subtotal: number | null; tax: { cgst: number | null; sgst: number | null; igst: number | null; cess: number | null }; total: number;
  paymentMode: string | null; items: any[]; check: string[]; vendor: { id: string; name: string; autoSave: boolean; confirmedBills: number } | null;
}
interface ReadResult { snapId: string; problem: string | null; draft?: Draft; duplicate?: { vendorName: string; billNumber: string | null; billDate: string; total: number } | null; saved?: { id: string; versionId: string } }
type Stage = { s: 'pick' } | { s: 'reading'; preview: string | null } | { s: 'review'; r: ReadResult; d: Draft; auto: boolean } | { s: 'problem'; problem: string } | { s: 'saved'; versionId: string | null; auto: boolean; amount: number; billDate: string };

const today = () => new Date().toISOString().slice(0, 10);
const blank = (): Draft => ({ vendorName: '', gstin: null, billNumber: null, billDate: today(), category: 'other', categorySource: 'guess', subtotal: null, tax: { cgst: null, sgst: null, igst: null, cess: null }, total: 0, paymentMode: null, items: [], check: [], vendor: null });

/**
 * Snap a bill: Khata reads it, suggests a category (learned per vendor), and
 * shows one review card. Nothing is saved until Save (unless the owner set
 * auto-save for that vendor). Saved bills can be undone for 24 hours.
 */
export function ScanBill({ onDone, manual = false, currency = 'INR' }: { onDone: (savedMonth?: string) => void; manual?: boolean; currency?: string }) {
  const { t, money } = useI18n();
  const [stage, setStage] = useState<Stage>(manual ? { s: 'review', r: { snapId: '', problem: null }, d: blank(), auto: false } : { s: 'pick' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dup, setDup] = useState<ReadResult['duplicate']>(null);

  async function read(files: File[]) {
    setError(null);
    const preview = files[0]?.type.startsWith('image/') ? URL.createObjectURL(files[0]) : null;
    setStage({ s: 'reading', preview });
    try {
      const { ids } = await apiUpload<{ ids: string[] }>('/files?purpose=bill', await preparePhotos(files));
      const r = await api<ReadResult>('/khata/bills/read', { body: { fileIds: ids } });
      if (r.saved) return setStage({ s: 'saved', versionId: r.saved.versionId, auto: true, amount: r.draft!.total, billDate: r.draft!.billDate });
      if (r.problem || !r.draft) return setStage({ s: 'problem', problem: r.problem ?? 'unreadable' });
      setDup(r.duplicate ?? null);
      setStage({ s: 'review', r, d: r.draft, auto: !!r.draft.vendor?.autoSave });
    } catch (e) {
      setError((e as ApiError).message);
      setStage({ s: 'pick' });
    }
  }

  async function save(allowDuplicate = false) {
    if (stage.s !== 'review') return;
    const d = stage.d;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ versionId: string }>('/khata/bills', {
        body: {
          snapId: stage.r.snapId || null, vendorName: d.vendorName, gstin: d.gstin, billNumber: d.billNumber, billDate: d.billDate, category: d.category,
          subtotal: d.subtotal, tax: d.tax, total: d.total, paymentMode: d.paymentMode, items: d.items, autoSaveVendor: stage.auto, allowDuplicate,
        },
      });
      setStage({ s: 'saved', versionId: res.versionId, auto: false, amount: d.total, billDate: d.billDate });
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'duplicate_bill') setDup(err.details?.duplicate ?? { vendorName: d.vendorName, billNumber: d.billNumber, billDate: d.billDate, total: d.total });
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function undo(versionId: string | null) {
    if (!versionId) return onDone();
    await api(`/trust/changes/${versionId}/undo`, { method: 'POST' }).catch(() => undefined);
    onDone();
  }

  const set = (patch: Partial<Draft>) => stage.s === 'review' && setStage({ ...stage, d: { ...stage.d, ...patch } });
  const chk = (f: string) => (stage.s === 'review' && stage.d.check.includes(f) ? 'check' : '');
  const num = (v: string) => (v === '' ? null : Number(v.replace(/[^\d.]/g, '')));

  return (
    <section className="khata-scan card stack" data-testid="scan-bill">
      {stage.s === 'pick' && (
        <>
          <h3 style={{ margin: 0 }}>{t('khata.scan.title')}</h3>
          <p className="muted small" style={{ margin: 0 }}>{t('khata.scan.sub')}</p>
          <PhotoButtons onFiles={read} snapLabel={t('khata.scan.snap')} uploadLabel={t('snap.upload')} />
          <button className="link-btn small" onClick={() => setStage({ s: 'review', r: { snapId: '', problem: null }, d: blank(), auto: false })}>{t('khata.scan.type')}</button>
        </>
      )}
      {stage.s === 'reading' && <Scanning preview={stage.preview} label={t('khata.scan.reading')} />}
      {stage.s === 'problem' && (
        <>
          <p role="alert"><b>{t(`snap.problem.${stage.problem}`)}</b></p>
          {stage.problem === 'unreadable' && <p className="small muted">{t('snap.tips')}</p>}
          <PhotoButtons onFiles={read} snapLabel={t('snap.retake')} uploadLabel={t('snap.upload')} />
          <button className="link-btn small" onClick={() => setStage({ s: 'review', r: { snapId: '', problem: null }, d: blank(), auto: false })}>{t('khata.scan.type')}</button>
        </>
      )}
      {stage.s === 'review' && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); save(false); }}>
          <div className="bill-hero">
            <label className={`bill-amount ${chk('total')}`}>
              <span>₹</span>
              <input className="input" inputMode="decimal" value={stage.d.total || ''} onChange={(e) => set({ total: num(e.target.value) ?? 0 })} aria-label={t('khata.bill.amount')} required data-testid="bill-total" />
            </label>
            <input className={`input bill-vendor ${chk('vendorName')}`} value={stage.d.vendorName} placeholder={t('khata.bill.vendor')} onChange={(e) => set({ vendorName: e.target.value })} aria-label={t('khata.bill.vendor')} required data-testid="bill-vendor" />
            <div className="bill-row">
              <input className={`input ${chk('billDate')}`} type="date" value={stage.d.billDate} onChange={(e) => set({ billDate: e.target.value })} aria-label={t('khata.bill.date')} required />
              <select className="input" value={stage.d.category} onChange={(e) => set({ category: e.target.value, categorySource: 'guess' })} aria-label={t('khata.bill.category')} data-testid="bill-category">
                {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`khata.cat.${c}`)}</option>)}
              </select>
            </div>
            {stage.d.categorySource === 'vendor' && <small className="muted">{t('khata.bill.learned', { vendor: stage.d.vendorName })}</small>}
            {stage.d.check.length > 0 && <span className="snap-check">{t('snap.please_check')}</span>}
          </div>
          <details className="bill-more">
            <summary>{t('khata.bill.more')}</summary>
            <div className="bill-grid">
              <label><span>{t('khata.bill.number')}</span><input className={`input ${chk('billNumber')}`} value={stage.d.billNumber ?? ''} onChange={(e) => set({ billNumber: e.target.value || null })} /></label>
              <label><span>GSTIN</span><input className={`input ${chk('gstin')}`} value={stage.d.gstin ?? ''} onChange={(e) => set({ gstin: e.target.value.toUpperCase() || null })} /></label>
              <label><span>{t('khata.bill.subtotal')}</span><input className="input" inputMode="decimal" value={stage.d.subtotal ?? ''} onChange={(e) => set({ subtotal: num(e.target.value) })} /></label>
              {(['cgst', 'sgst', 'igst', 'cess'] as const).map((k) => (
                <label key={k}><span>{k.toUpperCase()}</span><input className={`input ${chk('tax')}`} inputMode="decimal" value={stage.d.tax[k] ?? ''} onChange={(e) => set({ tax: { ...stage.d.tax, [k]: num(e.target.value) } })} /></label>
              ))}
            </div>
          </details>
          {stage.d.vendorName && (
            <label className="check-line">
              <input type="checkbox" checked={stage.auto} onChange={(e) => setStage({ ...stage, auto: e.target.checked })} />
              <span>{t('khata.bill.auto_save', { vendor: stage.d.vendorName })}</span>
            </label>
          )}
          {dup && (
            <div className="bill-dup" role="alert" data-testid="bill-duplicate">
              <b>{t('khata.bill.duplicate')}</b>
              <span className="small">{dup.vendorName}{dup.billNumber ? ` · ${dup.billNumber}` : ''} · {dup.billDate} · {money(dup.total, currency)}</span>
              <div className="snap-actions">
                <button type="button" className="btn" disabled={busy} onClick={() => save(true)}>{t('khata.bill.save_anyway')}</button>
                <button type="button" className="btn" onClick={() => onDone()}>{t('khata.bill.dont_save')}</button>
              </div>
            </div>
          )}
          {!dup && (
            <div className="snap-actions">
              <button className="btn primary" disabled={busy || !stage.d.vendorName || !(stage.d.total > 0)} data-testid="bill-save">{t('khata.bill.save')}</button>
              <button type="button" className="btn" onClick={() => onDone()}>{t('common.cancel')}</button>
            </div>
          )}
        </form>
      )}
      {stage.s === 'saved' && (
        <div className="snap-done pop" role="status" data-testid="bill-saved">
          <b>{stage.auto ? t('khata.bill.saved_auto', { amount: money(stage.amount, currency) }) : t('khata.bill.saved', { amount: money(stage.amount, currency) })}</b>
          {/* Say which month it is filed under when that is not this month (it then shows under that month in Books). */}
          {stage.billDate.slice(0, 7) !== today().slice(0, 7) && (
            <span className="snap-check" data-testid="bill-saved-month">{t('khata.bill.saved_month', { month: `~mo:${stage.billDate.slice(0, 7)}`, date: `~d:${stage.billDate}T12:00:00Z` })}</span>
          )}
          <div className="snap-actions">
            <button className="btn primary" onClick={() => onDone(stage.billDate.slice(0, 7))}>{t('common.continue')}</button>
            <button className="btn" onClick={() => undo(stage.versionId)}>{t('held.undo')}</button>
          </div>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

/** Add sale: cash, own UPI QR, card machine — or read a settlement screenshot. */
export function AddSale({ onDone, currency = 'INR' }: { onDone: () => void; currency?: string }) {
  const { t, money } = useI18n();
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<'cash' | 'upi' | 'card' | 'other'>('cash');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [fileId, setFileId] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ versionId: string; amount: number } | null>(null);

  async function readShot(files: File[]) {
    setReading(true);
    setError(null);
    try {
      const { ids } = await apiUpload<{ ids: string[] }>('/files?purpose=settlement', await preparePhotos(files));
      const r = await api<{ problem: string | null; total?: number; date?: string | null; mode?: 'upi' | 'card'; fileId?: string }>('/khata/settlement/read', { body: { fileIds: ids } });
      if (r.problem) setError(t(`snap.problem.${r.problem}`));
      else {
        setAmount(String(r.total ?? ''));
        if (r.date) setDate(r.date);
        if (r.mode) setMode(r.mode);
        setFileId(r.fileId ?? null);
      }
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setReading(false);
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ versionId: string; amount: number }>('/khata/sales', { body: { amount, mode, date, note: note || null, via: fileId ? 'settlement' : 'app', fileId } });
      setSaved({ versionId: r.versionId, amount: r.amount });
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  if (saved) {
    return (
      <section className="card stack snap-done pop" role="status" data-testid="sale-saved">
        <b>{t('khata.sale.saved', { amount: money(saved.amount, currency) })}</b>
        <div className="snap-actions">
          <button className="btn primary" onClick={onDone}>{t('common.continue')}</button>
          <button className="btn" onClick={async () => { await api(`/trust/changes/${saved.versionId}/undo`, { method: 'POST' }).catch(() => undefined); onDone(); }}>{t('held.undo')}</button>
        </div>
      </section>
    );
  }
  return (
    <form className="card stack khata-sale" onSubmit={save} data-testid="add-sale">
      <h3 style={{ margin: 0 }}>{t('khata.sale.title')}</h3>
      <label className="bill-amount"><span>₹</span><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="8,500" aria-label={t('khata.bill.amount')} required autoFocus data-testid="sale-amount" /></label>
      <div className="seg">
        {(['cash', 'upi', 'card', 'other'] as const).map((m) => <button key={m} type="button" className="chip" aria-pressed={mode === m} onClick={() => setMode(m)}>{t(`khata.mode.${m}`)}</button>)}
      </div>
      <div className="bill-row">
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t('khata.bill.date')} />
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('khata.sale.note')} aria-label={t('khata.sale.note')} />
      </div>
      {reading ? <Scanning preview={null} label={t('khata.sale.reading')} /> : <PhotoButtons onFiles={readShot} snapLabel={t('khata.sale.screenshot')} uploadLabel={t('snap.upload')} />}
      <div className="snap-actions">
        <button className="btn primary" disabled={!amount}>{t('khata.bill.save')}</button>
        <button type="button" className="btn" onClick={onDone}>{t('common.cancel')}</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}
