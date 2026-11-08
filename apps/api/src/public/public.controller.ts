import { Controller, Get, Module, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { isOpenAt, type PlanFeatures } from '@orbit/shared';
import { DbService } from '../db/db.service';
import { notFound } from '../common/errors';
import { Public } from '../auth/guards';

/** Customer-facing public business page data. Rate limited; exposes only what is meant to be public. */
@Controller('public')
export class PublicController {
  constructor(private readonly db: DbService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('businesses/:slug')
  async business(@Param('slug') slug: string) {
    if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw notFound();
    const b = await this.db.one<{ id: string; name: string; type: string; timezone: string; currency: string; default_language: string; supported_languages: string[]; status: string; features: PlanFeatures }>(
      `SELECT b.id, b.name, b.type, b.timezone, b.currency, b.default_language, b.supported_languages, b.status, p.features
       FROM businesses b JOIN plans p ON p.id = b.plan_id WHERE b.slug = $1 AND b.status IN ('live', 'paused', 'onboarding')`,
      [slug],
    );
    if (!b) throw notFound('We could not find this business.');
    return this.db.withTenant(b.id, async (tx) => {
      const p = await tx.one(`SELECT address, city, phone, whatsapp, hours, description, photos, social_links, geo_lat, geo_lng FROM business_profiles LIMIT 1`);
      const services = await tx.q(
        `SELECT id, name, description, duration_min AS "durationMin", price::float AS price, category
         FROM services WHERE active AND deleted_at IS NULL ORDER BY sort_order, created_at`,
      );
      const rating = await tx.one(`SELECT round(avg(rating)::numeric, 1)::float AS avg, count(*)::int AS count FROM reviews WHERE rating IS NOT NULL`);
      const reviews = await tx.q(`SELECT author, rating, text FROM reviews WHERE rating >= 4 AND text IS NOT NULL ORDER BY posted_at DESC NULLS LAST LIMIT 3`);
      return {
        slug,
        name: b.name,
        type: b.type,
        currency: b.currency,
        timezone: b.timezone,
        languages: b.supported_languages,
        defaultLanguage: b.default_language,
        live: b.status === 'live',
        openNow: p?.hours ? isOpenAt(p.hours, new Date(), b.timezone) : false,
        profile: p ?? null,
        services,
        rating: rating?.count ? rating : null,
        reviews,
        poweredByOrbit: b.features.orbitBranding,
      };
    });
  }
}

@Module({ controllers: [PublicController] })
export class PublicModule {}
