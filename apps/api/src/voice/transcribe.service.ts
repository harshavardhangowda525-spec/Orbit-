import { Controller, Global, Injectable, Module, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentTenant, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { badRequest } from '../common/errors';
import { logger } from '../logger';

export interface Transcript {
  text: string;
  /** "en", "hi", "kn"… as heard. */
  language: string | null;
  /** 0–1 when the model reports it (Whisper); null when it does not (then it is trusted). */
  confidence: number | null;
  provider: string;
}

/** Below this, Aria asks a short question to check before acting on what she heard. */
export const LOW_CONFIDENCE = 0.6;

const EXT: Record<string, string> = { 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav' };
const scriptLang = (t: string) => (/[ऀ-ॿ]/.test(t) ? 'hi' : /[ಀ-೿]/.test(t) ? 'kn' : null);

/**
 * Voice notes to text: Sarvam (Indian languages) when SARVAM_API_KEY is set,
 * otherwise Groq Whisper. TRANSCRIBE_PROVIDER=fake (tests, demos) hears queued lines.
 */
@Injectable()
export class TranscribeService {
  /** Tests: queued results, consumed in order. */
  readonly fake = process.env.TRANSCRIBE_PROVIDER === 'fake' || process.env.AI_PROVIDER === 'fake' ? { queue: [] as Partial<Transcript>[] } : null;

  get available() {
    return !!(this.fake || process.env.SARVAM_API_KEY || process.env.GROQ_API_KEY);
  }

  async transcribe(data: Buffer, mime: string): Promise<Transcript | null> {
    const m = mime.split(';')[0].trim().toLowerCase();
    if (this.fake) {
      const next = this.fake.queue.shift();
      const text = next?.text ?? 'Hi, is there a slot tomorrow evening?';
      if (!text) return null;
      return { text, language: next?.language ?? scriptLang(text) ?? 'en', confidence: next?.confidence === undefined ? 0.92 : next.confidence, provider: 'fake' };
    }
    const file = new Blob([new Uint8Array(data)], { type: m });
    const name = `voice.${EXT[m] ?? 'ogg'}`;
    if (process.env.SARVAM_API_KEY) {
      try {
        const form = new FormData();
        form.append('file', file, name);
        form.append('model', process.env.SARVAM_STT_MODEL || 'saaras:v4');
        form.append('mode', 'transcribe');
        const res = await fetch('https://api.sarvam.ai/speech-to-text', { method: 'POST', headers: { 'api-subscription-key': process.env.SARVAM_API_KEY }, body: form, signal: AbortSignal.timeout(30_000) });
        const d: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d?.error?.message ?? `Sarvam ${res.status}`);
        const text = String(d.transcript ?? '').trim();
        if (text) return { text, language: d.language_code ? String(d.language_code).split('-')[0] : scriptLang(text), confidence: null, provider: 'sarvam' };
      } catch (e) {
        logger.warn(`Sarvam transcription failed: ${(e as Error).message}`, 'Voice');
      }
    }
    if (process.env.GROQ_API_KEY) {
      try {
        const form = new FormData();
        form.append('file', file, name);
        form.append('model', process.env.GROQ_STT_MODEL || 'whisper-large-v3');
        form.append('response_format', 'verbose_json');
        const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: form, signal: AbortSignal.timeout(30_000) });
        const d: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d?.error?.message ?? `Groq ${res.status}`);
        const text = String(d.text ?? '').trim();
        const segs: any[] = Array.isArray(d.segments) ? d.segments : [];
        // Whisper: average log-probability per segment → 0–1; long silence lowers it.
        const conf = segs.length
          ? segs.reduce((a, s) => a + Math.exp(Number(s.avg_logprob ?? -1)) * (1 - Math.min(1, Number(s.no_speech_prob ?? 0))), 0) / segs.length
          : null;
        const lang = { english: 'en', hindi: 'hi', kannada: 'kn' }[String(d.language ?? '').toLowerCase()] ?? (d.language?.length === 2 ? d.language : scriptLang(text));
        if (text) return { text, language: lang ?? null, confidence: conf == null ? null : Math.round(conf * 100) / 100, provider: 'groq' };
      } catch (e) {
        logger.warn(`Groq transcription failed: ${(e as Error).message}`, 'Voice');
      }
    }
    return null;
  }
}

/** The owner speaks to Ask Orbit / Teach on a phone without built-in speech recognition. */
@UseGuards(TenantGuard)
@Controller('voice')
export class TranscribeController {
  constructor(private readonly stt: TranscribeService) {}

  @Post('transcribe')
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async transcribe(@CurrentTenant() _t: Tenant, @UploadedFile() f: any) {
    if (!f?.buffer?.length) throw badRequest('no_audio', 'Nothing was recorded. Please try again.');
    if (!String(f.mimetype).startsWith('audio/')) throw badRequest('file_type', 'Please send a voice recording.');
    const r = await this.stt.transcribe(f.buffer, f.mimetype);
    if (!r) throw badRequest('not_heard', 'Orbit could not hear that. Please try again or type it.');
    return r;
  }
}

@Global()
@Module({ controllers: [TranscribeController], providers: [TranscribeService], exports: [TranscribeService] })
export class TranscribeModule {}
