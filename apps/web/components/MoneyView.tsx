'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { computeInvoice, GST_RATES, gstinState } from '@orbit/shared';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface Invoice {
  id: string; number: string | null; status: 'draft' | 'sent' | 'overdue' | 'paid' | 'cancelled'; currency: string;
  customerName: string | null; customerPhone: string | null; lines: { description: string; qty: number; unitPrice: number; taxRate: number; taxable: number; tax: number; amount: number }[];
  tax: { cgst: number; sgst: number; igst: number; interState: boolean }; subtotal: number; taxTotal: number; total: number; amountPaid: number;
  dueAt: string | null; issuedAt: string | null; paidAt: string | null; payUrl: string | null; reminders: number;
}
interface Profile { legalName: string | null; gstin: string | null; state: string | null; stateName: string | null; defaultTaxRate: number; pricesIncludeTax: boolean; invoicePrefix: string; invoiceNotes: string | null; paymentTermsDays: number; currency: string; razorpay: boolean }
interface Summary { today: number; month: number; outstanding: number; overdue: number; drafts: number; currency: string }

const FILTERS = ['all', 'unpaid', 'paid', 'draft'] as const;

/** Money (Ledger): what came in, what is owed, invoices, and GST settings. */
export function MoneyView() {
  const { t, money } = useI18n();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [rows, setRows] = useState<Invoice[] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Summary>('/ledger/summary').then(setSummary).catch((e) => setError((e as ApiError).message));
    api<Profile>('/ledger/profile').then(setProfile).catch(() => undefined);
    api<Invoice[]>(`/ledger/invoices${filter === 'all' ? '' : `?status=${filter}`}`).then(setRows).catch((e) => setError((e as ApiError).message));
  }, [filter]);
  useEffect(load, [load]);

  const cur = summary?.currency ?? 'INR';
  return (
    <section className="stack money" data-testid="money">
      <div className="row between">
        <h2>{t('view.money')}</h2>
        <button className="btn primary small" onClick={() => setCreating(true)}>{t('money.new')}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {summary && (
        <div className="money-tiles">
          <div className="tile"><b>{money(summary.today, cur)}</b><span>{t('money.today')}</span></div>
          <div className="tile"><b>{money(summary.month, cur)}</b><span>{t('money.month')}</span></div>
          <div className={`tile ${summary.outstanding > 0 ? 'attn' : ''}`}><b>{money(summary.outstanding, cur)}</b><span>{t('money.outstanding')}</span></div>
          <div className={`tile ${summary.overdue > 0 ? 'attn' : ''}`}><b>{summary.overdue}</b><span>{t('money.overdue')}</span></div>
        </div>
      )}
      {profile && !profile.gstin && <p className="note small">{t('money.no_gstin')} <button className="link-btn small" onClick={() => setSettings(true)}>{t('money.gst_settings')}</button></p>}
      {profile && !profile.razorpay && <p className="note small">{t('money.no_razorpay')}</p>}

      {creating && profile && <InvoiceForm profile={profile} onDone={(id) => { setCreating(false); setOpen(id); load(); }} onCancel={() => setCreating(false)} />}

      <nav className="seg">
        {FILTERS.map((f) => <button key={f} className="chip" aria-current={filter === f} onClick={() => setFilter(f)}>{t(`money.filter.${f}`)}</button>)}
      </nav>
      <div className="card">
        {rows?.length === 0 && <p className="muted">{t('money.empty')}</p>}
        {rows?.map((i) => (
          <div key={i.id}>
            <button className="list-item rowbtn" onClick={() => setOpen(open === i.id ? null : i.id)}>
              <div className="grow">
                <b>{i.customerName ?? t('money.no_customer')}</b>
                <div className="small muted">{i.number ?? t('money.draft')}{i.dueAt && i.status !== 'paid' && i.status !== 'draft' ? ` · ${t('money.due', { date: new Date(i.dueAt).toLocaleDateString() })}` : ''}</div>
              </div>
              <div className="right">
                <b>{money(i.total, i.currency)}</b>
                <span className={`status-chip s-${i.status}`}>{t(`money.status.${i.status}`)}</span>
              </div>
            </button>
            {open === i.id && <InvoiceDetail id={i.id} onChange={load} />}
          </div>
        ))}
      </div>

      <button className="link-btn small" onClick={() => setSettings(!settings)}>{t('money.gst_settings')}</button>
      {settings && profile && <GstSettings profile={profile} onDone={() => { setSettings(false); load(); }} />}
    </section>
  );
}

function InvoiceDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const { t, money } = useI18n();
  const [inv, setInv] = useState<Invoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const load = useCallback(() => api<Invoice>(`/ledger/invoices/${id}`).then(setInv), [id]);
  useEffect(() => {
    load();
  }, [load]);
  const act = async (path: string, body?: object) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<any>(`/ledger/invoices/${id}/${path}`, { body: body ?? {} });
      setInv(r);
      if (path === 'send') {
        setLink(r.url);
        setMsg(r.delivered ? t('money.sent_on', { channel: t(`channel.${r.channel}`) }) : t('money.not_sent'));
      }
      onChange();
    } catch (e) {
      setMsg((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  if (!inv) return <p className="muted small">{t('common.loading')}</p>;
  const final = inv.status === 'paid' || inv.status === 'cancelled';
  return (
    <div className="invoice-detail stack">
      <table className="inv-lines">
        <tbody>
          {inv.lines.map((l, k) => (
            <tr key={k}><td>{l.description}{l.qty !== 1 ? ` × ${l.qty}` : ''}</td><td className="num">{money(l.amount, inv.currency)}</td></tr>
          ))}
          <tr className="sub"><td>{t('money.taxable')}</td><td className="num">{money(inv.subtotal, inv.currency)}</td></tr>
          {inv.tax.interState ? (
            <tr className="sub"><td>IGST</td><td className="num">{money(inv.tax.igst, inv.currency)}</td></tr>
          ) : inv.taxTotal > 0 ? (
            <>
              <tr className="sub"><td>CGST</td><td className="num">{money(inv.tax.cgst, inv.currency)}</td></tr>
              <tr className="sub"><td>SGST</td><td className="num">{money(inv.tax.sgst, inv.currency)}</td></tr>
            </>
          ) : null}
          <tr className="total"><td>{t('money.total')}</td><td className="num">{money(inv.total, inv.currency)}</td></tr>
        </tbody>
      </table>
      {inv.status === 'overdue' && <p className="small muted">{t('money.reminders', { n: inv.reminders })}</p>}
      {msg && <p className="note small">{msg}</p>}
      {link && (
        <div className="row">
          <input className="input grow" readOnly value={link} onFocus={(e) => e.target.select()} />
          <button className="btn small" onClick={() => navigator.clipboard?.writeText(link)}>{t('common.copy')}</button>
        </div>
      )}
      {!final && (
        <div className="row wrap">
          <button className="btn primary small" disabled={busy} onClick={() => act('send')}>{inv.status === 'draft' ? t('money.send') : t('money.resend')}</button>
          <button className="btn small" disabled={busy} onClick={() => act('paid', { method: 'cash' })}>{t('money.paid_cash')}</button>
          <button className="btn small" disabled={busy} onClick={() => act('paid', { method: 'upi' })}>{t('money.paid_upi')}</button>
          {inv.payUrl && <button className="btn small" disabled={busy} onClick={() => act('refresh')}>{t('money.check')}</button>}
          <button className="btn small" disabled={busy} onClick={() => confirm(t('money.cancel_confirm')) && act('cancel')}>{t('money.cancel')}</button>
        </div>
      )}
      {inv.status === 'paid' && inv.paidAt && <p className="small">{t('money.paid_on', { date: new Date(inv.paidAt).toLocaleString() })}</p>}
    </div>
  );
}

type LineDraft = { description: string; qty: string; unitPrice: string; taxRate: number };

function InvoiceForm({ profile, onDone, onCancel }: { profile: Profile; onDone: (id: string) => void; onCancel: () => void }) {
  const { t, money } = useI18n();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [gstin, setGstin] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ description: '', qty: '1', unitPrice: '', taxRate: profile.defaultTaxRate }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const totals = useMemo(
    () => computeInvoice(lines.map((l) => ({ description: l.description, qty: Number(l.qty) || 0, unitPrice: Number(l.unitPrice) || 0, taxRate: l.taxRate })), {
      inclusive: profile.pricesIncludeTax, registered: !!profile.gstin, sellerState: profile.state, buyerState: gstinState(gstin) ?? profile.state,
    }),
    [lines, gstin, profile],
  );
  const set = (i: number, patch: Partial<LineDraft>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const save = async (send: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const inv = await api<{ id: string }>('/ledger/invoices', {
        body: {
          customer: { name: name || undefined, phone: phone || undefined, gstin: gstin || undefined },
          lines: lines.filter((l) => l.description.trim()).map((l) => ({ description: l.description, qty: Number(l.qty) || 1, unitPrice: Number(l.unitPrice) || 0, taxRate: profile.gstin ? l.taxRate : 0 })),
        },
      });
      if (send) await api(`/ledger/invoices/${inv.id}/send`, { body: {} });
      onDone(inv.id);
    } catch (e) {
      setErr((e as ApiError).message);
      setBusy(false);
    }
  };
  return (
    <div className="card stack invoice-form" data-testid="invoice-form">
      <h3>{t('money.new')}</h3>
      <div className="grid2">
        <label className="field"><span>{t('money.f.name')}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>{t('money.f.phone')}</span><input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
      </div>
      {profile.gstin && <label className="field"><span>{t('money.f.gstin')} ({t('common.optional')})</span><input className="input" value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} /></label>}
      {lines.map((l, i) => (
        <div key={i} className="line-row">
          <input className="input" aria-label={t('money.f.item')} placeholder={t('money.f.item')} value={l.description} onChange={(e) => set(i, { description: e.target.value })} />
          <input className="input" aria-label={t('money.f.qty')} inputMode="decimal" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} />
          <input className="input" aria-label={t('money.f.price')} placeholder="₹" inputMode="decimal" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} />
          {profile.gstin && (
            <select className="input" aria-label="GST" value={l.taxRate} onChange={(e) => set(i, { taxRate: Number(e.target.value) })}>
              {GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
            </select>
          )}
        </div>
      ))}
      <button className="link-btn small" onClick={() => setLines([...lines, { description: '', qty: '1', unitPrice: '', taxRate: profile.defaultTaxRate }])}>+ {t('money.add_line')}</button>
      <div className="inv-preview small">
        {profile.gstin ? (
          <>
            <div className="row between"><span>{t('money.taxable')}</span><span>{money(totals.subtotal)}</span></div>
            {totals.interState ? <div className="row between"><span>IGST</span><span>{money(totals.igst)}</span></div> : (
              <><div className="row between"><span>CGST</span><span>{money(totals.cgst)}</span></div><div className="row between"><span>SGST</span><span>{money(totals.sgst)}</span></div></>
            )}
          </>
        ) : null}
        <div className="row between"><b>{t('money.total')}</b><b>{money(totals.total)}</b></div>
        {profile.gstin && <span className="muted">{profile.pricesIncludeTax ? t('money.incl') : t('money.excl')}</span>}
      </div>
      {err && <p className="error">{err}</p>}
      <div className="row wrap">
        <button className="btn primary" disabled={busy || totals.total <= 0} onClick={() => save(true)}>{t('money.save_send')}</button>
        <button className="btn" disabled={busy || totals.total <= 0} onClick={() => save(false)}>{t('money.save_draft')}</button>
        <button className="btn" onClick={onCancel}>{t('meta.cancel')}</button>
      </div>
    </div>
  );
}

function GstSettings({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const { t } = useI18n();
  const [v, setV] = useState({ legalName: profile.legalName ?? '', gstin: profile.gstin ?? '', defaultTaxRate: profile.defaultTaxRate, pricesIncludeTax: profile.pricesIncludeTax, invoicePrefix: profile.invoicePrefix, paymentTermsDays: profile.paymentTermsDays, invoiceNotes: profile.invoiceNotes ?? '' });
  const [err, setErr] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/ledger/profile', { method: 'PATCH', body: v });
      onDone();
    } catch (x) {
      setErr((x as ApiError).message);
    }
  };
  return (
    <form className="card stack" onSubmit={save} data-testid="gst-settings">
      <label className="field"><span>{t('money.f.legal_name')}</span><input className="input" value={v.legalName} onChange={(e) => setV({ ...v, legalName: e.target.value })} /></label>
      <label className="field"><span>GSTIN ({t('common.optional')})</span><input className="input" value={v.gstin} onChange={(e) => setV({ ...v, gstin: e.target.value.toUpperCase() })} placeholder="29ABCDE1234F1Z5" /><small className="muted">{t('money.h.gstin')}</small></label>
      <div className="grid2">
        <label className="field"><span>{t('money.f.default_rate')}</span>
          <select className="input" value={v.defaultTaxRate} onChange={(e) => setV({ ...v, defaultTaxRate: Number(e.target.value) })}>{GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}</select>
        </label>
        <label className="field"><span>{t('money.f.terms')}</span><input className="input" inputMode="numeric" value={v.paymentTermsDays} onChange={(e) => setV({ ...v, paymentTermsDays: Number(e.target.value) || 0 })} /></label>
      </div>
      <label className="check-line"><input type="checkbox" checked={v.pricesIncludeTax} onChange={(e) => setV({ ...v, pricesIncludeTax: e.target.checked })} /> <span>{t('money.f.inclusive')}</span></label>
      <label className="field"><span>{t('money.f.prefix')}</span><input className="input" value={v.invoicePrefix} maxLength={4} onChange={(e) => setV({ ...v, invoicePrefix: e.target.value.toUpperCase() })} /></label>
      <label className="field"><span>{t('money.f.notes')}</span><textarea className="input" rows={2} value={v.invoiceNotes} onChange={(e) => setV({ ...v, invoiceNotes: e.target.value })} /></label>
      {err && <p className="error">{err}</p>}
      <div className="row"><button className="btn primary">{t('meta.save')}</button></div>
    </form>
  );
}
