import { Injectable } from '@nestjs/common';
import QRCode from 'qrcode';
import {
  AGENTS,
  AGENT_KEYS,
  RESERVED_SLUGS,
  slugify,
  toE164,
  type BusinessTemplate,
  type BusinessType,
  type PlanFeatures,
  type WeeklyHours,
} from '@orbit/shared';
import { randomBytes } from 'node:crypto';
import { config } from '../config';
import { DbService, Tx } from '../db/db.service';
import { TemplatesService } from '../templates/templates.service';
import { AuditService } from '../audit/audit.service';
import { badRequest, notFound } from '../common/errors';
import { postFeed } from '../common/feed';

/** Onboarding steps (spec section 3). Step 1 (sign-in) happens before a business exists. */
export const STEP = { TYPE: 2, IMPORT: 3, ESSENTIALS: 4, CALENDAR: 5, LIVE: 6, DONE: 7 } as const;

export interface EssentialsInput {
  name: string;
  phone?: string | null;
  address?: string | null;
  description?: string | null;
  hours: WeeklyHours;
  services: { id?: string; name: string; durationMin: number; price: number | null }[];
  staff: { id?: string; name: string }[];
  final?: boolean;
}

@Injectable()
export class OnboardingService {
  constructor(private readonly db: DbService, private readonly templates: TemplatesService, private readonly audit: AuditService) {}

  /** Step 2: create the business from its type template. */
  async createBusiness(userId: string, type: BusinessType, language: string, timezone = 'Asia/Kolkata') {
    const template = await this.templates.get(type);
    return this.db.tx(async (tx) => {
      const plan = await tx.one<{ id: string; features: PlanFeatures }>(`SELECT id, features FROM plans WHERE code = 'free'`);
      if (!plan) throw new Error('Plans are not seeded. Run npm run db:migrate.');
      const slug = await uniqueSlug(tx, template.defaultName);
      timezone = await validTimezone(tx, timezone);
      const biz = await tx.one(
        `INSERT INTO businesses (name, slug, type, timezone, default_language, supported_languages, plan_id, onboarding_step, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [template.defaultName, slug, type, timezone, language, unique(['en', language]), plan.id, STEP.IMPORT, userId],
      );
      await tx.q(`INSERT INTO memberships (user_id, business_id, role) VALUES ($1, $2, 'owner')`, [userId, biz.id]);
      // From here on, this transaction acts for the new business only.
      await tx.q(`SELECT set_config('app.business_id', $1, true)`, [biz.id]);
      await applyTemplate(tx, template, plan.features, userId);
      await postFeed(tx, 'orbit', 'business_created', { key: 'feed.orbit.setup_started' });
      return biz;
    });
  }

  /** Re-apply a different type template while still onboarding (owner tapped "back" and changed type). */
  async changeType(businessId: string, userId: string, type: BusinessType) {
    const template = await this.templates.get(type);
    return this.db.withTenant(businessId, async (tx) => {
      const biz = await tx.one(`SELECT b.*, p.features FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.id = $1`, [businessId]);
      if (!biz) throw notFound();
      if (biz.status !== 'onboarding') throw badRequest('already_live', 'Your Orbit is already live. Change services from Details instead.');
      if (biz.type === type) return biz;
      for (const t of ['services', 'knowledge_items', 'sequences', 'agents', 'business_profiles']) await tx.q(`DELETE FROM ${t}`);
      await applyTemplate(tx, template, biz.features, userId);
      const nameIsPlaceholder = (await this.templates.get(biz.type)).defaultName === biz.name;
      return tx.one(`UPDATE businesses SET type = $2, name = CASE WHEN $3 THEN $4 ELSE name END WHERE id = $1 RETURNING *`, [businessId, type, nameIsPlaceholder, template.defaultName]);
    }, userId);
  }

  async state(businessId: string) {
    return this.db.withTenant(businessId, async (tx) => {
      const business = await tx.one(`SELECT * FROM businesses WHERE id = $1`, [businessId]);
      if (!business) throw notFound();
      const profile = await tx.one(`SELECT * FROM business_profiles LIMIT 1`);
      const services = await tx.q(
        `SELECT id, name, duration_min AS "durationMin", price::float AS price, category FROM services WHERE deleted_at IS NULL AND active ORDER BY sort_order, created_at`,
      );
      const staff = await tx.q(`SELECT id, name FROM staff WHERE deleted_at IS NULL ORDER BY created_at`);
      const powers = await tx.q(`SELECT power_type, status FROM power_connections WHERE status <> 'disconnected'`);
      return {
        business: publicBusiness(business),
        profile: profile && {
          phone: profile.phone,
          address: profile.address,
          description: profile.description,
          hours: profile.hours,
          photos: profile.photos,
          socialLinks: profile.social_links,
          website: profile.website,
          import_source: profile.import_source,
        },
        services,
        staff,
        powers,
        links: business.status === 'onboarding' ? null : await links(business.slug),
        checklist: business.status === 'onboarding' ? null : await checklist(tx),
      };
    });
  }

  /** Step 3: owner confirmed or skipped import. Imported fields are reviewed on the essentials screen. */
  async saveImport(businessId: string, userId: string, fields: Record<string, unknown> | null) {
    return this.db.withTenant(businessId, async (tx) => {
      if (fields) {
        await tx.q(
          `UPDATE business_profiles SET import_source = $1,
             website = COALESCE($2, website),
             social_links = social_links || $3::jsonb,
             photos = CASE WHEN $4::jsonb = '[]'::jsonb THEN photos ELSE $4::jsonb END`,
          [
            JSON.stringify(fields),
            (fields.website as string) ?? null,
            JSON.stringify(fields.instagram ? { instagram: fields.instagram } : {}),
            JSON.stringify(Array.isArray(fields.photos) ? fields.photos.slice(0, 6) : []),
          ],
        );
      }
      await advance(tx, businessId, STEP.ESSENTIALS);
      return { ok: true };
    }, userId);
  }

  /** Step 4: business name, services, hours, staff. */
  async saveEssentials(businessId: string, userId: string, input: EssentialsInput) {
    return this.db.withTenant(businessId, async (tx) => {
      const biz = await tx.one(`SELECT * FROM businesses WHERE id = $1`, [businessId]);
      if (!biz) throw notFound();
      let phone: string | null = null;
      if (input.phone) {
        phone = toE164(input.phone, biz.country);
        if (!phone) throw badRequest('invalid_phone', 'The business phone number does not look right. Please check it.');
      }
      const name = input.name.trim();
      // Keep the public link in step with the name until the business goes live.
      const slug = biz.status === 'onboarding' && slugify(name) !== biz.slug ? await uniqueSlug(tx, name, biz.id) : biz.slug;
      await tx.q(`UPDATE businesses SET name = $2, slug = $3 WHERE id = $1`, [businessId, name, slug]);
      await tx.q(
        `UPDATE business_profiles SET phone = $1, whatsapp = COALESCE(whatsapp, $1), address = $2, description = $3, hours = $4`,
        [phone, input.address?.trim() || null, input.description?.trim() || null, JSON.stringify(input.hours)],
      );

      // Services: update kept ones, add new ones, retire removed ones (soft delete).
      const keepIds = input.services.map((s) => s.id).filter(Boolean) as string[];
      await tx.q(`UPDATE services SET deleted_at = now(), active = false WHERE deleted_at IS NULL AND NOT (id = ANY($1::uuid[]))`, [keepIds]);
      for (const [i, s] of input.services.entries()) {
        if (s.id) {
          const r = await tx.q(`UPDATE services SET name = $2, duration_min = $3, price = $4, sort_order = $5 WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [s.id, s.name.trim(), s.durationMin, s.price, i]);
          if (r.length === 0) throw badRequest('invalid_service', 'One of the services could not be found. Please refresh and try again.');
        } else {
          await tx.q(`INSERT INTO services (name, duration_min, price, sort_order, created_by) VALUES ($1, $2, $3, $4, $5)`, [s.name.trim(), s.durationMin, s.price, i, userId]);
        }
      }

      const keepStaff = input.staff.map((s) => s.id).filter(Boolean) as string[];
      await tx.q(`UPDATE staff SET deleted_at = now(), active = false WHERE deleted_at IS NULL AND NOT (id = ANY($1::uuid[]))`, [keepStaff]);
      for (const s of input.staff) {
        if (s.id) await tx.q(`UPDATE staff SET name = $2 WHERE id = $1`, [s.id, s.name.trim()]);
        else await tx.q(`INSERT INTO staff (name, created_by) VALUES ($1, $2)`, [s.name.trim(), userId]);
      }
      if (input.final !== false) await advance(tx, businessId, STEP.CALENDAR);
      return { ok: true, slug };
    }, userId);
  }

  /** Step 5: built-in calendar, or start connecting Google Calendar (finished from Powers via OAuth). */
  async setCalendar(businessId: string, userId: string, mode: 'builtin' | 'google') {
    return this.db.withTenant(businessId, async (tx) => {
      await tx.q(`UPDATE businesses SET calendar_mode = $2 WHERE id = $1`, [businessId, mode]);
      if (mode === 'google') {
        const existing = await tx.one(`SELECT id FROM power_connections WHERE power_type = 'google_calendar' AND status <> 'disconnected'`);
        if (!existing) {
          await tx.q(
            `INSERT INTO power_connections (power_type, status, status_detail, scopes, connected_by)
             VALUES ('google_calendar', 'pending', 'oauth_not_configured', ARRAY['calendar.events'], $1)`,
            [userId],
          );
        }
      }
      await advance(tx, businessId, STEP.LIVE);
      return { ok: true, calendarMode: mode };
    }, userId);
  }

  /** Step 6: go live. */
  async launch(businessId: string, userId: string) {
    const biz = await this.db.withTenant(businessId, async (tx) => {
      const b = await tx.one(`SELECT * FROM businesses WHERE id = $1`, [businessId]);
      if (!b) throw notFound();
      const n = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM services WHERE deleted_at IS NULL AND active`);
      if (!n?.n) throw badRequest('no_services', 'Please add at least one service before going live.');
      if (b.status !== 'onboarding') return b;
      const live = await tx.one(`UPDATE businesses SET status = 'live', launched_at = now(), onboarding_step = $2 WHERE id = $1 RETURNING *`, [businessId, STEP.DONE]);
      await postFeed(tx, 'orbit', 'business_live', { key: 'feed.orbit.live', params: { business: live.name } });
      return live;
    }, userId);
    await this.audit.write({ businessId, actorId: userId, action: 'business.launch', entity: 'business', entityId: businessId });
    return { business: publicBusiness(biz), links: await links(biz.slug) };
  }
}

export async function applyTemplate(tx: Tx, t: BusinessTemplate, features: PlanFeatures, userId: string) {
  await tx.q(`INSERT INTO business_profiles (hours, created_by) VALUES ($1, $2)`, [JSON.stringify(t.hours), userId]);
  for (const [i, s] of t.services.entries()) {
    await tx.q(
      `INSERT INTO services (name, description, duration_min, price, buffer_before_min, buffer_after_min, category, renewal_interval_days, deposit_required, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [s.name, s.description ?? null, s.durationMin, s.price, s.bufferBeforeMin ?? 0, s.bufferAfterMin ?? 0, s.category ?? null, s.renewalIntervalDays ?? null, s.depositRequired ?? false, i, userId],
    );
  }
  for (const f of t.faqs) {
    await tx.q(`INSERT INTO knowledge_items (type, title, content, source, created_by) VALUES ('faq', $1, $2, 'template', $3)`, [f.question, f.answer, userId]);
  }
  for (const s of t.sequences) {
    await tx.q(`INSERT INTO sequences (name, trigger, steps, owner_agent, created_by) VALUES ($1, $2, $3, $4, $5)`, [s.name, s.trigger, JSON.stringify(s.steps), s.ownerAgent, userId]);
  }
  for (const key of AGENT_KEYS) {
    const enabled = (t.agentSettings[key]?.enabled ?? key === 'orbit') && features.agents.includes(key);
    await tx.q(`INSERT INTO agents (agent_key, display_name, personality, enabled, created_by) VALUES ($1, $2, $3, $4, $5)`, [key, AGENTS[key].displayName, AGENTS[key].personality, enabled, userId]);
  }
}

async function advance(tx: Tx, businessId: string, step: number) {
  await tx.q(`UPDATE businesses SET onboarding_step = GREATEST(onboarding_step, $2) WHERE id = $1 AND status = 'onboarding'`, [businessId, step]);
}

async function uniqueSlug(tx: Tx, name: string, exceptId?: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 && !RESERVED_SLUGS.has(base) ? base : `${base}-${randomBytes(2).toString('hex')}`;
    const taken = await tx.one(`SELECT 1 FROM businesses WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2)`, [candidate, exceptId ?? null]);
    if (!taken) return candidate;
  }
  return `${base}-${randomBytes(4).toString('hex')}`;
}

const unique = <T>(a: T[]) => [...new Set(a)];

/** Old IANA names some phones and browsers still report. */
const TZ_ALIASES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'Europe/Kiev': 'Europe/Kyiv',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
};

/** Use a timezone the database knows; fall back to India time. */
export async function validTimezone(tx: Tx, tz: string): Promise<string> {
  for (const candidate of [tz, TZ_ALIASES[tz], 'Asia/Kolkata']) {
    if (!candidate) continue;
    if (await tx.one(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [candidate])) return candidate;
  }
  return 'UTC';
}

export function publicBusiness(b: any) {
  return {
    id: b.id,
    name: b.name,
    slug: b.slug,
    type: b.type,
    status: b.status,
    onboardingStep: b.onboarding_step,
    timezone: b.timezone,
    currency: b.currency,
    country: b.country,
    defaultLanguage: b.default_language,
    supportedLanguages: b.supported_languages,
    calendarMode: b.calendar_mode,
  };
}

export async function links(slug: string) {
  const publicUrl = `${config.publicBaseUrl}/${slug}`;
  return {
    publicUrl,
    qrSvg: await QRCode.toString(publicUrl, { type: 'svg', margin: 1, width: 240 }),
    widgetCode: `<script src="${config.publicBaseUrl}/widget.js" data-orbit="${slug}" async></script>`,
    testChatUrl: `${publicUrl}?chat=1`,
  };
}

/** Optional upgrades shown after launch. */
async function checklist(tx: Tx) {
  const powers = new Set((await tx.q<{ power_type: string }>(`SELECT power_type FROM power_connections WHERE status = 'connected'`)).map((r) => r.power_type));
  const faqs = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM knowledge_items WHERE type = 'faq' AND source <> 'template' AND deleted_at IS NULL`);
  const priceList = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM knowledge_items WHERE type = 'price_list' AND deleted_at IS NULL`);
  const staffUsers = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM memberships WHERE business_id = app_current_business() AND role <> 'owner'`);
  return [
    { key: 'whatsapp', done: powers.has('whatsapp') },
    { key: 'instagram', done: powers.has('instagram') },
    { key: 'gmail', done: powers.has('gmail') },
    { key: 'voice', done: powers.has('phone') },
    { key: 'payments', done: ['razorpay', 'cashfree', 'phonepe', 'paytm', 'stripe'].some((p) => powers.has(p)) },
    { key: 'faqs', done: (faqs?.n ?? 0) > 0 },
    { key: 'price_list', done: (priceList?.n ?? 0) > 0 },
    { key: 'invite_staff', done: (staffUsers?.n ?? 0) > 0 },
    { key: 'meet_crew', done: false },
  ];
}
