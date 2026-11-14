import { CanActivate, Controller, ExecutionContext, Get, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DbService } from '../db/db.service';
import { Public } from '../auth/guards';
import { AppError } from '../common/errors';

interface Maintenance { on: boolean; message: string; blockWrites: boolean }
let cache: { at: number; value: Maintenance } | null = null;

async function current(db: DbService): Promise<Maintenance> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const r = await db.one<{ value: Maintenance }>(`SELECT value FROM platform_settings WHERE key = 'maintenance'`).catch(() => null);
  const value = { on: !!r?.value?.on, message: String(r?.value?.message ?? ''), blockWrites: !!r?.value?.blockWrites };
  cache = { at: Date.now(), value };
  return value;
}
export const resetMaintenanceCache = () => (cache = null);

/**
 * Maintenance mode (Admin → Settings): owners see the message as a banner; with
 * "pause changes" on, only reads go through for businesses (admin, sign-in and
 * payment webhooks keep working).
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(private readonly db: DbService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (req.method === 'GET' || req.method === 'OPTIONS' || /^\/(admin|admin-auth|auth|webhooks|status)\b/.test(req.path)) return true;
    const m = await current(this.db);
    if (m.on && m.blockWrites) throw new AppError(503, 'maintenance', m.message || 'Orbit is being updated. Please try again in a few minutes.');
    return true;
  }
}

@Controller('status')
export class StatusController {
  constructor(private readonly db: DbService) {}

  @Public()
  @Get()
  async status() {
    const m = await current(this.db);
    return { maintenance: m.on ? { message: m.message, blockWrites: m.blockWrites } : null };
  }
}
