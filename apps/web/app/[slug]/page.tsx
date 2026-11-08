import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { WEEKDAYS, pickLanguage, translate, formatMoney, type WeeklyHours } from '@orbit/shared';
import { ChatPanel } from './ChatPanel';

const API = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface PublicBusiness {
  slug: string;
  name: string;
  type: string;
  currency: string;
  languages: string[];
  live: boolean;
  openNow: boolean;
  profile: { address: string | null; city: string | null; phone: string | null; whatsapp: string | null; hours: WeeklyHours; description: string | null; photos: string[]; geo_lat: number | null; geo_lng: number | null } | null;
  services: { id: string; name: string; description: string | null; durationMin: number; price: number | null; category: string | null }[];
  rating: { avg: number; count: number } | null;
  reviews: { author: string; rating: number; text: string }[];
  poweredByOrbit: boolean;
}

async function load(slug: string): Promise<PublicBusiness | null> {
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return null;
  const res = await fetch(`${API}/public/businesses/${slug}`, { next: { revalidate: 60 } }).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json();
}

async function viewerLang(b: PublicBusiness) {
  const h = await headers();
  const prefs = (h.get('accept-language') ?? '').split(',').map((p) => p.split(';')[0].trim()).filter(Boolean);
  return pickLanguage(prefs, b.languages.length ? b.languages : ['en']);
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const b = await load((await params).slug);
  if (!b) return { title: 'Not found' };
  const desc = b.profile?.description ?? `${b.name} — book online, see prices and timings.`;
  return { title: b.name, description: desc, openGraph: { title: b.name, description: desc, images: b.profile?.photos?.slice(0, 1) } };
}

export default async function PublicPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ chat?: string }> }) {
  const { slug } = await params;
  const b = await load(slug);
  if (!b) notFound();
  const lang = await viewerLang(b);
  const t = (k: string, p: Record<string, string | number> = {}) => translate(lang, k, p);
  const p = b.profile;
  const wa = p?.whatsapp?.replace(/\D/g, '');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: b.name,
    description: p?.description ?? undefined,
    telephone: p?.phone ?? undefined,
    address: p?.address ?? undefined,
    image: p?.photos?.[0],
    aggregateRating: b.rating ? { '@type': 'AggregateRating', ratingValue: b.rating.avg, reviewCount: b.rating.count } : undefined,
    openingHoursSpecification: p?.hours
      ? WEEKDAYS.flatMap((d) => (p.hours[d]?.open ? p.hours[d].ranges.map((r) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: d, opens: r.from, closes: r.to })) : []))
      : undefined,
  };
  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      <header className="hero">
        <div className="hero-inner stack">
          <h1>{b.name}</h1>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className={`open-pill ${b.openNow ? 'open' : 'closed'}`}>{b.openNow ? t('public.open') : t('public.closed')}</span>
            {b.rating && <span className="small">★ {b.rating.avg} · {t('public.reviews', { count: b.rating.count })}</span>}
          </div>
          {p?.description && <p className="muted">{p.description}</p>}
          {p?.address && <p className="small">📍 {p.address}</p>}
        </div>
      </header>
      <div className="page" style={{ minHeight: 0 }}>
        <section className="card">
          <h2>{t('public.services')}</h2>
          {b.services.map((s) => (
            <div key={s.id} className="svc-row">
              <div>
                <b>{s.name}</b>
                {s.durationMin > 0 && <div className="small muted">{t('public.minutes', { count: s.durationMin })}</div>}
              </div>
              <b>{s.price === null ? t('public.ask_price') : s.price === 0 ? t('public.free') : formatMoney(lang, b.currency, s.price)}</b>
            </div>
          ))}
        </section>
        {p?.hours && (
          <section className="card">
            <h2>{t('public.hours')}</h2>
            <table className="hours-table">
              <tbody>
                {WEEKDAYS.map((d) => (
                  <tr key={d}>
                    <td>{t(`weekday.${d}`)}</td>
                    <td style={{ textAlign: 'right' }}>{p.hours[d]?.open ? p.hours[d].ranges.map((r) => `${r.from}–${r.to}`).join(', ') : t('common.closed')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {b.reviews.length > 0 && (
          <section className="card">
            <h2>{t('public.what_people_say')}</h2>
            {b.reviews.map((r, i) => (
              <p key={i}>“{r.text}” <span className="small muted">— {r.author} {'★'.repeat(r.rating)}</span></p>
            ))}
          </section>
        )}
        {p?.address && (
          <section className="card">
            <h2>{t('public.find_us')}</h2>
            <a className="btn block" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${b.name} ${p.address}`)}`} target="_blank" rel="noreferrer">🗺️ {t('public.open_map')}</a>
          </section>
        )}
        {b.poweredByOrbit && <p className="small muted" style={{ textAlign: 'center', marginTop: 16 }}>{t('public.powered')}</p>}
        <div className="sticky-cta">
          <ChatPanel businessName={b.name} lang={lang} openOnLoad={(await searchParams).chat === '1'} />
          {p?.phone && <a className="btn" href={`tel:${p.phone}`} aria-label={t('public.call')}>📞</a>}
          {wa && <a className="btn" href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" aria-label="WhatsApp">💬</a>}
        </div>
      </div>
    </main>
  );
}
