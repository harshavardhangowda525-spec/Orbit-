'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface Report {
  business: { name: string; gstin: string | null };
  currency: string;
  books: { month: string; revenue: { online: number; counter: number; cash: number; total: number }; expenses: { total: number; byCategory: { category: string; amount: number; count: number }[] }; profit: number; gst: { paidOnBills: number; collected: number } };
  expenses: { id: string; vendor: string; gstin: string | null; billNumber: string | null; billDate: string; category: string; subtotal: number | null; tax: Record<string, number>; total: number }[];
  sales: { date: string; mode: string; amount: number; note: string | null }[];
}

export default function ReportPage() {
  return (
    <Suspense fallback={null}>
      <MonthReport />
    </Suspense>
  );
}

/** The month's books on one page, ready to print or save as PDF for the accountant. */
function MonthReport() {
  const { t, money, lang } = useI18n();
  const month = useSearchParams().get('month') ?? undefined;
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Report>(`/khata/report${month ? `?month=${month}` : ''}`).then(setR).catch((e) => setError((e as ApiError).message));
  }, [month]);
  if (error) return <main className="report"><p className="error">{error}</p></main>;
  if (!r) return <main className="report"><p className="muted">{t('common.loading')}</p></main>;
  const m = (n: number) => money(n, r.currency);
  const name = new Intl.DateTimeFormat(lang === 'en' ? 'en-IN' : `${lang}-IN`, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${r.books.month}-15T00:00:00Z`));
  return (
    <main className="report" data-testid="books-report">
      <style>{`
        .report { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; background: #fff; color: #1c1a3a; font-size: 14px; }
        .report h1 { font-size: 24px; margin: 0 0 4px; } .report h2 { font-size: 16px; margin: 24px 0 8px; }
        .report table { width: 100%; border-collapse: collapse; } .report th, .report td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e2f2; vertical-align: top; }
        .report td.n, .report th.n { text-align: right; font-variant-numeric: tabular-nums; } .report .tot td { font-weight: 800; }
        .report .note { color: #625e80; font-size: 12px; } .report .actions { margin: 12px 0; }
        @media print { .report .actions { display: none; } .report { padding: 0; } }
      `}</style>
      <h1>{r.business.name} — {name}</h1>
      {r.business.gstin && <div className="note">GSTIN {r.business.gstin}</div>}
      <p className="note">{t('khata.note.based_on')} {t('khata.not_advice')}</p>
      <div className="actions"><button className="btn primary" onClick={() => window.print()}>{t('khata.print')}</button></div>
      <h2>{t('khata.summary')}</h2>
      <table><tbody>
        <tr><td>{t('khata.src.online')}</td><td className="n">{m(r.books.revenue.online)}</td></tr>
        <tr><td>{t('khata.src.counter')}</td><td className="n">{m(r.books.revenue.counter)}</td></tr>
        <tr><td>{t('khata.src.cash')}</td><td className="n">{m(r.books.revenue.cash)}</td></tr>
        <tr className="tot"><td>{t('khata.revenue')}</td><td className="n">{m(r.books.revenue.total)}</td></tr>
        {r.books.expenses.byCategory.map((c) => <tr key={c.category}><td>{t(`khata.cat.${c.category}`)} ({c.count})</td><td className="n">{m(c.amount)}</td></tr>)}
        <tr className="tot"><td>{t('khata.expenses')}</td><td className="n">{m(r.books.expenses.total)}</td></tr>
        <tr className="tot"><td>{t('khata.profit')}</td><td className="n">{m(r.books.profit)}</td></tr>
        <tr><td>{t('khata.gst.paid')}</td><td className="n">{m(r.books.gst.paidOnBills)}</td></tr>
        <tr><td>{t('khata.gst.collected')}</td><td className="n">{m(r.books.gst.collected)}</td></tr>
      </tbody></table>
      <p className="note">{t('khata.gst.verify')}</p>
      <h2>{t('khata.bills', { count: r.expenses.length })}</h2>
      <table>
        <thead><tr><th>{t('khata.bill.date')}</th><th>{t('khata.bill.vendor')}</th><th>GSTIN</th><th>{t('khata.bill.number')}</th><th>{t('khata.bill.category')}</th><th className="n">GST</th><th className="n">{t('khata.bill.amount')}</th></tr></thead>
        <tbody>
          {r.expenses.map((e) => (
            <tr key={e.id}><td>{e.billDate}</td><td>{e.vendor}</td><td>{e.gstin ?? ''}</td><td>{e.billNumber ?? ''}</td><td>{t(`khata.cat.${e.category}`)}</td>
              <td className="n">{m(Object.values(e.tax ?? {}).reduce((s, v) => s + Number(v || 0), 0))}</td><td className="n">{m(e.total)}</td></tr>
          ))}
        </tbody>
      </table>
      <h2>{t('khata.sales_logged')}</h2>
      <table>
        <tbody>{r.sales.map((s, i) => <tr key={i}><td>{s.date}</td><td>{t(`khata.mode.${s.mode}`)}</td><td>{s.note ?? ''}</td><td className="n">{m(s.amount)}</td></tr>)}</tbody>
      </table>
    </main>
  );
}
