import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { SUPPORTED_LANGUAGE_CODES } from '@orbit/shared';
import { AssistantService, type AssistantEvent } from '../ai/assistant.service';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentTenant, Roles, TenantGuard } from '../auth/guards';
import type { Tenant } from '../auth/types';
import { BridgeService } from './bridge.service';

const Decide = z.object({ option: z.string().min(1).max(40) });
const Command = z.object({
  text: z.string().trim().min(1).max(1000),
  history: z.array(z.object({ role: z.enum(['owner', 'orbit']), text: z.string().max(4000) })).max(20).default([]),
  language: z.string().refine((l) => SUPPORTED_LANGUAGE_CODES.includes(l)).default('en'),
});

@UseGuards(TenantGuard)
@Controller('bridge')
export class BridgeController {
  constructor(
    private readonly bridge: BridgeService,
    private readonly assistant: AssistantService,
  ) {}

  @Get()
  home(@CurrentTenant() t: Tenant) {
    return this.bridge.home(t.businessId, new Date(), undefined, t.userId);
  }

  @Roles('owner', 'manager')
  @Post('cards/:id/decide')
  decide(@CurrentTenant() t: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Decide)) body: z.infer<typeof Decide>) {
    return this.bridge.decideCard(t.businessId, t.userId, id, body.option);
  }

  /**
   * Ask Orbit. With "Accept: application/x-ndjson" each step streams as it happens
   * (one JSON object per line), so the owner watches Orbit work; otherwise one JSON reply.
   * The work finishes even if the owner closes the page.
   */
  @Roles('owner', 'manager')
  @Post('commands')
  async command(@CurrentTenant() t: Tenant, @Body(new ZodPipe(Command)) body: z.infer<typeof Command>, @Headers('accept') accept: string | undefined, @Res() res: Response) {
    if ((accept ?? '').includes('application/x-ndjson')) {
      res.status(201);
      res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders();
      const send = (e: AssistantEvent) => {
        if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`);
      };
      await this.assistant.run(t.businessId, t.userId, body, send);
      res.end();
      return;
    }
    const events: AssistantEvent[] = [];
    await this.assistant.run(t.businessId, t.userId, body, (e) => events.push(e));
    const done = events.find((e) => e.type === 'reply' || e.type === 'error');
    res.status(201).json({
      reply: done?.type === 'reply' ? done.text : null,
      error: done?.type === 'error' ? done.message : null,
      taskId: done?.type === 'reply' ? done.taskId : null,
      steps: events.filter((e) => e.type === 'step').map((e: any) => e.label),
      actions: events.filter((e) => e.type === 'open'),
    });
  }
}
