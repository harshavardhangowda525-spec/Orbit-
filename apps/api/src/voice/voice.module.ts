import { Body, Controller, Get, Module, Post, UseGuards } from '@nestjs/common';
import { CurrentTenant, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { BookingsModule } from '../bookings/bookings.module';
import { VoiceService } from './voice.service';

@UseGuards(TenantGuard)
@Controller('voice')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Roles('owner', 'manager')
  @Get()
  status(@CurrentTenant() t: Tenant) {
    return this.voice.status(t);
  }

  @Roles('owner', 'manager')
  @Post('exotel/connect')
  connect(@CurrentTenant() t: Tenant, @Body() body: unknown) {
    return this.voice.connectExotel(t, body);
  }

  @Roles('owner', 'manager')
  @Post('test-call')
  testCall(@CurrentTenant() t: Tenant, @Body() body: { phone?: unknown }) {
    return this.voice.testCall(t, body?.phone);
  }
}

@Module({ imports: [BookingsModule], controllers: [VoiceController], providers: [VoiceService], exports: [VoiceService] })
export class VoiceModule {}
