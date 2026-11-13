import { createHash } from 'node:crypto';

/** SHA-256 of a visitor/share token (only hashes are stored). */
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
