'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BUSINESS_TYPES, WEEKDAYS, type WeeklyHours, type Weekday } from '@orbit/shared';
import { api, ApiError, session } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { LanguagePicker } from '@/components/LanguagePicker';
import { LiveLinks, Checklist } from '@/components/LiveLinks';

type Step = 'type' | 'import' | 'name' | 'services' | 'hours' | 'staff' | 'calendar' | 'live';
const STEPS: Step[] = ['type', 'import', 'name', 'services', 'hours', 'staff', 'calendar', 'live'];
const SUB_KEY = 'orbit.ob.sub';

interface Svc { id?: string; name: string; durationMin: number; price: number | null }
interface Draft {
  name: string;
  phone: string;
  address: string;
  description: string;
  hours: WeeklyHours;
  services: Svc[];
  staff: { id?: string; name: string }[];
}

export default function Onboarding() {
  const { t, lang } = useI18n();
  const { me, loading, business, refresh, chooseBusiness } = useSession();
  const router = useRouter();
  const [step, setStep] = useState<Step | null>(null);
  const [state, setState] = useState<any>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [types, setTypes] = useState<{ type: string; icon: string }[]>([]);

  const go = (s: Step) => {
    setError(null);
    setStep(s);
    try {
      if (['name', 'services', 'hours', 'staff'].includes(s)) localStorage.setItem(SUB_KEY, s);
    } catch {}
    window.scrollTo(0, 0);
  };

  const load = useCallback(async () => {
    const s = await api('/onboarding/state');
    setState(s);
    const imported = s.profile?.import_source ?? {};
    setDraft((d) => ({
      name: d?.name ?? (s.business.onboardingStep <= 4 && imported.name && s.business.name.startsWith('My ') ? imported.name : s.business.name),
      phone: d?.phone ?? (s.profile?.phone ?? imported.phone ?? ''),
      address: d?.address ?? (s.profile?.address ?? imported.address ?? ''),
      description: d?.description ?? (s.profile?.description ?? imported.description ?? ''),
      hours: d?.hours ?? s.profile?.hours,
      services: s.services,
      staff: s.staff,
    }));
    return s;
  }, []);

  // Resume where the owner left off.
  useEffect(() => {
    if (loading) return;
    if (!me) return router.replace('/login');
    api('/onboarding/types').then(setTypes).catch(() => undefined);
    if (!business) return setStep('type');
    load()
      .then((s) => {
        const n = s.business.onboardingStep;
        let sub: Step = 'name';
        try {
          sub = (localStorage.getItem(SUB_KEY) as Step) || 'name';
        } catch {}
        setStep(s.business.status !== 'onboarding' ? 'live' : n <= 3 ? 'import' : n === 4 ? sub : n === 5 ? 'calendar' : 'live');
      })
      .catch((e) => setError((e as ApiError).message));
  }, [loading, me, business, load, router]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  async function saveEssentials(final: boolean) {
    if (!draft) return;
    await api('/onboarding/essentials', {
      method: 'PUT',
      body: {
        name: draft.name,
        phone: draft.phone || null,
        address: draft.address || null,
        description: draft.description || null,
        hours: draft.hours,
        services: draft.services.filter((s) => s.name.trim()),
        staff: draft.staff.filter((s) => s.name.trim()),
        final,
      },
    });
    const s = await load();
    setDraft((d) => d && { ...d, services: s.services, staff: s.staff });
  }

  const idx = step ? STEPS.indexOf(step) : 0;
  const back = idx > 0 && step !== 'live' ? () => go(STEPS[idx - 1]) : null;

  if (!step) {
    return (
      <main className="page center">
        <p className="muted">{error ?? t('common.loading')}</p>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="ob-top">
        {back ? (
          <button className="icon-btn" aria-label={t('common.back')} onClick={back}>
            ←
          </button>
        ) : (
          <span style={{ width: 40 }} />
        )}
        <div className="grow small muted">{t('ob.step_of', { n: Math.min(idx + 1, STEPS.length), total: STEPS.length })}</div>
        <LanguagePicker compact />
      </div>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(((idx + 1) / STEPS.length) * 100)}>
        <div style={{ width: `${((idx + 1) / STEPS.length) * 100}%` }} />
      </div>

      {step === 'type' && (
        <section className="stack">
          <h1>{t('ob.type.title')}</h1>
          <div className="type-grid">
            {(types.length ? types : BUSINESS_TYPES.map((x) => ({ type: x, icon: '•' }))).map((ty) => (
              <button
                key={ty.type}
                className="type-btn"
                aria-pressed={state?.business?.type === ty.type}
                disabled={busy}
                data-type={ty.type}
                onClick={() =>
                  run(async () => {
                    if (!business) {
                      const r = await api<{ businessId: string }>('/onboarding/business', { body: { type: ty.type, language: lang, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, business: false });
                      session.setBusinessId(r.businessId);
                      chooseBusiness(r.businessId);
                      await refresh();
                    } else if (state?.business?.type !== ty.type) {
                      await api('/onboarding/type', { method: 'PUT', body: { type: ty.type } });
                      setDraft(null);
                    }
                    await load();
                    go('import');
                  })
                }
              >
                <span className="emoji" aria-hidden>{ty.icon}</span>
                {t(`type.${ty.type}`)}
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 'import' && <ImportStep busy={busy} run={run} onDone={async (fields) => {
        await api('/onboarding/import', { method: 'PUT', body: { fields } });
        if (fields) {
          setDraft((d) => d && {
            ...d,
            name: fields.name ?? d.name,
            phone: fields.phone ?? d.phone,
            address: fields.address ?? d.address,
            description: fields.description ?? d.description,
          });
        }
        go('name');
      }} />}

      {step === 'name' && draft && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await saveEssentials(false); go('services'); }); }}>
          <h1>{t('ob.name.title')}</h1>
          <div className="field">
            <label htmlFor="bname">{t('ob.name.label')}</label>
            <input id="bname" className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required minLength={2} maxLength={80} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="bphone">{t('ob.name.phone')}</label>
            <input id="bphone" className="input" type="tel" inputMode="tel" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder={t('common.optional')} />
          </div>
          <div className="field">
            <label htmlFor="baddr">{t('ob.name.address')}</label>
            <input id="baddr" className="input" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder={t('common.optional')} />
          </div>
          <button className="btn primary big block" disabled={busy || draft.name.trim().length < 2}>{t('common.continue')}</button>
        </form>
      )}

      {step === 'services' && draft && (
        <ServicesStep draft={draft} setDraft={setDraft} busy={busy} onNext={() => run(async () => { await saveEssentials(false); go('hours'); })} />
      )}

      {step === 'hours' && draft && (
        <HoursStep hours={draft.hours} setHours={(h) => setDraft({ ...draft, hours: h })} busy={busy} onNext={() => run(async () => { await saveEssentials(false); go('staff'); })} />
      )}

      {step === 'staff' && draft && (
        <StaffStep draft={draft} setDraft={setDraft} busy={busy} onNext={() => run(async () => { await saveEssentials(true); go('calendar'); })} />
      )}

      {step === 'calendar' && (
        <section className="stack">
          <h1>{t('ob.cal.title')}</h1>
          <p className="muted">{t('ob.cal.sub')}</p>
          {(['google', 'builtin'] as const).map((mode) => (
            <button key={mode} className={`btn big block ${mode === 'builtin' ? 'primary' : 'ghost'}`} disabled={busy} data-mode={mode}
              onClick={() => run(async () => {
                await api('/onboarding/calendar', { method: 'PUT', body: { mode } });
                await api('/onboarding/launch', { body: {} });
                try { localStorage.removeItem(SUB_KEY); } catch {}
                await refresh();
                await load();
                go('live');
              })}>
              {mode === 'google' ? `📅 ${t('ob.cal.google')}` : `🗓️ ${t('ob.cal.builtin')}`}
            </button>
          ))}
          {state?.business?.calendarMode === 'google' && <p className="note small">{t('ob.cal.google_note')}</p>}
        </section>
      )}

      {step === 'live' && state && (
        <LiveScreen state={state} busy={busy} relaunch={() => run(async () => { await api('/onboarding/launch', { body: {} }); await refresh(); await load(); })} />
      )}

      {error && <p className="error" role="alert" style={{ marginTop: 16 }}>{error}</p>}
    </main>
  );
}

function ImportStep({ busy, run, onDone }: { busy: boolean; run: (fn: () => Promise<void>) => void; onDone: (fields: any) => Promise<void> }) {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const [result, setResult] = useState<any>(null);
  return (
    <section className="stack">
      <h1>{t('ob.import.title')}</h1>
      <p className="muted">{t('ob.import.sub')}</p>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => setResult(await api('/onboarding/import/preview', { body: { input } }))); }}>
        <input className="input" aria-label={t('ob.import.title')} value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('ob.import.placeholder')} />
        <button className="btn block" disabled={busy || input.trim().length < 2}>{busy ? t('common.wait') : t('ob.import.find')}</button>
      </form>
      {result && (
        <div className="card stack">
          <p className={result.ok ? '' : 'muted'}>{t(result.messageKey)}</p>
          {Object.entries(result.fields).filter(([k, v]) => k !== 'photos' && v).map(([k, v]) => (
            <div key={k} className="small"><b>{t(`ob.import.field.${k}`)}:</b> {String(v)}</div>
          ))}
          {result.fields.photos?.length > 0 && <div className="small muted">{t('ob.import.photos', { count: result.fields.photos.length })}</div>}
          <button className="btn primary block" disabled={busy} onClick={() => run(() => onDone(result.fields))}>{t('ob.import.use')}</button>
        </div>
      )}
      <button className={`btn ${result ? 'ghost' : 'primary'} big block`} disabled={busy} onClick={() => run(() => onDone(null))}>
        {t('ob.import.skip')}
      </button>
    </section>
  );
}

function ServicesStep({ draft, setDraft, busy, onNext }: { draft: Draft; setDraft: (d: Draft) => void; busy: boolean; onNext: () => void }) {
  const { t } = useI18n();
  const set = (i: number, patch: Partial<Svc>) => setDraft({ ...draft, services: draft.services.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (
    <section className="stack">
      <h1>{t('ob.svc.title')}</h1>
      <p className="muted">{t('ob.svc.sub')}</p>
      <div className="svc svc-head"><span>{t('ob.svc.name')}</span><span>{t('ob.svc.minutes')}</span><span>{t('ob.svc.price')}</span><span /></div>
      {draft.services.map((s, i) => (
        <div className="svc" key={s.id ?? `new-${i}`}>
          <input className="input" aria-label={t('ob.svc.name')} value={s.name} onChange={(e) => set(i, { name: e.target.value })} />
          <input className="input" aria-label={t('ob.svc.minutes')} type="number" inputMode="numeric" min={0} max={1440} value={s.durationMin} onChange={(e) => set(i, { durationMin: Math.max(0, Number(e.target.value) || 0) })} />
          <input className="input" aria-label={t('ob.svc.price')} type="number" inputMode="decimal" min={0} placeholder={t('ob.svc.ask')} value={s.price ?? ''} onChange={(e) => set(i, { price: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} />
          <button className="icon-btn" aria-label={t('common.remove')} disabled={draft.services.length <= 1} onClick={() => setDraft({ ...draft, services: draft.services.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      <button className="btn ghost block" onClick={() => setDraft({ ...draft, services: [...draft.services, { name: '', durationMin: 30, price: null }] })}>+ {t('ob.svc.add')}</button>
      <button className="btn primary big block" disabled={busy || !draft.services.some((s) => s.name.trim())} onClick={onNext}>{t('common.continue')}</button>
    </section>
  );
}

function HoursStep({ hours, setHours, busy, onNext }: { hours: WeeklyHours; setHours: (h: WeeklyHours) => void; busy: boolean; onNext: () => void }) {
  const { t } = useI18n();
  const setDay = (d: Weekday, patch: Partial<WeeklyHours[Weekday]>) => setHours({ ...hours, [d]: { ...hours[d], ...patch } });
  const valid = useMemo(() => WEEKDAYS.every((d) => !hours[d].open || (hours[d].ranges.length > 0 && hours[d].ranges.every((r) => r.from < r.to))), [hours]);
  return (
    <section className="stack">
      <h1>{t('ob.hours.title')}</h1>
      <p className="muted">{t('ob.hours.sub')}</p>
      <div>
        {WEEKDAYS.map((d) => (
          <div className="day" key={d}>
            <div className="stack" style={{ gap: 4 }}>
              <b className="small">{t(`weekday.short.${d}`)}</b>
              <button className="switch" role="switch" aria-checked={hours[d].open} aria-label={t('ob.hours.open_on', { day: t(`weekday.${d}`) })}
                onClick={() => setDay(d, { open: !hours[d].open, ranges: hours[d].ranges.length ? hours[d].ranges : [{ from: '10:00', to: '19:00' }] })} />
            </div>
            {hours[d].open ? (
              <div className="ranges">
                {hours[d].ranges.map((r, i) => (
                  <span key={i} className="row" style={{ gap: 4 }}>
                    <input type="time" aria-label={t('ob.hours.from')} value={r.from} onChange={(e) => setDay(d, { ranges: hours[d].ranges.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })} />
                    –
                    <input type="time" aria-label={t('ob.hours.to')} value={r.to} onChange={(e) => setDay(d, { ranges: hours[d].ranges.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })} />
                    {hours[d].ranges.length > 1 && <button className="icon-btn" aria-label={t('common.remove')} onClick={() => setDay(d, { ranges: hours[d].ranges.filter((_, j) => j !== i) })}>×</button>}
                  </span>
                ))}
                {hours[d].ranges.length < 2 && (
                  <button className="link-btn small" onClick={() => setDay(d, { ranges: [...hours[d].ranges, { from: '17:00', to: '21:00' }] })}>+ {t('ob.hours.add_break')}</button>
                )}
              </div>
            ) : (
              <span className="muted">{t('common.closed')}</span>
            )}
          </div>
        ))}
      </div>
      <button className="btn ghost block" onClick={() => setHours(Object.fromEntries(WEEKDAYS.map((d) => [d, d === 'sun' ? hours.sun : { ...hours.mon }])) as WeeklyHours)}>
        {t('ob.hours.copy_monday')}
      </button>
      {!valid && <p className="error">{t('ob.hours.invalid')}</p>}
      <button className="btn primary big block" disabled={busy || !valid} onClick={onNext}>{t('common.continue')}</button>
    </section>
  );
}

function StaffStep({ draft, setDraft, busy, onNext }: { draft: Draft; setDraft: (d: Draft) => void; busy: boolean; onNext: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const add = () => {
    if (!name.trim()) return;
    setDraft({ ...draft, staff: [...draft.staff, { name: name.trim() }] });
    setName('');
  };
  return (
    <section className="stack">
      <h1>{t('ob.staff.title')}</h1>
      <p className="muted">{t('ob.staff.sub')}</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className="input grow" aria-label={t('ob.staff.name')} placeholder={t('ob.staff.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={!name.trim()}>{t('common.add')}</button>
      </form>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {draft.staff.map((s, i) => (
          <button key={s.id ?? i} className="chip" aria-label={`${t('common.remove')} ${s.name}`} onClick={() => setDraft({ ...draft, staff: draft.staff.filter((_, j) => j !== i) })}>
            {s.name} ×
          </button>
        ))}
      </div>
      <button className="btn primary big block" disabled={busy} onClick={onNext}>
        {draft.staff.length || name.trim() ? t('common.continue') : t('ob.staff.just_me')}
      </button>
    </section>
  );
}

function LiveScreen({ state, busy, relaunch }: { state: any; busy: boolean; relaunch: () => void }) {
  const { t } = useI18n();
  const router = useRouter();
  if (!state.links) {
    return (
      <section className="stack">
        <h1>{t('ob.live.almost')}</h1>
        <button className="btn primary big block" disabled={busy} onClick={relaunch}>{t('ob.live.go_live')}</button>
      </section>
    );
  }
  return (
    <section className="stack">
      <div style={{ fontSize: '3rem', textAlign: 'center' }}>🎉</div>
      <h1 style={{ textAlign: 'center' }}>{t('ob.live.title')}</h1>
      <p className="muted" style={{ textAlign: 'center' }}>{t('ob.live.sub', { business: state.business.name })}</p>
      <LiveLinks links={state.links} businessName={state.business.name} />
      <button className="btn primary big block" onClick={() => router.push('/bridge')}>{t('ob.live.to_bridge')}</button>
      {state.checklist && <Checklist items={state.checklist} />}
    </section>
  );
}
