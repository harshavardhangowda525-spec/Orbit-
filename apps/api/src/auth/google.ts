import { Injectable } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config';
import { badRequest } from '../common/errors';

export interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string;
}

export const GOOGLE_VERIFIER = Symbol('GOOGLE_VERIFIER');

export interface GoogleVerifier {
  verify(idToken: string): Promise<GoogleIdentity>;
}

@Injectable()
export class GoogleIdTokenVerifier implements GoogleVerifier {
  private client = new OAuth2Client();
  async verify(idToken: string): Promise<GoogleIdentity> {
    if (!config.googleClientId) throw badRequest('google_not_configured', 'Google sign-in is not set up yet. Please use your phone number.');
    const ticket = await this.client.verifyIdToken({ idToken, audience: config.googleClientId }).catch(() => null);
    const p = ticket?.getPayload();
    if (!p?.sub || !p.email || !p.email_verified) throw badRequest('google_invalid', 'We could not confirm your Google account. Please try again.');
    return { sub: p.sub, email: p.email, name: p.name };
  }
}
