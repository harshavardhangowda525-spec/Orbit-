import { Body, Controller, Get, Global, Module, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { ZodPipe } from '../common/zod.pipe';
import { TeachService } from './teach.service';

const Teach = z.object({ text: z.string().trim().min(2).max(2000), source: z.enum(['app', 'voice', 'knowledge', 'whatsapp']).default('app'), language: z.string().max(5).optional() });
const Confirm = z.object({ choices: z.record(z.string().uuid(), z.enum(['keep', 'message'])).default({}) });

/** Teach Orbit by talking: preview first, save on confirm, undo for 24 hours. */
@UseGuards(TenantGuard)
@Controller('teach')
export class TeachController {
  constructor(private readonly teach: TeachService) {}

  @Post()
  create(@CurrentTenant() t: Tenant, @Body(new ZodPipe(Teach)) b: z.infer<typeof Teach>) {
    return this.teach.teach(t.businessId, t.userId, t.role, b);
  }

  @Get('recent')
  recent(@CurrentTenant() t: Tenant) {
    return this.teach.recent(t.businessId);
  }

  @Get(':id')
  get(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.teach.get(t.businessId, id);
  }

  @Post(':id/confirm')
  confirm(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Confirm)) b: z.infer<typeof Confirm>) {
    return this.teach.confirm(t.businessId, t.userId, t.role, id, b.choices);
  }

  @Post(':id/cancel')
  cancel(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.teach.cancel(t.businessId, t.userId, id);
  }

  @Post(':id/undo')
  undo(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.teach.undo(t.businessId, t.userId, id);
  }
}

@Global()
@Module({ controllers: [TeachController], providers: [TeachService], exports: [TeachService] })
export class TeachModule {}
