import { createHmac, randomBytes } from 'node:crypto';

/** Authenticator-app codes (RFC 6238: SHA-1, 30-second steps, 6 digits), as used by Google Authenticator. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newSecret(): string {
  const bytes = randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function decode(secret: string): Buffer {
  const clean = secret.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = '';
  for (const c of clean) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error('invalid secret');
    bits += v.toString(2).padStart(5, '0');
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / 30);

export function codeAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** The step a code matches (now, or one step either side for clock drift), or null. */
export function matchStep(secret: string, code: string, ms = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepAt(ms);
  for (const s of [now, now - 1, now + 1]) if (codeAt(secret, s) === code) return s;
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer = 'Orbit Admin') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
