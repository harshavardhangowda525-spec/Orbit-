import { chunks, Endpointer, fromWav, resample, toWav } from './audio';
import { callerE164 } from './voice.service';

const tone = (ms: number, amp = 6000) => {
  const pcm = Buffer.alloc((ms / 1000) * 8000 * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 3) * amp), i * 2);
  return pcm;
};
const quiet = (ms: number) => Buffer.alloc((ms / 1000) * 8000 * 2);

describe('telephone audio', () => {
  it('WAV wraps and unwraps PCM; other rates are resampled to 8 kHz', () => {
    const pcm = tone(100);
    expect(fromWav(toWav(pcm)).equals(pcm)).toBe(true);
    expect(fromWav(toWav(tone(100), 16000)).length).toBe(pcm.length / 2);
    expect(resample(tone(100), 22050, 8000).length).toBe(Math.floor((tone(100).length / 2) * 8000 / 22050) * 2);
  });

  it('chunks are multiples of 320 bytes and at least 3200', () => {
    for (const c of chunks(tone(730))) expect(c.length % 320 === 0 && c.length >= 3200).toBe(true);
  });

  it('finds one sentence after a pause, ignores clicks and background noise', () => {
    const got: Buffer[] = [];
    let starts = 0;
    const ep = new Endpointer((p) => got.push(p), () => starts++);
    ep.push(Buffer.concat([quiet(300), tone(40), quiet(800)])); // a click
    ep.push(Buffer.concat([tone(200, 200), quiet(200)])); // hiss below the threshold
    expect(got).toHaveLength(0);
    ep.push(Buffer.concat([tone(600), quiet(500)]));
    expect(got).toHaveLength(0); // still inside the pause
    ep.push(quiet(300));
    expect(got).toHaveLength(1);
    expect(starts).toBe(1); // the click was too short to count as speech
  });

  it('normalises Indian caller ids', () => {
    expect(callerE164('09876543210')).toBe('+919876543210');
    expect(callerE164('9876543210')).toBe('+919876543210');
    expect(callerE164('+91 98765 43210')).toBe('+919876543210');
    expect(callerE164('browser')).toBeNull();
  });
});
