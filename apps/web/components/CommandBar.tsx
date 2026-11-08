'use client';

import { useRef, useState } from 'react';
import type { Sentence } from '@orbit/shared';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

const SPEECH_LANG: Record<string, string> = { en: 'en-IN', hi: 'hi-IN', kn: 'kn-IN' };

/** One input for questions and commands. Type, or hold the mic to speak. */
export function CommandBar({ suggestions, onDone }: { suggestions: string[]; onDone: () => void }) {
  const { t, ts, lang } = useI18n();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const rec = useRef<any>(null);
  const SR = typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : null;

  async function send(value: string) {
    if (!value.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ reply: Sentence }>('/bridge/commands', { body: { text: value.trim() } });
      setReply(ts(r.reply));
      setText('');
      onDone();
    } catch (e) {
      setReply((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  function startListening() {
    if (!SR || listening) return;
    const r = new SR();
    r.lang = SPEECH_LANG[lang] ?? 'en-IN';
    r.interimResults = true;
    r.onresult = (e: any) => setText(Array.from(e.results).map((x: any) => x[0].transcript).join(' '));
    r.onend = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  }

  return (
    <div className="cmdbar">
      <div className="inner">
        {reply && (
          <div className="note reply small row between" role="status">
            <span>{reply}</span>
            <button className="link-btn" aria-label={t('common.close')} onClick={() => setReply(null)}>×</button>
          </div>
        )}
        {!text && (
          <div className="sugs">
            {suggestions.map((s) => (
              <button key={s} className="chip" onClick={() => setText(t(s))}>{t(s)}</button>
            ))}
          </div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); send(text); }}>
          <input className="input grow" aria-label={t('cmd.placeholder')} placeholder={listening ? t('cmd.listening') : t('cmd.placeholder')} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
          {SR && (
            <button type="button" className={`mic ${listening ? 'on' : ''}`} aria-label={t('cmd.hold')}
              onPointerDown={startListening} onPointerUp={() => rec.current?.stop()} onPointerLeave={() => rec.current?.stop()}>
              🎙️
            </button>
          )}
          <button className="btn primary" disabled={busy || !text.trim()} aria-label={t('cmd.send')}>➤</button>
        </form>
      </div>
    </div>
  );
}
