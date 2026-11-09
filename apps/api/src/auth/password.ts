import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const LEN = 64;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;

/** scrypt$<salt>$<hash> (base64url). */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scrypt(pw, salt, LEN, PARAMS);
  return `scrypt$${salt.toString('base64url')}$${h.toString('base64url')}`;
}

/** Constant-time check. With no stored hash it still does the work, so timing does not reveal which emails exist. */
export async function checkPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  const [kind, salt, hash] = (stored ?? '').split('$');
  const ok = kind === 'scrypt' && !!salt && !!hash;
  const expected = ok ? Buffer.from(hash, 'base64url') : Buffer.alloc(LEN);
  const got = await scrypt(pw, ok ? Buffer.from(salt, 'base64url') : Buffer.alloc(16), LEN, PARAMS);
  return ok && expected.length === got.length && timingSafeEqual(expected, got);
}
