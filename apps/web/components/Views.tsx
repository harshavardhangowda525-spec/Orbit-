'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { BridgeData } from '@/app/bridge/page';

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<T>(path).then(setData).catch((e) => setError((e as ApiError).message));
  }, [path]);
  return { data, error };
}

export function CrewView({ data }: { data: BridgeData }) {
  const { t } = useI18n();
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = (agent: string) => data.feed.filter((g) => g.agent === agent && g.at.slice(0, 10) === today).reduce((n, g) => n + g.items.length, 0);
  return (
    <section>
      <h2>{t('view.crew')}</h2>
      <p className="muted small">{t('crew.sub')}</p>
      <div className="crew-grid">
        {data.crew.map((a) => (
          <div key={a.agent} className="card crew-card" data-agent={a.agent}>
            <span className={`avatar lg a-${a.agent}`}>{a.name[0]}</span>
            <b>{a.name}</b>
            <span className="small muted">{t(`agent.${a.agent}.role`)}</span>
            <span className="status" style={{ color: a.enabled ? 'var(--good)' : 'var(--muted)' }}>{a.enabled ? t('crew.on') : t('crew.off')}</span>
            {a.enabled && <span className="small">{t('crew.done_today', { count: doneToday(a.agent) })}</span>}
            {!a.enabled && <span className="small muted">{t('crew.upgrade')}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}

export function PeopleView() {
  const { t, money } = useI18n();
  const { data, error } = useLoad<any[]>('/customers');
  return (
    <section>
      <h2>{t('view.people')}</h2>
      {error && <p className="error">{error}</p>}
      {data && data.length === 0 && <p className="muted">{t('people.empty')}</p>}
      <div className="card">
        {data?.map((c) => (
          <div key={c.id} className="list-item">
            <span className="avatar a-orbit">{(c.name ?? '?')[0]}</span>
            <div className="grow">
              <b>{c.name ?? c.phone}</b>
              <div className="small muted">{t('people.line', { visits: c.visitCount, spend: money(c.lifetimeSpend) })}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const POWER_GROUPS: [string, string[]][] = [
  ['messaging', ['whatsapp', 'instagram', 'messenger', 'gmail', 'outlook', 'sms', 'phone', 'telegram']],
  ['calendar', ['google_calendar', 'outlook_calendar', 'google_meet', 'zoom']],
  ['payments', ['razorpay', 'cashfree', 'phonepe', 'paytm', 'stripe']],
  ['records', ['tally', 'zoho_books', 'quickbooks', 'google_sheets', 'google_drive']],
  ['presence', ['google_business_profile', 'meta_ads', 'google_ads', 'youtube', 'linkedin']],
];

export function PowersView() {
  const { t } = useI18n();
  const { data } = useLoad<any>('/onboarding/state');
  const status = new Map<string, string>((data?.powers ?? []).map((p: any) => [p.power_type, p.status]));
  return (
    <section>
      <h2>{t('view.powers')}</h2>
      <p className="muted small">{t('powers.sub')}</p>
      {POWER_GROUPS.map(([group, powers]) => (
        <div key={group} className="card">
          <h3 className="small muted">{t(`powers.group.${group}`)}</h3>
          {powers.map((p) => (
            <div key={p} className="list-item">
              <div className="grow">
                <b>{t(`power.${p}`)}</b>
                <div className="small muted">{t(`power.${p}.what`)}</div>
              </div>
              <span className="chip small">{status.get(p) === 'pending' ? t('powers.pending') : status.get(p) === 'connected' ? t('powers.connected') : t('powers.soon')}</span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

export function DetailsView() {
  const { t, lang } = useI18n();
  const { data } = useLoad<any[]>('/bookings');
  const { data: convs } = useLoad<any[]>('/conversations');
  const fmt = (iso: string) => new Intl.DateTimeFormat(lang, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const upcoming = (data ?? []).filter((b) => new Date(b.endAt) > new Date() && b.status !== 'cancelled').slice(0, 20);
  return (
    <section>
      <h2>{t('details.bookings')}</h2>
      <div className="card">
        {upcoming.length === 0 && <p className="muted">{t('details.no_bookings')}</p>}
        {upcoming.map((b) => (
          <div key={b.id} className="list-item">
            <b style={{ minWidth: 90 }}>{fmt(b.startAt)}</b>
            <div className="grow">{b.customer ?? '—'} · {b.service}{b.staff ? ` · ${b.staff}` : ''}</div>
          </div>
        ))}
      </div>
      <h2 style={{ marginTop: 20 }}>{t('details.inbox')}</h2>
      <div className="card">
        {(convs ?? []).length === 0 && <p className="muted">{t('details.no_conversations')}</p>}
        {(convs ?? []).map((c) => (
          <div key={c.id} className="list-item">
            <div className="grow"><b>{c.customer ?? t('details.visitor')}</b><div className="small muted">{t(`channel.${c.channel}`)}</div></div>
            <span className="chip small">{t(`conv.${c.status}`)}</span>
          </div>
        ))}
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>{t('details.more_soon')}</p>
    </section>
  );
}

export function ComingView({ view }: { view: 'tomorrow' | 'rewind' }) {
  const { t } = useI18n();
  return (
    <section className="card empty">
      <div className="big">{view === 'tomorrow' ? '🔮' : '⏪'}</div>
      <h2>{t(`view.${view}`)}</h2>
      <p>{t(`coming.${view}`)}</p>
    </section>
  );
}
