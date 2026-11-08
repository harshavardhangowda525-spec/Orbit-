import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { BUSINESS_TYPES, SUPPORTED_LANGUAGE_CODES, WEEKDAYS, isValidWeeklyHours, type WeeklyHours } from '@orbit/shared';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentTenant, CurrentUser, Roles, TenantGuard } from '../auth/guards';
import type { AuthUser, Tenant } from '../auth/types';
import { DbService } from '../db/db.service';
import { badRequest } from '../common/errors';
import { TemplatesService } from '../templates/templates.service';
import { OnboardingService } from './onboarding.service';
import { ImportService } from './import.service';

const TypeBody = z.object({
  type: z.enum(BUSINESS_TYPES),
  language: z.string().refine((l) => SUPPORTED_LANGUAGE_CODES.includes(l)).default('en'),
  timezone: z.string().max(64).optional(),
});
const ChangeType = z.object({ type: z.enum(BUSINESS_TYPES) });
const ImportPreview = z.object({ input: z.string().trim().min(2).max(500) });
const ImportSave = z.object({
  fields: z
    .object({
      website: z.string().url().max(300).optional(),
      instagram: z.string().url().max(300).optional(),
      photos: z.array(z.string().url().max(500)).max(6).optional(),
    })
    .passthrough()
    .nullable(),
});
const hoursSchema = z
  .record(z.enum(WEEKDAYS), z.object({ open: z.boolean(), ranges: z.array(z.object({ from: z.string(), to: z.string() })).max(4) }))
  .refine((h) => isValidWeeklyHours(h), 'opening hours are not valid');
const Essentials = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z.string().max(20).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  description: z.string().max(600).nullable().optional(),
  hours: hoursSchema,
  services: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(80),
        durationMin: z.number().int().min(0).max(1440),
        price: z.number().min(0).max(10_000_000).nullable(),
      }),
    )
    .min(1)
    .max(60),
  staff: z.array(z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(60) })).max(50).default([]),
  /** false = autosave of a sub-screen; true = owner finished this step. */
  final: z.boolean().default(true),
});
const Calendar = z.object({ mode: z.enum(['builtin', 'google']) });

@Controller('onboarding')
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly importer: ImportService,
    private readonly templates: TemplatesService,
    private readonly db: DbService,
  ) {}

  @Get('types')
  types() {
    return this.templates.list();
  }

  /** Step 2 for a brand-new owner: creates the business and returns it. */
  @Post('business')
  async create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(TypeBody)) body: z.infer<typeof TypeBody>) {
    if (user.impersonation) throw badRequest('not_allowed', 'This is not available while viewing as a business.');
    const owned = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM memberships WHERE user_id = $1 AND role = 'owner'`, [user.id]);
    if ((owned?.n ?? 0) >= 5) throw badRequest('too_many_businesses', 'You already have 5 businesses. Please contact support to add more.');
    const biz = await this.onboarding.createBusiness(user.id, body.type, body.language, body.timezone);
    return { businessId: biz.id };
  }

  @UseGuards(TenantGuard)
  @Roles('owner')
  @Put('type')
  changeType(@CurrentTenant() t: Tenant, @Body(new ZodPipe(ChangeType)) body: z.infer<typeof ChangeType>) {
    return this.onboarding.changeType(t.businessId, t.userId, body.type).then(() => ({ ok: true }));
  }

  @UseGuards(TenantGuard)
  @Get('state')
  state(@CurrentTenant() t: Tenant) {
    return this.onboarding.state(t.businessId);
  }

  @UseGuards(TenantGuard)
  @Roles('owner', 'manager')
  @Post('import/preview')
  preview(@Body(new ZodPipe(ImportPreview)) body: z.infer<typeof ImportPreview>) {
    return this.importer.run(body.input);
  }

  @UseGuards(TenantGuard)
  @Roles('owner', 'manager')
  @Put('import')
  saveImport(@CurrentTenant() t: Tenant, @Body(new ZodPipe(ImportSave)) body: z.infer<typeof ImportSave>) {
    return this.onboarding.saveImport(t.businessId, t.userId, body.fields);
  }

  @UseGuards(TenantGuard)
  @Roles('owner', 'manager')
  @Put('essentials')
  essentials(@CurrentTenant() t: Tenant, @Body(new ZodPipe(Essentials)) body: z.infer<typeof Essentials>) {
    return this.onboarding.saveEssentials(t.businessId, t.userId, { ...body, hours: body.hours as WeeklyHours });
  }

  @UseGuards(TenantGuard)
  @Roles('owner', 'manager')
  @Put('calendar')
  calendar(@CurrentTenant() t: Tenant, @Body(new ZodPipe(Calendar)) body: z.infer<typeof Calendar>) {
    return this.onboarding.setCalendar(t.businessId, t.userId, body.mode);
  }

  @UseGuards(TenantGuard)
  @Roles('owner')
  @Post('launch')
  launch(@CurrentTenant() t: Tenant) {
    return this.onboarding.launch(t.businessId, t.userId);
  }
}
