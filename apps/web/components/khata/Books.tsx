'use client';

import { useCallback, useEffect, useState } from 'react';
import { CATEGORY_COLORS, EXPENSE_CATEGORIES, type Sentence } from '@orbit/shared';
import { api, apiBlobUrl, apiDownload, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useCountUp } from '@/lib/motion';
import { openWhy } from '@/components/trust/WhySheet';
import { AddSale, ScanBill } from './ScanBill';
import './khata.css';

interface Summary {
  month: string; level: string; currency: string; note: Sentence;
  revenue: { online: number; counter: number; cash: number; total: number };
  expenses: { total: number; byCategory: { category: string; amount: number; count: number }[] };
  profit: number; last: { month: string; revenue: number; expenses: number; profit: number };
  compare: Sentence | null; insights: Sentence[]; upcoming: { id: string; vendor: string; category: string; amount: number; due: string }[];
  gst: { paidOnBills: number; collected: number; bills: number; label: Sentence } | null;
  today: { sales: number; spent: number }; bills: { used: number; limit: number | null }; locked: string[];
}
interface Expense { id: string; vendor: string; billNumber: string | null; billDate: string; category: string; total: number; fileIds: string[]; traceId: string | null }

const shift = (m: string, by: number) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + by, 15));
  return d.toISOString().slice(0, 7);
};

function Big({ label, value, currency, tone, animate }: { label: string; value: number; currency: string; tone: string; animate: boolean }) {
  const { money } = useI18n();
  const shown = useCountUp(value, animate);
  return (
    <div className={`books-big ${tone}`}>
      <span>{label}</span>
      <b data-testid={`books-${tone}`}>{money(Math.round(shown), currency)}</b>
    </div>
  );
}

function Bars({ rows, currency }: { rows: { key: string; label: string; amount: number; color: string }[]; currency: string }) {
  const { money } = useI18n();
  const max = Math.max(1, ...rows.map((r) => r.amount));
  return (
    <ul className="books-bars">
      {rows.map((r) => (
        <li key={r.key}>
          <span className="books-bar-label">{r.label}</span>
          <span className="books-bar-track"><i style={{ width: `${(r.amount / max) * 100}%`, background: r.color }} /></span>
          <b>{money(r.amount, currency)}</b>
        </li>
      ))}
    </ul>
  );
}

/**
 * Khata's books: this month's revenue, expenses and profit (with last month for
 * comparison), where the money came from and went, and the bills behind it.
 * Owners and managers see totals; staff can still add bills and sales.
 */
export function Books() {
  const { t, ts, money, lang } = useI18n();
  const [month, setMonth] = useState<string | null>(null);
  const [s, setS] = useState<Summary | null>(null);
  const [bills, setBills] = useState<Expense[]>([]);
  const [hidden, setHidden] = useState(false);
  const [panel, setPanel] = useState<'none' | 'scan' | 'type' | 'sale'>('none');
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const sum = await api<Summary>(`/khata/summary${month ? `?month=${month}` : ''}`);
      setS(sum);
      if (!month) setMonth(sum.month);
      setBills(await api<Expense[]>(`/khata/expenses?month=${sum.month}`));
      setHidden(false);
    } catch (e) {
      if ((e as ApiError).status === 403) setHidden(true);
      else setError((e as ApiError).message);
    }
  }, [month]);
  useEffect(() => void load(), [load]);

  const cur = s?.currency ?? 'INR';
  const monthName = (m: string) => new Intl.DateTimeFormat(lang === 'en' ? 'en-IN' : `${lang}-IN`, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-15T00:00:00Z`));
  const close = () => { setPanel('none'); load(); };

  const actions = (
    <div className="books-actions">
      <button className="btn primary" onClick={() => setPanel('scan')} data-testid="books-scan">{t('khata.scan.button')}</button>
      <button className="btn" onClick={() => setPanel('sale')} data-testid="books-sale">{t('khata.sale.button')}</button>
      <button className="btn ghost" onClick={() => setPanel('type')}>{t('khata.scan.type')}</button>
    </div>
  );

  return (
    <section className="stack books" data-testid="books">
      {actions}
      {panel === 'scan' && <ScanBill onDone={close} currency={cur} />}
      {panel === 'type' && <ScanBill onDone={close} manual currency={cur} />}
      {panel === 'sale' && <AddSale onDone={close} currency={cur} />}
      {hidden && <p className="note small">{t('khata.staff_note')}</p>}
      {error && <p className="error small">{error}</p>}

      {s && (
        <>
          <div className="row between books-month">
            <button className="icon-btn" aria-label={t('khata.prev')} onClick={() => setMonth(shift(s.month, -1))}>‹</button>
            <h2 style={{ margin: 0 }}>{monthName(s.month)}</h2>
            <button className="icon-btn" aria-label={t('khata.next')} onClick={() => setMonth(shift(s.month, 1))} disabled={s.month >= new Date().toISOString().slice(0, 7)}>›</button>
          </div>
          <div className="books-tiles">
            <Big label={t('khata.revenue')} value={s.revenue.total} currency={cur} tone="revenue" animate />
            <Big label={t('khata.expenses')} value={s.expenses.total} currency={cur} tone="expenses" animate />
            <Big label={t('khata.profit')} value={s.profit} currency={cur} tone="profit" animate />
          </div>
          {s.compare && <p className="books-compare">{ts(s.compare)}</p>}
          <p className="small muted" style={{ margin: 0 }}>{ts(s.note)}</p>

          <div className="books-cols">
            <div className="card stack">
              <b>{t('khata.revenue_by')}</b>
              <Bars currency={cur} rows={[
                { key: 'online', label: t('khata.src.online'), amount: s.revenue.online, color: '#a99bff' },
                { key: 'counter', label: t('khata.src.counter'), amount: s.revenue.counter, color: '#5ee0b5' },
                { key: 'cash', label: t('khata.src.cash'), amount: s.revenue.cash, color: '#ffc857' },
              ]} />
            </div>
            <div className="card stack">
              <b>{t('khata.expenses_by')}</b>
              {s.locked.includes('breakdown') ? (
                <p className="small muted">{t('khata.locked.breakdown')}</p>
              ) : s.expenses.byCategory.length === 0 ? (
                <p className="small muted">{t('khata.no_bills')}</p>
              ) : (
                <Bars currency={cur} rows={s.expenses.byCategory.map((c) => ({ key: c.category, label: t(`khata.cat.${c.category}`), amount: c.amount, color: CATEGORY_COLORS[c.category] ?? '#9aa0b4' }))} />
              )}
            </div>
          </div>

          {s.insights.length > 0 && (
            <div className="card stack" data-testid="books-insights">
              <b>{t('khata.insights')}</b>
              <ul className="books-list">{s.insights.map((x, i) => <li key={i}>{ts(x)}</li>)}</ul>
            </div>
          )}
          {s.upcoming.length > 0 && (
            <div className="card stack">
              <b>{t('khata.upcoming')}</b>
              <ul className="books-list">
                {s.upcoming.map((u) => <li key={u.id}>{t('khata.upcoming_line', { vendor: u.vendor, amount: money(u.amount, cur), date: new Date(`${u.due}T12:00:00Z`).toLocaleDateString(lang === 'en' ? 'en-IN' : `${lang}-IN`, { day: 'numeric', month: 'short' }) })}</li>)}
              </ul>
            </div>
          )}
          {s.gst && (
            <div className="card stack" data-testid="books-gst">
              <b>{t('khata.gst.title')}</b>
              <div className="books-gst">
                <span>{t('khata.gst.paid')}</span><b>{money(s.gst.paidOnBills, cur)}</b>
                <span>{t('khata.gst.collected')}</span><b>{money(s.gst.collected, cur)}</b>
              </div>
              <small className="muted">{ts(s.gst.label)}</small>
            </div>
          )}

          <div className="card stack">
            <div className="row between">
              <b>{t('khata.bills', { count: bills.length })}</b>
              {s.bills.limit != null && <span className="small muted">{t('khata.bills_used', { used: s.bills.used, limit: s.bills.limit })}</span>}
            </div>
            {bills.length === 0 && <p className="small muted">{t('khata.no_bills')}</p>}
            {bills.map((b) => (
              <div key={b.id} className="list-item bill-item">
                <span className="cat-dot" style={{ background: CATEGORY_COLORS[b.category] ?? '#9aa0b4' }} aria-hidden />
                <div className="grow">
                  <b>{b.vendor}</b>
                  <div className="small muted">
                    <select className="cat-select" value={b.category} aria-label={t('khata.bill.category')}
                      onChange={async (e) => { await api(`/khata/expenses/${b.id}`, { method: 'PATCH', body: { category: e.target.value } }); load(); }}>
                      {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`khata.cat.${c}`)}</option>)}
                    </select>
                    {' · '}{new Date(`${b.billDate}T12:00:00Z`).toLocaleDateString(lang === 'en' ? 'en-IN' : `${lang}-IN`, { day: 'numeric', month: 'short' })}{b.billNumber ? ` · ${b.billNumber}` : ''}
                  </div>
                </div>
                <b>{money(b.total, cur)}</b>
                {b.fileIds.length > 0 && <button className="link-btn small" onClick={async () => setPhoto(await apiBlobUrl(`/files/${b.fileIds[0]}`))}>{t('khata.view_bill')}</button>}
                <button className="why-link" onClick={() => openWhy(b.traceId)}>{t('why.link')}</button>
              </div>
            ))}
          </div>

          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {s.locked.includes('monthlyReport') ? <span className="small muted">{t('khata.locked.report')}</span> : <a className="btn small" href={`/books/report?month=${s.month}`} target="_blank" rel="noopener">{t('khata.report')}</a>}
            {!s.locked.includes('excelExport') && <button className="btn small" onClick={() => apiDownload(`/khata/report.xlsx?month=${s.month}`, `orbit-books-${s.month}.xlsx`, true).catch((e) => setError(e.message))}>{t('khata.excel')}</button>}
          </div>
          <p className="small muted">{t('khata.not_advice')}</p>
        </>
      )}
      {photo && (
        <div className="why-sheet" role="dialog" aria-modal="true" onClick={() => { URL.revokeObjectURL(photo); setPhoto(null); }}>
          <div className="why-card" style={{ textAlign: 'center' }}><img src={photo} alt={t('khata.view_bill')} style={{ maxWidth: '100%', maxHeight: '75vh', borderRadius: 12 }} /></div>
        </div>
      )}
    </section>
  );
}
