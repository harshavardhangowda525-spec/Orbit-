'use client';

import { useRef, useState } from 'react';
import type { Sentence } from '@orbit/shared';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useCycle } from '@/lib/motion';

const SPEECH_LANG: Record<string, string> = { en: 'en-IN', hi: 'hi-IN', kn: 'kn-IN' };

/** One input for questions and commands. Placeholder hints cycle every 2.6s; hold the mic to speak. */
export function CommandBar({ suggestions, onDone, running = true }: { suggestions: string[]; onDone: () => void; running?: boolean }) {
  const { t, ts, lang } = useI18n();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const rec = useRef<any>(null);
  const hints = ['cmd.placeholder', ...suggestions.map((s) => `@${s}`)];
  const i = useCycle(hints.length, 2600, running && !text);
  const hint = hints[i].startsWith('@') ? t('cmd.try', { example: t(hints[i].slice(1)) }) : t(hints[i]);
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
    <div className="cmd" data-testid="command-bar">
      {reply && (
        <div className="reply" role="status">
          <span className="grow">{reply}</span>
          <button className="link-btn" style={{ minHeight: 24, padding: 0 }} aria-label={t('common.close')} onClick={() => setReply(null)}>×</button>
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input
          key={text ? 'typing' : `hint-${i}`}
          className={text ? '' : 'hint-fade'}
          aria-label={t('cmd.placeholder')}
          placeholder={listening ? t('cmd.listening') : hint}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
        {text.trim() ? (
          <button className="send" disabled={busy} aria-label={t('cmd.send')}>➤</button>
        ) : (
          <button
            type="button"
            className={`mic ${listening ? 'on' : ''}`}
            aria-label={t('cmd.hold')}
            onPointerDown={startListening}
            onPointerUp={() => rec.current?.stop()}
            onPointerLeave={() => rec.current?.stop()}
            disabled={!SR}
            title={SR ? t('cmd.hold') : t('cmd.no_voice')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </form>
    </div>
  );
}
