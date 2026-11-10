'use client';

import './invoice.css';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { apiUrl } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/** The customer's invoice: GST details, print / save as PDF, and a Pay button while unpaid. */
export default function PublicInvoice() {
  const { token } = useParams<{ token: string }>();
  const { t, money, lang } = useI18n();
  const [inv, setInv] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`${apiUrl()}/public/invoices/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error?.message ?? t('chat.error'));
        setInv(d);
      })
      .catch((e) => setError(e.message));
  }, [token, t]);

  if (error) return <main className="inv-page"><p className="error">{error}</p></main>;
  if (!inv) return <main className="inv-page"><p className="muted">{t('common.loading')}</p></main>;
  const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat(lang === 'en' ? 'en-IN' : `${lang}-IN`, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) : '—');
  const m = (n: number) => money(n, inv.currency);
  const registered = !!inv.seller?.gstin;
  return (
    <main className="inv-page">
      <article className="inv-sheet" data-testid="invoice">
        <header className="inv-head">
          <div>
            <h1>{inv.seller?.legalName || inv.seller?.name}</h1>
            {inv.seller?.legalName && inv.seller?.legalName !== inv.seller?.name && <div className="muted">{inv.seller.name}</div>}
            {inv.seller?.address && <div>{inv.seller.address}</div>}
            {inv.seller?.gstin && <div>GSTIN: <b>{inv.seller.gstin}</b></div>}
            {(inv.seller?.phone || inv.seller?.email) && <div className="muted">{[inv.seller.phone, inv.seller.email].filter(Boolean).join(' · ')}</div>}
          </div>
          <div className="inv-title">
            <h2>{registered ? t('inv.tax_invoice') : t('inv.invoice')}</h2>
            <div>{inv.number}</div>
            {inv.status === 'paid' && <span className="stamp paid">{t('money.status.paid')}</span>}
            {inv.status === 'cancelled' && <span className="stamp cancelled">{t('money.status.cancelled')}</span>}
          </div>
        </header>
        <section className="inv-meta">
          <div><span className="muted">{t('inv.bill_to')}</span><b>{inv.customer?.name ?? '—'}</b>{inv.customer?.gstin && <div>GSTIN: {inv.customer.gstin}</div>}</div>
          <div><span className="muted">{t('inv.date')}</span><b>{date(inv.issuedAt)}</b></div>
          <div><span className="muted">{t('inv.due')}</span><b>{date(inv.dueAt)}</b></div>
          {registered && inv.placeOfSupplyName && <div><span className="muted">{t('inv.place')}</span><b>{inv.placeOfSupplyName} ({inv.placeOfSupply})</b></div>}
        </section>
        <table className="inv-table">
          <thead>
            <tr><th>{t('inv.item')}</th><th className="num">{t('inv.qty')}</th><th className="num">{t('inv.rate')}</th>{registered && <th className="num">{t('money.taxable')}</th>}{registered && <th className="num">GST</th>}<th className="num">{t('inv.amount')}</th></tr>
          </thead>
          <tbody>
            {inv.lines.map((l: any, i: number) => (
              <tr key={i}><td>{l.description}</td><td className="num">{l.qty}</td><td className="num">{m(l.unitPrice)}</td>{registered && <td className="num">{m(l.taxable)}</td>}{registered && <td className="num">{l.taxRate}%</td>}<td className="num">{m(l.amount)}</td></tr>
            ))}
          </tbody>
        </table>
        <section className="inv-totals">
          {registered && <div><span>{t('money.taxable')}</span><span>{m(inv.subtotal)}</span></div>}
          {registered && (inv.tax?.interState ? <div><span>IGST</span><span>{m(inv.tax.igst)}</span></div> : (
            <><div><span>CGST</span><span>{m(inv.tax?.cgst ?? 0)}</span></div><div><span>SGST</span><span>{m(inv.tax?.sgst ?? 0)}</span></div></>
          ))}
          <div className="grand"><span>{t('money.total')}</span><span>{m(inv.total)}</span></div>
        </section>
        {inv.seller?.notes && <p className="inv-notes">{inv.seller.notes}</p>}
        <footer className="inv-actions">
          {inv.payUrl && <a className="btn primary" href={inv.payUrl}>{t('inv.pay', { amount: m(inv.total) })}</a>}
          <button className="btn" onClick={() => window.print()}>{t('inv.print')}</button>
        </footer>
      </article>
      <p className="inv-powered muted small">{t('inv.powered')}</p>
    </main>
  );
}
