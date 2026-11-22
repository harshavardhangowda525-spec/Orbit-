'use client';

import { useState } from 'react';
import type { TeachPreview } from '@orbit/shared';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useVoiceInput } from '@/lib/voice';
import { TeachCard } from './TeachCard';
import './teach.css';

/** Teach Orbit: say what changed in your own words (type or hold the mic), see it, then Save. */
export function TeachPanel({ onSaved }: { onSaved?: () => void }) {
  const { t, lang } = useI18n();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<TeachPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spoken, setSpoken] = useState(false);
  const voice = useVoiceInput(lang, (v) => { setText(v); setSpoken(true); });

  async function go(e?: React.FormEvent) {
    e?.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await api<TeachPreview>('/teach', { body: { text: text.trim(), source: spoken ? 'voice' : 'app', language: lang } }));
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack teach-panel" data-testid="teach-panel">
      <div>
        <h2 style={{ margin: 0 }}>{t('teach.title')}</h2>
        <p className="small muted" style={{ margin: '4px 0 0' }}>{t('teach.hint')}</p>
      </div>
      <form className="teach-form" onSubmit={go}>
        <textarea className="input" rows={2} value={text} onChange={(e) => { setText(e.target.value); if (!e.target.value) setSpoken(false); }} placeholder={voice.state === 'listening' ? t('voice.recording') : voice.state === 'transcribing' ? t('voice.transcribing') : t('teach.placeholder')} aria-label={t('teach.title')} data-testid="teach-input"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) go(e as any); }} />
        <div className="row" style={{ gap: 8 }}>
          {voice.supported && (
            <button type="button" className={`mic ${voice.state === 'listening' ? 'on' : ''}`} aria-label={t('cmd.hold')} onPointerDown={voice.start} onPointerUp={voice.stop} onPointerLeave={voice.stop} disabled={voice.state === 'transcribing'}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            </button>
          )}
          <button className="btn primary" disabled={busy || !text.trim()} data-testid="teach-go">{busy ? t('teach.thinking') : t('teach.go')}</button>
        </div>
      </form>
      {voice.error && <p className="error small">{voice.error === 'no_mic' ? t('voice.no_mic') : voice.error}</p>}
      {!preview && <p className="small muted">{t('teach.examples')}</p>}
      {error && <p className="error small">{error}</p>}
      {preview && <TeachCard key={preview.id} id={preview.id} initial={preview} onDone={() => { setText(''); onSaved?.(); }} />}
    </section>
  );
}
