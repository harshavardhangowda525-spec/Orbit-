import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentTenant, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { BridgeService } from './bridge.service';

const Decide = z.object({ option: z.string().min(1).max(40) });
const Command = z.object({ text: z.string().trim().min(1).max(1000) });

@UseGuards(TenantGuard)
@Controller('bridge')
export class BridgeController {
  constructor(private readonly bridge: BridgeService) {}

  @Get()
  home(@CurrentTenant() t: Tenant) {
    return this.bridge.home(t.businessId, new Date(), undefined, t.userId);
  }

  @Roles('owner', 'manager')
  @Post('cards/:id/decide')
  decide(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Decide)) body: z.infer<typeof Decide>) {
    return this.bridge.decideCard(t.businessId, t.userId, id, body.option);
  }

  @Roles('owner', 'manager')
  @Post('commands')
  command(@CurrentTenant() t: Tenant, @Body(new ZodPipe(Command)) body: z.infer<typeof Command>) {
    return this.bridge.command(t.businessId, t.userId, body.text);
  }
}
