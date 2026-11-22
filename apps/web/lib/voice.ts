'use client';

import { useRef, useState } from 'react';
import { apiUpload, ApiError } from './api';

const SPEECH_LANG: Record<string, string> = { en: 'en-IN', hi: 'hi-IN', kn: 'kn-IN' };

/**
 * Speak instead of typing. Uses the browser's own speech recognition where it
 * exists (Chrome, Android); otherwise records a short clip and Orbit writes it
 * down (Safari, iPhone, Firefox). Press and hold to talk.
 */
export function useVoiceInput(lang: string, onText: (text: string, final: boolean) => void) {
  const [state, setState] = useState<'idle' | 'listening' | 'transcribing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<any>(null);
  const SR = typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : null;
  const canRecord = typeof window !== 'undefined' && typeof (window as any).MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const supported = !!SR || canRecord;

  async function start() {
    if (state !== 'idle') return;
    setError(null);
    if (SR) {
      const r = new SR();
      r.lang = SPEECH_LANG[lang] ?? 'en-IN';
      r.interimResults = true;
      r.onresult = (e: any) => onText(Array.from(e.results).map((x: any) => x[0].transcript).join(' '), false);
      r.onend = () => setState('idle');
      rec.current = r;
      setState('listening');
      r.start();
      return;
    }
    if (!canRecord) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => (window as any).MediaRecorder.isTypeSupported?.(t)) ?? '';
      const mr = new (window as any).MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e: any) => e.data.size && chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: (mr.mimeType || type || 'audio/webm').split(';')[0] });
        if (!blob.size) return setState('idle');
        setState('transcribing');
        try {
          const r = await apiUpload<{ text: string }>('/voice/transcribe', [blob], [`voice.${blob.type.includes('mp4') ? 'm4a' : blob.type.split('/')[1]}`], 'audio');
          onText(r.text, true);
        } catch (e) {
          setError((e as ApiError).message);
        } finally {
          setState('idle');
        }
      };
      rec.current = mr;
      setState('listening');
      mr.start();
    } catch {
      setError('no_mic');
      setState('idle');
    }
  }

  function stop() {
    if (state === 'listening') rec.current?.stop();
  }

  return { state, start, stop, supported, error };
}
