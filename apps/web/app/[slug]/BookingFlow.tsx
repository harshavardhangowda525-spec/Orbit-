'use client';

import { useEffect, useState } from 'react';
import { translate, formatMoney } from '@orbit/shared';
import { apiUrl } from '@/lib/api';

interface Service { id: string; name: string; durationMin: number; price: number | null }

/** Pick service → person (or any) → a real free time → name + phone → confirmed. */
export function BookingFlow({ slug, services, currency, timezone, lang, businessName }: { slug: string; services: Service[]; currency: string; timezone: string; lang: string; businessName: string }) {
  const t = (k: string, p: Record<string, string | number> = {}) => translate(lang, k, p);
  const [open, setOpen] = useState(false);
  // The page may be cached; load the current services when the customer starts booking.
  const [live, setLive] = useState<Service[] | null>(null);
  useEffect(() => {
    if (!open || live) return;
    fetch(`${apiUrl()}/public/businesses/${slug}`).then((r) => r.json()).then((b) => Array.isArray(b?.services) && setLive(b.services)).catch(() => undefined);
  }, [open, live, slug]);
  const bookable = (live ?? services).filter((s) => s.durationMin > 0);
  const [svc, setSvc] = useState<Service | null>(null);
  const [staff, setStaff] = useState<{ id: string; name: string }[] | null>(null);
  const [staffId, setStaffId] = useState<string | null | undefined>(undefined);
  const [slots, setSlots] = useState<{ start: string; staffId: string | null }[] | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<{ start: string; staffId: string | null } | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ start: string; end: string; service: string; staff: string | null; manageUrl: string; status?: string; deposit?: { url: string; amount: number; payBy: string } | null } | null>(null);
  const locale = lang === 'en' ? 'en-IN' : `${lang}-IN`;
  const dayKey = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(iso));
  const dayLabel = (iso: string) => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: timezone }).format(new Date(iso));
  const timeLabel = (iso: string) => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(new Date(iso));

  useEffect(() => {
    if (!svc) return;
    fetch(`${apiUrl()}/public/businesses/${slug}/staff?serviceId=${svc.id}`).then((r) => r.json()).then((s) => {
      setStaff(s);
      if (s.length <= 1) setStaffId(null);
    });
  }, [svc, slug]);
  useEffect(() => {
    if (!svc || staffId === undefined) return;
    setSlots(null);
    const q = new URLSearchParams({ serviceId: svc.id, days: '7', ...(staffId ? { staffId } : {}) });
    fetch(`${apiUrl()}/public/businesses/${slug}/slots?${q}`)
      .then(async (r) => {
        const s = await r.json().catch(() => null);
        if (!r.ok || !Array.isArray(s)) {
          // e.g. the service just changed: say so instead of pretending there are no free times.
          setError(s?.error?.message ?? t('chat.error'));
          setSvc(null);
          return;
        }
        setSlots(s);
        setDay(s.length ? dayKey(s[0].start) : null);
      })
      .catch(() => setError(t('chat.error')));
  }, [svc, staffId, slug]);

  async function confirm() {
    if (!svc || !slot) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`${apiUrl()}/public/businesses/${slug}/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceId: svc.id, staffId: slot.staffId, start: slot.start, name, phone }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data?.error?.message ?? t('chat.error'));
      if (data?.error?.code === 'slot_taken') {
        setSlot(null);
        setStaffId((s) => (s === undefined ? null : s)); // refresh slots
      }
      return;
    }
    setDone(data);
  }

  const ics = (d: NonNullable<typeof done>) => {
    const f = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `DTSTART:${f(d.start)}`, `DTEND:${f(d.end)}`, `SUMMARY:${d.service} — ${businessName}`, `DESCRIPTION:${d.manageUrl}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    return `data:text/calendar;charset=utf-8,${encodeURIComponent(body)}`;
  };

  if (!open) return <button className="btn primary big grow" onClick={() => setOpen(true)} disabled={!bookable.length}>📅 {t('public.book')}</button>;
  return (
    <div className="card stack" role="dialog" aria-label={t('public.book')} style={{ position: 'fixed', inset: 'auto 8px 8px 8px', maxWidth: 520, margin: '0 auto', zIndex: 31, maxHeight: '85dvh', overflowY: 'auto' }} data-testid="booking">
      <div className="row between">
        <b>{done ? t('book.done_title') : t('public.book')}</b>
        <button className="icon-btn" aria-label={t('common.close')} onClick={() => setOpen(false)}>×</button>
      </div>
      {done ? (
        <>
          {done.deposit ? (
            <>
              <p>{t('book.held', { service: done.service, when: `${dayLabel(done.start)}, ${timeLabel(done.start)}` })}</p>
              <a className="btn primary block" href={done.deposit.url} data-testid="pay-deposit">{t('book.pay_deposit', { amount: formatMoney(lang, currency, done.deposit.amount) })}</a>
              <p className="small muted">{t('book.pay_by', { time: `${dayLabel(done.deposit.payBy)}, ${timeLabel(done.deposit.payBy)}` })}</p>
            </>
          ) : (
            <p>{t('book.done', { service: done.service, when: `${dayLabel(done.start)}, ${timeLabel(done.start)}` })}</p>
          )}
          <a className="btn block" href={ics(done)} download="booking.ics">📅 {t('book.add_calendar')}</a>
          <a className="btn block" href={done.manageUrl}>{t('book.manage')}</a>
        </>
      ) : !svc ? (
        <>
          <p className="small muted">{t('book.pick_service')}</p>
          {bookable.map((s) => (
            <button key={s.id} className="btn block" style={{ justifyContent: 'space-between' }} onClick={() => setSvc(s)}>
              <span>{s.name} · {t('public.minutes', { count: s.durationMin })}</span>
              <span>{s.price === null ? t('public.ask_price') : s.price === 0 ? t('public.free') : formatMoney(lang, currency, s.price)}</span>
            </button>
          ))}
        </>
      ) : staffId === undefined && staff && staff.length > 1 ? (
        <>
          <p className="small muted">{t('book.pick_person')}</p>
          <button className="btn block" onClick={() => setStaffId(null)}>{t('book.any')}</button>
          {staff.map((s) => <button key={s.id} className="btn block" onClick={() => setStaffId(s.id)}>{s.name}</button>)}
        </>
      ) : !slot ? (
        <>
          <p className="small muted">{svc.name} · {t('book.pick_time')}</p>
          {!slots && <div className="sk" style={{ height: 120 }} />}
          {slots && slots.length === 0 && <p>{t('book.no_slots')}</p>}
          {slots && slots.length > 0 && (
            <>
              <div className="day-tabs">
                {[...new Set(slots.map((s) => dayKey(s.start)))].map((d) => {
                  const first = slots.find((s) => dayKey(s.start) === d)!;
                  return <button key={d} className="chip" aria-current={day === d} style={day === d ? { background: 'var(--ink)', color: 'var(--bg)' } : undefined} onClick={() => setDay(d)}>{dayLabel(first.start)}</button>;
                })}
              </div>
              <div className="slot-grid">
                {slots.filter((s) => dayKey(s.start) === day).map((s) => (
                  <button key={s.start} className="btn small" onClick={() => setSlot(s)}>{timeLabel(s.start)}</button>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); confirm(); }}>
          <p><b>{svc.name}</b> · {dayLabel(slot.start)}, {timeLabel(slot.start)}</p>
          <input className="input" placeholder={t('book.name')} aria-label={t('book.name')} value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
          <input className="input" type="tel" inputMode="tel" placeholder={t('book.phone')} aria-label={t('book.phone')} value={phone} onChange={(e) => setPhone(e.target.value)} required autoComplete="tel" />
          <button className="btn primary big" disabled={busy || !name.trim() || phone.trim().length < 6}>{busy ? '…' : t('book.confirm')}</button>
          <button type="button" className="link-btn" onClick={() => setSlot(null)}>{t('book.change_time')}</button>
        </form>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
