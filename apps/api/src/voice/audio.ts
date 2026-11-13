/**
 * Telephone audio: 16-bit signed little-endian PCM, mono, 8 kHz (what Exotel
 * streams and Sarvam accepts/produces), plus a small endpointer that decides
 * when the caller has finished a sentence.
 */
export const RATE = 8000;
const FRAME = 160; // 20 ms at 8 kHz
const FRAME_BYTES = FRAME * 2;

/** RMS loudness of a PCM16 buffer (0..32767). */
export function rms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** Wrap PCM16 mono in a WAV container (Sarvam's speech-to-text takes WAV). */
export function toWav(pcm: Buffer, rate = RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** WAV -> PCM16 mono at 8 kHz (resampled if the WAV says otherwise). */
export function fromWav(wav: Buffer): Buffer {
  if (wav.toString('ascii', 0, 4) !== 'RIFF') return wav; // already raw
  let rate = RATE;
  let channels = 1;
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = wav.readUInt16LE(off + 10);
      rate = wav.readUInt32LE(off + 12);
    } else if (id === 'data') {
      let pcm = wav.subarray(off + 8, Math.min(wav.length, off + 8 + size));
      if (channels === 2) pcm = downmix(pcm);
      return rate === RATE ? Buffer.from(pcm) : resample(pcm, rate, RATE);
    }
    off += 8 + size + (size % 2);
  }
  return Buffer.alloc(0);
}

function downmix(pcm: Buffer): Buffer {
  const n = Math.floor(pcm.length / 4);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round((pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) / 2), i * 2);
  return out;
}

/** Linear-interpolation resampler (speech quality, telephone band). */
export function resample(pcm: Buffer, from: number, to: number): Buffer {
  const n = Math.floor(pcm.length / 2);
  const m = Math.floor((n * to) / from);
  const out = Buffer.alloc(m * 2);
  for (let i = 0; i < m; i++) {
    const x = (i * from) / to;
    const a = Math.floor(x);
    const b = Math.min(n - 1, a + 1);
    const t = x - a;
    out.writeInt16LE(Math.round(pcm.readInt16LE(a * 2) * (1 - t) + pcm.readInt16LE(b * 2) * t), i * 2);
  }
  return out;
}

/** Exotel wants chunks that are a multiple of 320 bytes, at least 3200. */
export function chunks(pcm: Buffer, size = 3200): Buffer[] {
  const padded = pcm.length % 320 ? Buffer.concat([pcm, Buffer.alloc(320 - (pcm.length % 320))]) : pcm;
  const out: Buffer[] = [];
  for (let i = 0; i < padded.length; i += size) {
    let c = padded.subarray(i, i + size);
    if (c.length < 3200) c = Buffer.concat([c, Buffer.alloc(3200 - c.length)]);
    out.push(c);
  }
  return out;
}

export const msOf = (pcm: Buffer) => (pcm.length / 2 / RATE) * 1000;

/**
 * Turn-taking: finds where the caller starts and stops talking. Adapts to the
 * line's background noise; a sentence ends after 700 ms of quiet (or 15 s).
 */
export class Endpointer {
  private floor = 300;
  private voiced = 0;
  private silent = 0;
  private speaking = false;
  private parts: Buffer[] = [];
  private pre: Buffer[] = [];
  private pending = Buffer.alloc(0);

  constructor(
    private readonly onUtterance: (pcm: Buffer) => void,
    private readonly onSpeechStart: () => void = () => undefined,
    private readonly o = { endSilenceMs: 700, minSpeechMs: 250, maxMs: 15_000 },
  ) {}

  get inSpeech() {
    return this.speaking;
  }

  push(pcm: Buffer) {
    let buf = this.pending.length ? Buffer.concat([this.pending, pcm]) : pcm;
    while (buf.length >= FRAME_BYTES) {
      this.frame(buf.subarray(0, FRAME_BYTES));
      buf = buf.subarray(FRAME_BYTES);
    }
    this.pending = Buffer.from(buf);
  }

  private frame(f: Buffer) {
    const level = rms(f);
    const threshold = Math.max(500, this.floor * 3);
    const loud = level > threshold;
    if (!this.speaking) {
      // Track the background level only while nobody is talking.
      this.floor = loud ? this.floor : this.floor * 0.95 + level * 0.05;
      this.pre.push(Buffer.from(f));
      if (this.pre.length > 10) this.pre.shift(); // 200 ms pre-roll
      this.voiced = loud ? this.voiced + 1 : 0;
      if (this.voiced >= 3) {
        this.speaking = true;
        this.silent = 0;
        this.parts = [...this.pre];
        this.pre = [];
        this.onSpeechStart();
      }
      return;
    }
    this.parts.push(Buffer.from(f));
    this.silent = loud ? 0 : this.silent + 1;
    const total = this.parts.length * 20;
    const speech = total - this.silent * 20;
    if ((this.silent * 20 >= this.o.endSilenceMs && speech >= this.o.minSpeechMs) || total >= this.o.maxMs) {
      const pcm = Buffer.concat(this.parts);
      this.reset();
      this.onUtterance(pcm);
    } else if (this.silent * 20 >= this.o.endSilenceMs) {
      this.reset(); // a cough or click, not speech
    }
  }

  reset() {
    this.speaking = false;
    this.parts = [];
    this.voiced = 0;
    this.silent = 0;
  }
}
