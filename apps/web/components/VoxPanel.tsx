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
