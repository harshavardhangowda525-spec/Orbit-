import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { config } from '../config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CODE_MAILER, codeMailerFactory } from './mailer';
import { GOOGLE_VERIFIER, GoogleIdTokenVerifier } from './google';
import { AdminGuard, JwtAuthGuard, TenantGuard } from './guards';
import { SupabaseVerifier } from './supabase';

@Global()
@Module({
  imports: [JwtModule.register({ global: true, secret: config.jwtSecret, signOptions: { issuer: 'orbit' }, verifyOptions: { issuer: 'orbit' } })],
  controllers: [AuthController],
  providers: [
    AuthService,
    TenantGuard,
    AdminGuard,
    JwtAuthGuard,
    SupabaseVerifier,
    { provide: CODE_MAILER, useFactory: codeMailerFactory },
    { provide: GOOGLE_VERIFIER, useClass: GoogleIdTokenVerifier },
  ],
  exports: [AuthService, TenantGuard, AdminGuard, JwtAuthGuard, SupabaseVerifier],
})
export class AuthModule {}
