import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config, runtime } from '../config';
import { logger } from '../logger';

/**
 * Power tokens are encrypted at rest with AES-256-GCM. The key comes from
 * POWERS_ENCRYPTION_KEY (32 bytes, base64) held in a secrets manager.
 * Development falls back to a key derived from JWT_SECRET, with a warning.
 */
let warned = false;
function key(): Buffer {
  if (runtime.powersKey) {
    const k = Buffer.from(runtime.powersKey, 'base64');
    if (k.length !== 32) throw new Error('POWERS_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
    return k;
  }
  if (config.env === 'production') throw new Error('POWERS_ENCRYPTION_KEY is required in production');
  if (!warned && config.env !== 'test') {
    logger.warn('POWERS_ENCRYPTION_KEY not set; using a development key derived from JWT_SECRET', 'Powers');
    warned = true;
  }
  return createHash('sha256').update(`orbit-powers:${config.jwtSecret}`).digest();
}

export function seal(data: unknown): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]); // version | iv | tag | ciphertext
}

export function open<T = any>(blob: Buffer | null): T | null {
  if (!blob || blob.length < 30 || blob[0] !== 1) return null;
  const d = createDecipheriv('aes-256-gcm', key(), blob.subarray(1, 13));
  d.setAuthTag(blob.subarray(13, 29));
  return JSON.parse(Buffer.concat([d.update(blob.subarray(29)), d.final()]).toString('utf8'));
}
