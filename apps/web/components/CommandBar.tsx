'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import type { Sentence } from '@orbit/shared';
import { apiStream, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useCycle } from '@/lib/motion';

const SPEECH_LANG: Record<string, string> = { en: 'en-IN', hi: 'hi-IN', kn: 'kn-IN' };

export type OrbitScreen = 'today' | 'crew' | 'people' | 'money' | 'powers' | 'details' | 'inbox' | 'conversation';
type Turn = { role: 'owner' | 'orbit'; text: string };

/**
 * One conversation shared by every Command Bar on the page, so when Orbit opens
 * another screen (and that screen's bar mounts), the answer keeps arriving there.
 */
type ChatState = { asked: string | null; steps: Sentence[]; reply: string | null; error: Sentence | string | null; busy: boolean };
let chat: ChatState = { asked: null, steps: [], reply: null, error: null, busy: false };
let history: Turn[] = [];
const listeners = new Set<() => void>();
const setChat = (patch: Partial<ChatState> | ((c: ChatState) => Partial<ChatState>)) => {
  chat = { ...chat, ...(typeof patch === 'function' ? patch(chat) : patch) };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const useChat = () => useSyncExternalStore(subscribe, () => chat, () => chat);

/**
 * Ask Orbit anything. The answer comes from the business's AI model; each step
 * ("Checking the schedule", "Opening People") shows as it happens, and screens open
 * in front of the owner. If the owner has left the page, nothing jumps around: the
 * work still finishes on the server and appears in the Feed.
 * Placeholder hints cycle every 2.6s; hold the mic to speak.
 */
export function CommandBar({ suggestions, onDone, onOpen, running = true }: { suggestions: string[]; onDone: () => void; onOpen?: (screen: OrbitScreen, id?: string) => void; running?: boolean }) {
  const { t, ts, lang } = useI18n();
  const [text, setText] = useState('');
  const { asked, steps, reply, error, busy } = useChat();
  const [listening, setListening] = useState(false);
  const rec = useRef<any>(null);
  const hints = ['cmd.placeholder', ...suggestions.map((s) => `@${s}`)];
  const i = useCycle(hints.length, 2600, running && !text);
  const hint = hints[i].startsWith('@') ? t('cmd.try', { example: t(hints[i].slice(1)) }) : t(hints[i]);
  const SR = typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : null;

  async function send(value: string) {
    const q = value.trim();
    if (!q || chat.busy) return;
    setChat({ asked: q, steps: [], reply: null, error: null, busy: true });
    setText('');
    try {
      await apiStream('/bridge/commands', { text: q, history: history.slice(-10), language: lang }, (e) => {
        if (e.type === 'step') setChat((c) => ({ steps: [...c.steps, e.label as Sentence] }));
        // Only move the screen while the owner is looking at it.
        else if (e.type === 'open' && document.visibilityState === 'visible') onOpen?.(e.screen, e.id);
        else if (e.type === 'reply') {
          setChat({ reply: e.text });
          history = [...history, { role: 'owner' as const, text: q }, { role: 'orbit' as const, text: e.text }].slice(-12);
        } else if (e.type === 'error') setChat({ error: e.message as Sentence });
      });
      onDone();
    } catch (e) {
      setChat({ error: (e as ApiError).message });
    } finally {
      setChat({ busy: false });
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
      {asked && (
        <div className="reply" role="status" aria-live="polite" data-testid="orbit-reply">
          <div className="grow">
            <div className="asked">{asked}</div>
            {steps.length > 0 && (
              <ul className="steps">
                {steps.map((s, i) => (
                  <li key={i} className={busy && i === steps.length - 1 ? 'now' : 'done'}>{ts(s)}</li>
                ))}
              </ul>
            )}
            {busy && !steps.length && <div className="thinking">{t('assistant.thinking')}</div>}
            {reply && <div className="answer">{reply}</div>}
            {error && <div className="answer">{typeof error === 'string' ? error : ts(error)}</div>}
          </div>
          <button className="link-btn" style={{ minHeight: 24, padding: 0 }} aria-label={t('common.close')} onClick={() => setChat({ asked: null, reply: null, error: null, steps: [] })}>×</button>
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
