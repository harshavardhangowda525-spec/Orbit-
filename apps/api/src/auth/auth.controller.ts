import { Body, Controller, Get, Inject, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { SUPPORTED_LANGUAGE_CODES } from '@orbit/shared';
import { ZodPipe } from '../common/zod.pipe';
import { auth } from '../config';
import { notFound } from '../common/errors';

const ownSignInOnly = () => {
  if (auth.provider === 'supabase') throw notFound('Sign-in is handled by the Orbit app.');
};
import { AuthService } from './auth.service';
import { ClientIp, CurrentUser, Public } from './guards';
import type { AuthUser } from './types';

const OtpRequest = z.object({ phone: z.string().min(1).max(20) });
const OtpVerify = z.object({ phone: z.string().min(1).max(20), code: z.string().regex(/^\d{6}$/) });
const GoogleBody = z.object({ idToken: z.string().min(10) });
const MePatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  language: z.string().refine((l) => SUPPORTED_LANGUAGE_CODES.includes(l)).optional(),
});

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('otp/request')
  requestOtp(@Body(new ZodPipe(OtpRequest)) body: z.infer<typeof OtpRequest>) {
    ownSignInOnly();
    return this.auth.requestOtp(body.phone);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('otp/verify')
  verifyOtp(@Body(new ZodPipe(OtpVerify)) body: z.infer<typeof OtpVerify>, @ClientIp() ip: string) {
    ownSignInOnly();
    return this.auth.verifyOtp(body.phone, body.code, ip);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('google')
  google(@Body(new ZodPipe(GoogleBody)) body: z.infer<typeof GoogleBody>, @ClientIp() ip: string) {
    ownSignInOnly();
    return this.auth.signInWithGoogle(body.idToken, ip);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id).then((r) => ({ ...r, impersonation: user.impersonation ?? null }));
  }

  @Patch('me')
  updateMe(@CurrentUser() user: AuthUser, @Body(new ZodPipe(MePatch)) body: z.infer<typeof MePatch>) {
    return this.auth.updateMe(user.id, body);
  }
}
