import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DbModule } from './db/db.module';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard, Public } from './auth/guards';
import { TemplatesModule } from './templates/templates.service';
import { OnboardingModule } from './onboarding/onboarding.module';
import { BridgeModule } from './bridge/bridge.module';
import { PublicModule } from './public/public.controller';
import { RecordsModule } from './records/records.controller';
import { AdminModule } from './admin/admin.controller';

@Controller()
class HealthController {
  @Public()
  @Get('health')
  health() {
    return { ok: true };
  }
}

@Module({
  imports: [
    ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }], skipIf: () => process.env.THROTTLE_DISABLED === 'true' }),
    DbModule,
    AuditModule,
    AuthModule,
    TemplatesModule,
    OnboardingModule,
    BridgeModule,
    PublicModule,
    RecordsModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
