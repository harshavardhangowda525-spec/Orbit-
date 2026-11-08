import { Injectable } from '@nestjs/common';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Sends sign-in codes by email when Orbit runs its own sign-in (local development).
 * Hosted deployments use Supabase Auth, which sends the codes itself.
 */
export interface CodeMailer {
  sendCode(email: string, code: string): Promise<void>;
}

@Injectable()
export class DevCodeMailer implements CodeMailer {
  async sendCode(email: string, code: string) {
    const [name, domain] = email.split('@');
    logger.log(`Sign-in code for ${name.slice(0, 2)}***@${domain}: ${code}`, 'DevMail');
  }
}

export const CODE_MAILER = Symbol('CODE_MAILER');

export function codeMailerFactory(): CodeMailer {
  const provider = process.env.EMAIL_PROVIDER ?? 'dev';
  if (provider === 'dev') return new DevCodeMailer();
  throw new Error(`Email provider "${provider}" is not set up. Use EMAIL_PROVIDER=dev locally, or AUTH_PROVIDER=supabase.`);
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254 && !!config;
