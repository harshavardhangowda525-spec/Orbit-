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
import { RealtimeModule } from './realtime/realtime.service';
import { JobsModule } from './jobs/jobs.service';
import { ChannelsModule } from './channels/channels.service';
import { BookingsModule } from './bookings/bookings.module';
import { AiModule } from './ai/ai.module';
import { KnowledgeModule } from './knowledge/knowledge.service';
import { BriefingModule } from './briefing/briefing.service';
import { PowersModule } from './powers/powers.service';
import { MetaChannelsModule } from './channels/meta.service';
import { EmailSmsModule } from './channels/email-sms.service';
import { LedgerModule } from './ledger/ledger.service';
import { ZohoModule } from './ledger/zoho.service';

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
    RealtimeModule,
    JobsModule,
    ChannelsModule,
    BookingsModule,
    KnowledgeModule,
    AiModule,
    BriefingModule,
    PowersModule,
    // Before MetaChannelsModule: its /channels/:type/connect would otherwise catch sms/outlook.
    EmailSmsModule,
    MetaChannelsModule,
    LedgerModule,
    ZohoModule,
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
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
  ],
})
export class AppModule {}
