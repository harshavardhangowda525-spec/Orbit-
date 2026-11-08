import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { config } from '../config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SMS_SENDER, smsSenderFactory } from './sms';
import { GOOGLE_VERIFIER, GoogleIdTokenVerifier } from './google';
import { AdminGuard, TenantGuard } from './guards';

@Global()
@Module({
  imports: [JwtModule.register({ global: true, secret: config.jwtSecret, signOptions: { issuer: 'orbit' }, verifyOptions: { issuer: 'orbit' } })],
  controllers: [AuthController],
  providers: [
    AuthService,
    TenantGuard,
    AdminGuard,
    { provide: SMS_SENDER, useFactory: smsSenderFactory },
    { provide: GOOGLE_VERIFIER, useClass: GoogleIdTokenVerifier },
  ],
  exports: [AuthService, TenantGuard, AdminGuard],
})
export class AuthModule {}
