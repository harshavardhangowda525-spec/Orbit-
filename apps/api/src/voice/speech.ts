import { fromWav, RATE, toWav } from './audio';

/** Hearing and speaking: Sarvam AI in production, a scripted stand-in for tests and demos. */
export interface SpeechProvider {
  readonly name: string;
  /** PCM16 8 kHz -> text and the language heard (e.g. "hi"). */
  transcribe(pcm: Buffer): Promise<{ text: string; language: string | null }>;
  /** Text -> PCM16 8 kHz in the given language ("en", "hi", "kn"). */
  speak(text: string, language: string): Promise<Buffer>;
}

export class SpeechError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const LANG: Record<string, string> = { en: 'en-IN', hi: 'hi-IN', kn: 'kn-IN', ta: 'ta-IN', te: 'te-IN', ml: 'ml-IN', mr: 'mr-IN', bn: 'bn-IN', gu: 'gu-IN', pa: 'pa-IN', od: 'od-IN' };

export class SarvamSpeech implements SpeechProvider {
  readonly name = 'sarvam';
  constructor(private readonly key: string) {}

  async transcribe(pcm: Buffer) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(toWav(pcm))], { type: 'audio/wav' }), 'utterance.wav');
    form.append('model', process.env.SARVAM_STT_MODEL || 'saaras:v4');
    form.append('mode', 'transcribe');
    const res = await fetch('https://api.sarvam.ai/speech-to-text', { method: 'POST', headers: { 'api-subscription-key': this.key }, body: form, signal: AbortSignal.timeout(15_000) });
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new SpeechError(res.status, d?.error?.message ?? d?.message ?? `Speech-to-text error ${res.status}`);
    return { text: String(d.transcript ?? '').trim(), language: d.language_code ? String(d.language_code).split('-')[0] : null };
  }

  async speak(text: string, language: string) {
    const res = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: { 'api-subscription-key': this.key, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: text.slice(0, 1500),
        language_code: LANG[language] ?? 'en-IN',
        model: process.env.SARVAM_TTS_MODEL || 'bulbul:v4-flash',
        ...(process.env.SARVAM_TTS_SPEAKER ? { speaker: process.env.SARVAM_TTS_SPEAKER } : {}),
        speech_sample_rate: RATE,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const d: any = await res.json().catch(() => ({}));
    if (!res.ok || !d.audios?.length) throw new SpeechError(res.status || 502, d?.error?.message ?? d?.message ?? `Text-to-speech error ${res.status}`);
    return fromWav(Buffer.from((d.audios as string[]).join(''), 'base64'));
  }
}

/**
 * Scripted speech for tests and offline demos: hears the next queued line,
 * "speaks" a short tone so playback, marks and barge-in can be exercised.
 */
export class FakeSpeech implements SpeechProvider {
  readonly name = 'fake';
  heard: string[] = [];
  spoken: { text: string; language: string }[] = [];

  async transcribe() {
    const text = this.heard.shift() ?? '';
    return { text, language: /[ऀ-ॿ]/.test(text) ? 'hi' : /[ಀ-೿]/.test(text) ? 'kn' : 'en' };
  }

  async speak(text: string, language: string) {
    this.spoken.push({ text, language });
    const ms = Math.min(2000, 200 + text.length * 10);
    const pcm = Buffer.alloc(Math.round((ms / 1000) * RATE) * 2);
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 1000), i * 2);
    return pcm;
  }
}

/** SPEECH_PROVIDER=fake, or Sarvam when SARVAM_API_KEY is set; null when phone calls cannot be answered. */
export function speechFromEnv(): SpeechProvider | null {
  if (process.env.SPEECH_PROVIDER === 'fake') return new FakeSpeech();
  return process.env.SARVAM_API_KEY ? new SarvamSpeech(process.env.SARVAM_API_KEY) : null;
}
