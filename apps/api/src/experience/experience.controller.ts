import { Body, Controller, Get, Global, Module, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { ZodPipe } from '../common/zod.pipe';
import { ExperienceService } from './experience.service';

const TickBody = z.object({ item: z.string().min(2).max(40) });

@UseGuards(TenantGuard)
@Controller('experience')
export class ExperienceController {
  constructor(private readonly exp: ExperienceService) {}

  @Get()
  get(@CurrentTenant() t: Tenant) {
    return this.exp.get(t.businessId);
  }

  @Roles('owner', 'manager')
  @Patch('appearance')
  updateAppearance(@CurrentTenant() t: Tenant, @Body() body: unknown) {
    return this.exp.updateAppearance(t.businessId, t.userId, body);
  }

  @Post('plan-change/:id/seen')
  seenPlanChange(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.exp.markPlanChangeSeen(t.businessId, id);
  }

  @Post('plan-change/:id/tick')
  tickChecklist(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(TickBody)) body: z.infer<typeof TickBody>) {
    return this.exp.tickChecklist(t.businessId, id, body.item);
  }

  @Post('milestones/:id/seen')
  seenMilestone(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.exp.markMilestoneSeen(t.businessId, id);
  }

  @Get('report')
  report(@CurrentTenant() t: Tenant, @Query('month') month?: string) {
    return this.exp.monthlyReport(t.businessId, month);
  }

  @Get('preview/:feature')
  preview(@CurrentTenant() t: Tenant, @Param('feature') feature: string) {
    return this.exp.featurePreview(t.businessId, feature);
  }
}

@Global()
@Module({
  controllers: [ExperienceController],
  providers: [ExperienceService],
  exports: [ExperienceService],
})
export class ExperienceModule {}
