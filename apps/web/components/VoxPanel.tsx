'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiUrl, ApiError, session } from '@/lib/api';
import { socketUrl } from '@/lib/live';
import { useI18n } from '@/lib/i18n';

interface VoiceStatus {
  speechReady: boolean;
  onPlan: boolean;
  vox: { name: string; enabled: boolean };
  minutes: { used: number; cap: number | null; overage: string };
  exotel: { account: string; exophone: string; outbound: boolean; streamPath: string | null } | null;
  calls: { id: string; direction: string; purpose: string; status: string; from_number: string | null; to_number: string | null; duration_sec: number | null; outcome: string | null; started_at: string; customer: string | null }[];
}

/** The Voicebot stream address for Exotel (wss://<api>/voice/exotel/<key>). */
function streamUrl(path: string) {
  const base = apiUrl().startsWith('/') ? `${location.protocol}//${location.host}${apiUrl()}` : apiUrl();
  return `${base.replace(/^http/, 'ws')}${path}`;
}

/** Vox (phone): connect Exotel, try Vox in the browser or on your phone, recent calls. */
export function VoxPanel({ onChange }: { onChange: () => void }) {
  const { t } = useI18n();
  const [s, setS] = useState<VoiceStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => api<VoiceStatus>('/voice').then(setS).catch((e) => setErr((e as ApiError).message)), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!s) return <p className="small muted">{err ?? t('common.loading')}</p>;
  const ready = s.speechReady && s.onPlan && s.vox.enabled;
  return (
    <div className="vox-panel stack" data-testid="vox-panel">
      {!s.speechReady && <p className="note small">{t('vox.no_speech')}</p>}
      {s.speechReady && !s.onPlan && <p className="note small">{t('vox.not_on_plan')}</p>}
      {s.speechReady && s.onPlan && !s.vox.enabled && <p className="note small">{t('vox.off', { name: s.vox.name })}</p>}
      {s.onPlan && (
        <div className="small muted">
          {s.minutes.cap == null ? t('vox.minutes_unlimited', { used: s.minutes.used }) : t('vox.minutes', { used: s.minutes.used, cap: s.minutes.cap })}
        </div>
      )}
      {ready && <BrowserCall name={s.vox.name} onEnd={load} />}

      {s.exotel && !editing ? (
        <div className="stack">
          <div className="small"><b>{t('vox.line')}</b> {s.exotel.exophone}</div>
          {s.exotel.streamPath && <CopyLine label={t('vox.stream_url')} value={streamUrl(s.exotel.streamPath)} hint={t('vox.stream_hint')} />}
          {ready && s.exotel.outbound && <PhoneTest onDone={load} />}
          {!s.exotel.outbound && <p className="small muted">{t('vox.no_flow')}</p>}
          <button className="link-btn small advanced" onClick={() => setEditing(true)}>{t('vox.change')}</button>
        </div>
      ) : s.onPlan ? (
        <ExotelForm onDone={() => { setEditing(false); load(); onChange(); }} onCancel={s.exotel ? () => setEditing(false) : undefined} />
      ) : null}

      <SarvamAgentSetup />

      {s.calls.length > 0 && (
        <div className="stack">
          <h4 className="small muted">{t('vox.recent')}</h4>
          {s.calls.map((c) => (
            <div key={c.id} className="usage-row small" data-call={c.id}>
              <span>
                {c.purpose === 'test' ? t('vox.test_call') : c.customer ?? (c.direction === 'in' ? c.from_number : c.to_number) ?? '—'}
                {' · '}
                {new Date(c.started_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
              </span>
              <b>{c.duration_sec != null ? `${Math.floor(c.duration_sec / 60)}:${String(c.duration_sec % 60).padStart(2, '0')}` : t(`vox.status.${c.status}`)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CopyLine({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <label className="field">
      <span>{label}</span>
      <div className="row">
        <input className="input grow" readOnly value={value} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn small" onClick={() => navigator.clipboard?.writeText(value).then(() => setCopied(true))}>{copied ? t('common.copied') : t('common.copy')}</button>
      </div>
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

function ExotelForm({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const { t } = useI18n();
  const [v, setV] = useState<Record<string, string>>({ region: 'in' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fields: { key: string; secret?: boolean; optional?: boolean }[] = [
    { key: 'exophone' },
    { key: 'accountSid' },
    { key: 'apiKey', secret: true },
    { key: 'apiToken', secret: true },
    { key: 'appId', optional: true },
  ];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/voice/exotel/connect', { body: v });
      onDone();
    } catch (x) {
      setErr((x as ApiError).message);
      setBusy(false);
    }
  };
  return (
    <form className="meta-form stack" onSubmit={submit} data-testid="connect-exotel">
      <details className="meta-help">
        <summary>{t('meta.help.title')}</summary>
        <ol>{t('vox.help').split('\n').map((line, i) => <li key={i}>{line}</li>)}</ol>
      </details>
      {fields.map((f) => (
        <label key={f.key} className="field">
          <span>{t(`vox.f.${f.key}`)}{f.optional ? ` (${t('common.optional')})` : ''}</span>
          <input className="input" type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} value={v[f.key] ?? ''} required={!f.optional}
            onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
          <small className="muted">{t(`vox.h.${f.key}`)}</small>
        </label>
      ))}
      <label className="field">
        <span>{t('vox.f.region')}</span>
        <select className="input" value={v.region} onChange={(e) => setV({ ...v, region: e.target.value })}>
          <option value="in">{t('vox.region.in')}</option>
          <option value="sg">{t('vox.region.sg')}</option>
        </select>
      </label>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy}>{busy ? t('common.wait') : t('powers.connect')}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>{t('meta.cancel')}</button>}
      </div>
    </form>
  );
}

function PhoneTest({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [phone, setPhone] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const call = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api('/voice/test-call', { body: { phone } });
      setMsg(t('vox.ringing'));
      setTimeout(onDone, 20_000);
    } catch (e) {
      setMsg((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <label className="field">
        <span>{t('vox.call_me')}</span>
        <div className="row">
          <input className="input grow" type="tel" inputMode="tel" placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button type="button" className="btn small" disabled={busy || phone.replace(/\D/g, '').length < 10} onClick={call}>{busy ? t('common.wait') : t('vox.call_me_btn')}</button>
        </div>
      </label>
      {msg && <p className="small muted">{msg}</p>}
    </div>
  );
}

/**
 * Talk to Vox from the browser: microphone -> 8 kHz PCM over a WebSocket,
 * Vox's voice back the same way. Half-duplex (the mic pauses while Vox talks)
 * so laptop speakers do not echo into the call.
 */
function BrowserCall({ name, onEnd }: { name: string; onEnd: () => void }) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'connecting' | 'live'>('idle');
  const [lines, setLines] = useState<{ who: 'you' | 'vox'; text: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<{ ws: WebSocket; ctx: AudioContext; stream: MediaStream; node: ScriptProcessorNode; playhead: number; sources: AudioBufferSourceNode[] } | null>(null);

  const stop = useCallback(() => {
    const r = ref.current;
    ref.current = null;
    if (r) {
      try {
        if (r.ws.readyState === WebSocket.OPEN) r.ws.send('{"type":"hangup"}');
        r.ws.close();
      } catch {}
      r.node.disconnect();
      r.stream.getTracks().forEach((tr) => tr.stop());
      r.ctx.close().catch(() => undefined);
    }
    setState('idle');
  }, []);
  useEffect(() => stop, [stop]);

  const start = async () => {
    setErr(null);
    setLines([]);
    setState('connecting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    } catch {
      setErr(t('vox.mic_denied'));
      setState('idle');
      return;
    }
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const ws = new WebSocket(socketUrl('/voice/web', `token=${encodeURIComponent(session.token() ?? '')}&business=${session.businessId() ?? ''}`));
    ws.binaryType = 'arraybuffer';
    const r = { ws, ctx, stream, node, playhead: 0, sources: [] as AudioBufferSourceNode[] };
    ref.current = r;
    const ratio = ctx.sampleRate / 8000;
    node.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN || ctx.currentTime < r.playhead + 0.25) return; // Vox is talking
      const input = e.inputBuffer.getChannelData(0);
      const n = Math.floor(input.length / ratio);
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        // Average the samples that fold into one 8 kHz sample (cheap low-pass).
        let sum = 0;
        let c = 0;
        for (let j = Math.floor(i * ratio); j < Math.floor((i + 1) * ratio); j++) {
          sum += input[j];
          c++;
        }
        out[i] = Math.max(-32768, Math.min(32767, Math.round((sum / Math.max(1, c)) * 32767)));
      }
      ws.send(out.buffer);
    };
    src.connect(node);
    node.connect(ctx.destination); // ScriptProcessor only runs when connected; it outputs silence.
    ws.onopen = () => setState('live');
    ws.onmessage = (m) => {
      if (typeof m.data !== 'string') {
        const pcm = new Int16Array(m.data as ArrayBuffer);
        const buf = ctx.createBuffer(1, pcm.length, 8000);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.connect(ctx.destination);
        const at = Math.max(ctx.currentTime + 0.05, r.playhead);
        s.start(at);
        r.playhead = at + buf.duration;
        r.sources.push(s);
        s.onended = () => (r.sources = r.sources.filter((x) => x !== s));
        return;
      }
      try {
        const e = JSON.parse(m.data);
        if (e.type === 'heard') setLines((l) => [...l, { who: 'you', text: e.text }]);
        else if (e.type === 'said') setLines((l) => [...l, { who: 'vox', text: e.text }]);
        else if (e.type === 'clear') {
          r.sources.forEach((x) => x.stop());
          r.playhead = 0;
        } else if (e.type === 'error') setErr(e.message);
        else if (e.type === 'end') setTimeout(() => { stop(); onEnd(); }, Math.max(0, (r.playhead - ctx.currentTime) * 1000) + 200);
      } catch {}
    };
    ws.onclose = (e) => {
      if (ref.current?.ws === ws) {
        if (e.code === 4401) setErr(t('vox.unauthorized'));
        stop();
        onEnd();
      }
    };
  };

  return (
    <div className="card stack vox-try" data-testid="vox-try">
      <div className="row">
        <div className="grow">
          <b>{t('vox.try_title', { name })}</b>
          <div className="small muted">{t('vox.try_sub')}</div>
        </div>
        {state === 'idle' ? (
          <button className="btn primary small" onClick={start}>{t('vox.try_btn')}</button>
        ) : (
          <button className="btn small" onClick={stop}>{state === 'connecting' ? t('common.wait') : t('vox.hang_up')}</button>
        )}
      </div>
      {state === 'live' && <div className="small vox-live"><span className="dot" /> {t('vox.live')}</div>}
      {lines.length > 0 && (
        <div className="stack small vox-lines">
          {lines.map((l, i) => <div key={i} className={l.who}><b>{l.who === 'vox' ? name : t('vox.you')}:</b> {l.text}</div>)}
        </div>
      )}
      {err && <p className="error small">{err}</p>}
    </div>
  );
}

/** What Sarvam's agent needs, tool by tool: what it does, when it runs, and an example request to paste. */
const SARVAM_TOOLS: { name: string; path: string; when: 'start' | 'during' | 'end'; description: string; body: Record<string, unknown> }[] = [
  {
    name: 'get_business_info', path: 'info', when: 'start',
    description: "Loads the business's services with prices, opening hours, team, and whether the caller is an existing customer (their name and upcoming bookings). Use these facts; never guess prices or hours.",
    body: {},
  },
  {
    name: 'check_availability', path: 'availability', when: 'during',
    description: 'Finds real free appointment times. Send the service the caller wants (in their words), optionally the date (YYYY-MM-DD) and a staff name. Offer at most three of the returned times. Only these times can be booked.',
    body: { service: 'haircut', date: '2026-11-20', staff: '' },
  },
  {
    name: 'book_appointment', path: 'book', when: 'during',
    description: 'Books the time the caller chose. Send the service, the exact "start" value from check_availability, and the caller\'s name. Phone is optional (the calling number is used). Call only after the caller confirms.',
    body: { service: 'haircut', start: '2026-11-20T10:30:00.000Z', name: 'Riya Sharma', phone: '', staff: '' },
  },
  {
    name: 'find_my_bookings', path: 'my-bookings', when: 'during',
    description: "Lists the caller's upcoming bookings with their booking_id. Use before rescheduling or cancelling. Send a phone number only if they booked with a different number.",
    body: { phone: '' },
  },
  {
    name: 'reschedule_appointment', path: 'reschedule', when: 'during',
    description: 'Moves one of the caller\'s bookings (booking_id from find_my_bookings) to a new time (the exact "start" from check_availability).',
    body: { booking_id: '00000000-0000-0000-0000-000000000000', start: '2026-11-21T11:00:00.000Z' },
  },
  {
    name: 'cancel_appointment', path: 'cancel', when: 'during',
    description: "Cancels one of the caller's bookings (booking_id from find_my_bookings) after they confirm.",
    body: { booking_id: '00000000-0000-0000-0000-000000000000' },
  },
  {
    name: 'take_message', path: 'message', when: 'during',
    description: 'Leaves a message for the team (callback requests, bridal or group enquiries, complaints, anything you cannot handle). Send the caller\'s name and the message.',
    body: { name: 'Riya', message: 'Wants a quote for a bridal package in December', phone: '' },
  },
  {
    name: 'call_ended', path: 'call-ended', when: 'end',
    description: 'Sends the finished call to Orbit so it appears in the inbox and the Crew feed.',
    body: { transcript: 'User: ...\nAgent: ...', call_length: '95', summary: '' },
  },
];

function apiBase() {
  return apiUrl().startsWith('/') ? `${location.protocol}//${location.host}${apiUrl()}` : apiUrl();
}

function curlFor(tool: (typeof SARVAM_TOOLS)[number]) {
  const body = { call_id: 'INTERACTION_ID', caller: 'USER_IDENTIFIER', ...tool.body };
  return `curl -X POST '${apiBase()}/integrations/sarvam/${tool.path}' \\\n  -H 'Authorization: Bearer YOUR_ORBIT_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(body)}'`;
}

const SARVAM_PROMPT = `USING ORBIT (the business's booking system)
- At the start of the call you get the business facts from get_business_info. If the caller is a known customer, greet them by name.
- Before offering any time, call check_availability. Offer at most three of the times it returns, said naturally. Never offer a time it did not return.
- To book: confirm the service, the time and the caller's name, then call book_appointment with the exact "start" value. Say a confirmation message will follow.
- To move or cancel: call find_my_bookings, confirm which booking, then reschedule_appointment (after check_availability) or cancel_appointment.
- If a tool says ok: false, explain briefly and offer another time or to take a message.
- For callbacks, bridal or group enquiries, complaints, or anything you cannot do: call take_message, then tell the caller the team will call back.`;

/** Connect a voice agent built on Sarvam's platform: an Orbit key plus the tools to paste into Sarvam. */
export function SarvamAgentSetup() {
  const { t } = useI18n();
  const [st, setSt] = useState<{ connected: boolean; lastUsed: string | null } | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api<any>('/voice/sarvam').then(setSt).catch((e) => setErr((e as ApiError).message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const create = async () => {
    if (st?.connected && !confirm(t('sarvam.replace_confirm'))) return;
    setBusy(true);
    setErr(null);
    try {
      setKey((await api<{ key: string }>('/voice/sarvam/key', { body: {} })).key);
      load();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (!confirm(t('sarvam.revoke_confirm'))) return;
    await api('/voice/sarvam/key', { method: 'DELETE' }).catch((e) => setErr((e as ApiError).message));
    setKey(null);
    load();
  };
  const whenLabel = { start: t('sarvam.when.start'), during: t('sarvam.when.during'), end: t('sarvam.when.end') };
  return (
    <div className="card stack" data-testid="sarvam-setup">
      <div>
        <b>{t('sarvam.title')}</b>
        <div className="small muted">{t('sarvam.sub')}</div>
      </div>
      {st?.connected && <div className="small">{t('sarvam.connected')}{st.lastUsed ? ` · ${t('sarvam.last_used', { when: new Date(st.lastUsed).toLocaleString() })}` : ''}</div>}

      <h4 className="small muted">{t('sarvam.step1')}</h4>
      {key ? (
        <>
          <CopyLine label={t('sarvam.your_key')} value={key} hint={t('sarvam.key_once')} />
        </>
      ) : (
        <div className="row">
          <button className="btn primary small" disabled={busy} onClick={create}>{busy ? t('common.wait') : st?.connected ? t('sarvam.new_key') : t('sarvam.create_key')}</button>
          {st?.connected && <button className="link-btn small" onClick={revoke}>{t('sarvam.revoke')}</button>}
        </div>
      )}

      <h4 className="small muted">{t('sarvam.step2')}</h4>
      <p className="small muted">{t('sarvam.tools_hint')}</p>
      {SARVAM_TOOLS.map((tool) => (
        <details key={tool.name} className="meta-help sarvam-tool">
          <summary><b>{tool.name}</b> · <span className="muted">{whenLabel[tool.when]}</span></summary>
          <div className="stack">
            <CopyLine label={t('sarvam.tool_name')} value={tool.name} />
            <CopyLine label={t('sarvam.tool_desc')} value={tool.description} />
            <label className="field">
              <span>{t('sarvam.curl')}</span>
              <textarea className="input mono" readOnly rows={6} value={curlFor(tool)} onFocus={(e) => e.target.select()} />
              <CopyBtn value={curlFor(tool)} />
            </label>
            <small className="muted">{tool.when === 'end' ? t('sarvam.vars_end') : t('sarvam.vars')}</small>
          </div>
        </details>
      ))}

      <h4 className="small muted">{t('sarvam.step3')}</h4>
      <label className="field">
        <span>{t('sarvam.prompt')}</span>
        <textarea className="input" readOnly rows={8} value={SARVAM_PROMPT} onFocus={(e) => e.target.select()} />
        <CopyBtn value={SARVAM_PROMPT} />
      </label>
      {err && <p className="error small">{err}</p>}
    </div>
  );
}

function CopyBtn({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => navigator.clipboard?.writeText(value).then(() => setCopied(true))}>{copied ? t('common.copied') : t('common.copy')}</button>;
}
